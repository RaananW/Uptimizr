/**
 * Registry ↔ query-route contract (ADR 0051 §1, design sketch §A.3).
 *
 * The metric registry in `@uptimizr/metrics` claims an endpoint and a set of
 * filters for almost every aggregation. This suite proves those claims against
 * the routes the collector actually serves: it registers the real `queryRoutes`
 * plugin on a bare Fastify instance, collects each route's path and Zod
 * querystring through an `onRoute` hook, and compares both directions —
 *
 * - every registry `endpoint.path` exists, and its querystring keys are exactly
 *   the registry's `filters`;
 * - every read route the collector serves has a registry entry, except the few
 *   deliberately-unmetricated ones listed below.
 *
 * No request is ever made, so no store is needed: the plugin is registered with
 * a stub and only its route table is inspected.
 */

import { describe, expect, it, beforeAll } from "vitest";
import Fastify from "fastify";
import { serializerCompiler, validatorCompiler } from "fastify-type-provider-zod";
import { z } from "zod";
import { allMetrics, type MetricDefinition } from "@uptimizr/metrics";
import { queryRoutes } from "../routes/query.js";
import type { CollectorConfig } from "../config.js";
import type { CollectorStore } from "../store.js";

interface RegisteredRoute {
  method: string;
  path: string;
  /** Querystring keys, or `null` when the route declares no querystring schema. */
  querystringKeys: readonly string[] | null;
}

/**
 * Read routes that intentionally have **no** registry entry:
 * - the raw per-session event stream is gated by `ENABLE_RAW_SESSION_RETENTION`
 *   and is explicitly outside the aggregate-only agent surface (ADR 0003 /
 *   ADR 0051 §9);
 * - the scene-representation *listing* is a registry index, not a metric — the
 *   per-scene read (`scene_representation`) is the registered resource;
 * - `whoami` and `audit` describe the **calling key** and its activity, not the
 *   project's telemetry — they aggregate nothing and take no metric filters
 *   (ADR 0051 §5);
 * - the scene-region reads are spatial **vocabulary** (ADR 0051 §2): they return
 *   the named boxes a `region=` filter resolves against, and aggregate nothing.
 */
const ROUTES_WITHOUT_METRICS: readonly string[] = [
  "/api/v1/sessions/:id/events",
  "/api/v1/scene-representations",
  "/api/v1/whoami",
  "/api/v1/audit",
  "/api/v1/scene-regions",
  "/api/v1/scenes/:sceneId/regions",
];

function querystringKeys(schema: unknown): readonly string[] | null {
  const querystring = (schema as { querystring?: unknown } | undefined)?.querystring;
  if (querystring == null) return null;
  if (!(querystring instanceof z.ZodObject)) {
    throw new Error("query route querystring is not a ZodObject");
  }
  return Object.keys(querystring.shape);
}

/** Boot the query plugin in-process and capture its route table. */
async function collectRoutes(): Promise<RegisteredRoute[]> {
  const routes: RegisteredRoute[] = [];
  const app = Fastify();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  app.addHook("onRoute", (routeOptions) => {
    const methods = Array.isArray(routeOptions.method)
      ? routeOptions.method
      : [routeOptions.method];
    for (const method of methods) {
      routes.push({
        method,
        path: routeOptions.url,
        querystringKeys: querystringKeys(routeOptions.schema),
      });
    }
  });
  await app.register(queryRoutes, {
    store: {} as CollectorStore,
    config: {} as CollectorConfig,
  });
  await app.ready();
  await app.close();
  return routes;
}

describe("metric registry ↔ collector query routes", () => {
  let routes: RegisteredRoute[];
  let getRoutes: Map<string, RegisteredRoute>;
  const metricsWithEndpoint: MetricDefinition[] = allMetrics().filter((m) => m.endpoint != null);

  beforeAll(async () => {
    routes = await collectRoutes();
    getRoutes = new Map(routes.filter((r) => r.method === "GET").map((r) => [r.path, r]));
  });

  it("registers a route for every registry endpoint", () => {
    const missing = metricsWithEndpoint
      .filter((metric) => !getRoutes.has(metric.endpoint!.path))
      .map((metric) => `${metric.id} -> ${metric.endpoint!.path}`);
    expect(missing, `registry endpoints with no collector route: ${missing.join(", ")}`).toEqual(
      [],
    );
  });

  it("has a registry entry for every read route it serves", () => {
    const claimed = new Set(metricsWithEndpoint.map((metric) => metric.endpoint!.path));
    const unclaimed = [...getRoutes.keys()]
      .filter((path) => !claimed.has(path) && !ROUTES_WITHOUT_METRICS.includes(path))
      .sort();
    expect(unclaimed, `query routes with no registry metric: ${unclaimed.join(", ")}`).toEqual([]);
  });

  it("serves every registry endpoint over GET only", () => {
    for (const metric of metricsWithEndpoint) {
      expect(metric.endpoint!.method, `${metric.id}`).toBe("GET");
    }
  });

  for (const metric of allMetrics().filter((m) => m.endpoint != null)) {
    it(`filters match the querystring of ${metric.id}`, async () => {
      const route = getRoutes.get(metric.endpoint!.path);
      expect(route, `no route for ${metric.endpoint!.path}`).toBeDefined();
      const actual = [...(route!.querystringKeys ?? [])].sort();
      const declared = [...metric.filters].sort();
      expect(actual, `${metric.id} (${metric.endpoint!.path})`).toEqual(declared);
    });
  }

  it("declares one pathParam per `:` segment of each endpoint", () => {
    for (const metric of metricsWithEndpoint) {
      const segments = metric.endpoint!.path.split("/").filter((s) => s.startsWith(":"));
      const declared = metric.endpoint!.pathParams ?? [];
      expect(declared.length, `${metric.id} (${metric.endpoint!.path})`).toBe(segments.length);
    }
  });
});
