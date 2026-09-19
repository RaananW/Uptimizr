/**
 * `GET /api/v1/openapi.json` — the generated OpenAPI 3.1 document (issue #297,
 * ADR 0051 §1, design sketch §A.2).
 *
 * The document is not hand-written, so these tests check the *generation*: that
 * it is a valid OpenAPI 3.1 document (verified against the official OpenAPI JSON
 * Schema by `@seriousme/openapi-schema-validator`), that every registry endpoint
 * appears exactly once, that each operation's parameter set is exactly the
 * registry's `filters` plus its path params, and that the semantics OpenAPI has
 * no vocabulary for reach the client as `x-uptimizr-*` extensions.
 */

import { Validator } from "@seriousme/openapi-schema-validator";
import { describe, expect, it, beforeAll } from "vitest";
import { allMetrics, type MetricDefinition } from "@uptimizr/metrics";
import { buildApp } from "../app.js";
import type { CollectorConfig } from "../config.js";
import type { CollectorStore } from "../store.js";

const config: CollectorConfig = {
  host: "127.0.0.1",
  port: 0,
  corsOrigins: [],
  visitorHashSecret: "test-secret",
  enableRawSessionRetention: false,
  liveWindowMs: 30_000,
  liveTokenSecret: "test-live-secret",
  liveTokenSecretIsDedicated: true,
  liveTokenTtlMs: 900_000,
  liveMaxConnections: 200,
  livePresenceIntervalMs: 2_000,
  rateLimitMax: 1000,
  rateLimitWindowMs: 60_000,
  ingestRateLimitMax: 1000,
  ingestRateLimitWindowMs: 60_000,
  trustProxy: false,
  bodyLimit: 1_048_576,
  cspMode: "strict",
};

interface Operation {
  operationId: string;
  tags: string[];
  parameters?: { name: string; in: string; required?: boolean; schema?: unknown }[];
  responses: Record<string, unknown>;
  [key: string]: unknown;
}

type Paths = Record<string, Record<string, Operation>>;

/** `/api/v1/sessions/:id/meta` → `/api/v1/sessions/{id}/meta`. */
function toOpenApiPath(path: string): string {
  return path.replace(/:([A-Za-z0-9_]+)/g, "{$1}");
}

describe("GET /api/v1/openapi.json", () => {
  const metrics: MetricDefinition[] = allMetrics().filter((metric) => metric.endpoint != null);
  let status: number;
  let contentType: string | undefined;
  let document: Record<string, unknown>;
  let paths: Paths;

  beforeAll(async () => {
    // No store call is made by this route, so a bare stub is enough.
    const app = await buildApp({ store: {} as CollectorStore, config });
    const response = await app.inject({ method: "GET", url: "/api/v1/openapi.json" });
    status = response.statusCode;
    contentType = response.headers["content-type"] as string | undefined;
    document = response.json() as Record<string, unknown>;
    paths = document.paths as Paths;
    await app.close();
  });

  it("serves the document without an API key", () => {
    expect(status).toBe(200);
    expect(contentType).toContain("application/json");
  });

  it("is a valid OpenAPI 3.1 document", async () => {
    const result = await new Validator().validate(document);
    expect(
      result.valid,
      typeof result.errors === "string" ? result.errors : JSON.stringify(result.errors, null, 2),
    ).toBe(true);
    expect(document.openapi).toBe("3.1.0");
  });

  it("declares the x-api-key security scheme and applies it by default", () => {
    const components = document.components as { securitySchemes: Record<string, unknown> };
    expect(components.securitySchemes.apiKey).toMatchObject({
      type: "apiKey",
      in: "header",
      name: "x-api-key",
    });
    expect(document.security).toEqual([{ apiKey: [] }]);
  });

  it("exempts the documentation and liveness routes from auth", () => {
    expect(paths["/api/v1/openapi.json"]!.get!.security).toEqual([]);
    expect(paths["/health"]!.get!.security).toEqual([]);
  });

  it("lists a GET operation for every registry endpoint", () => {
    const missing = metrics
      .filter((metric) => paths[toOpenApiPath(metric.endpoint!.path)]?.get == null)
      .map((metric) => `${metric.id} -> ${metric.endpoint!.path}`);
    expect(missing, `registry endpoints missing from the document: ${missing.join(", ")}`).toEqual(
      [],
    );
    expect(document["x-uptimizr-metric-count"]).toBe(metrics.length);
  });

  it("names each operation after its metric id, exactly once", () => {
    const ids = Object.values(paths)
      .flatMap((methods) => Object.values(methods))
      .map((operation) => operation.operationId);
    expect(new Set(ids).size).toBe(ids.length);
    for (const metric of metrics) expect(ids).toContain(metric.id);
  });

  it("tags every metric operation with its registry category", () => {
    const declared = new Set((document.tags as { name: string }[]).map((tag) => tag.name));
    for (const metric of metrics) {
      const operation = paths[toOpenApiPath(metric.endpoint!.path)]!.get!;
      expect(operation.tags, metric.id).toEqual([metric.category]);
      expect(declared.has(metric.category), metric.category).toBe(true);
    }
  });

  for (const metric of allMetrics().filter((m) => m.endpoint != null)) {
    it(`declares exactly the registry parameters for ${metric.id}`, () => {
      const operation = paths[toOpenApiPath(metric.endpoint!.path)]!.get!;
      const parameters = operation.parameters ?? [];

      const query = parameters.filter((p) => p.in === "query").map((p) => p.name);
      expect([...query].sort()).toEqual([...metric.filters].sort());

      const pathParams = parameters.filter((p) => p.in === "path");
      const expectedNames = [...metric.endpoint!.path.matchAll(/:([A-Za-z0-9_]+)/g)].map(
        (match) => match[1],
      );
      expect(pathParams.map((p) => p.name)).toEqual(expectedNames);
      for (const parameter of pathParams) expect(parameter.required).toBe(true);
      // Every parameter carries a schema — the same one Fastify validates with.
      for (const parameter of parameters) expect(parameter.schema).toBeDefined();
    });
  }

  it("responds with an array of the metric row schema", () => {
    const topMeshes = paths["/api/v1/meshes/top"]!.get!;
    const response = topMeshes.responses["200"] as {
      content: { "application/json": { schema: Record<string, unknown> } };
    };
    expect(response.content["application/json"].schema).toEqual({
      type: "array",
      items: { $ref: "#/components/schemas/top_meshes" },
    });
    const schemas = (document.components as { schemas: Record<string, Record<string, unknown>> })
      .schemas;
    for (const metric of metrics) expect(schemas[metric.id], metric.id).toBeDefined();
    expect(Object.keys(schemas.top_meshes!.properties as object)).toEqual(
      Object.keys(allMetrics().find((m) => m.id === "top_meshes")!.columns),
    );
  });

  it("responds with a single object (and a 404) for the resource reads", () => {
    for (const id of ["session_meta", "scene_representation"]) {
      const metric = metrics.find((m) => m.id === id)!;
      const operation = paths[toOpenApiPath(metric.endpoint!.path)]!.get!;
      const response = operation.responses["200"] as {
        content: { "application/json": { schema: Record<string, unknown> } };
      };
      expect(response.content["application/json"].schema).toEqual({
        $ref: `#/components/schemas/${id}`,
      });
      expect(operation.responses["404"]).toBeDefined();
    }
  });

  it("documents the effective cellSize the /stats routes echo", () => {
    const schemas = (document.components as { schemas: Record<string, Record<string, unknown>> })
      .schemas;
    for (const id of ["world_heatmap_stats", "gaze_heatmap_stats", "boundary_heatmap_stats"]) {
      const properties = schemas[id]!.properties as Record<string, unknown>;
      expect(Object.keys(properties), id).toEqual(["cellSize", "cells", "hits"]);
      expect(schemas[id]!.required, id).toContain("cellSize");
    }
  });

  it("carries the registry semantics OpenAPI cannot express", () => {
    for (const metric of metrics) {
      const operation = paths[toOpenApiPath(metric.endpoint!.path)]!.get!;
      expect(operation["x-uptimizr-metric"], metric.id).toBe(metric.id);
      expect(operation["x-uptimizr-grain"], metric.id).toBe(metric.grain);
      expect(operation["x-uptimizr-dimensions"], metric.id).toEqual(metric.dimensions);
      expect(operation["x-uptimizr-caveats"], metric.id).toEqual(metric.caveats);
      expect(operation["x-uptimizr-interpretation"], metric.id).toBe(metric.interpretation);
      expect(operation["x-uptimizr-source-channels"], metric.id).toEqual(metric.sourceChannels);
      expect(operation["x-uptimizr-limits"], metric.id).toEqual(metric.limits);
    }
  });

  it("annotates every column with its unit and description", () => {
    const schemas = (document.components as { schemas: Record<string, Record<string, unknown>> })
      .schemas;
    for (const metric of metrics) {
      const properties = schemas[metric.id]!.properties as Record<string, Record<string, unknown>>;
      for (const [name, column] of Object.entries(metric.columns)) {
        expect(properties[name]?.description, `${metric.id}.${name}`).toBe(column.description);
        if (column.unit) {
          expect(properties[name]?.["x-uptimizr-unit"], `${metric.id}.${name}`).toBe(column.unit);
        }
      }
    }
  });

  it("does not describe ingestion, the raw event stream or the live surface", () => {
    expect(Object.keys(paths)).not.toContain("/api/v1/collect");
    expect(Object.keys(paths)).not.toContain("/api/v1/sessions/{id}/events");
    expect(Object.keys(paths).filter((path) => path.startsWith("/api/v1/live"))).toEqual([]);
  });

  it("describes a write only on the metadata paths (#310)", () => {
    // Every other documented operation is a GET, with one read-only exception:
    // the query DSL also accepts `POST /api/v1/query`, because a query is a JSON
    // document rather than a querystring (ADR 0051 §3) — same `query`
    // capability, same aggregations, nothing written. The only genuinely
    // writable surface is the `annotate`-gated metadata group (ADR 0051 §5/§9).
    // Ingestion is deliberately not described at all.
    const written = Object.entries(paths)
      .filter(([, methods]) => Object.keys(methods).some((method) => method !== "get"))
      .map(([path]) => path)
      .sort();
    expect(written).toEqual([
      "/api/v1/analyses",
      "/api/v1/analyses/{id}",
      "/api/v1/annotations",
      "/api/v1/annotations/{id}",
      "/api/v1/glossary/{term}",
      "/api/v1/query",
    ]);
    expect(Object.keys(paths["/api/v1/query"]!).sort()).toEqual(["get", "post"]);
    for (const path of written.filter((candidate) => candidate !== "/api/v1/query")) {
      for (const operation of Object.values(paths[path]!)) {
        expect(operation.tags, path).toEqual(["metadata"]);
      }
    }
  });
});
