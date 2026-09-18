/**
 * Self-description routes (ADR 0051 §1, design sketch §A.2).
 *
 * `GET /api/v1/openapi.json` serves an **OpenAPI 3.1** document for the read
 * API, assembled from two sources that are already the truth:
 *
 * 1. the **metric registry** (`@uptimizr/metrics`) — one path per registered
 *    `endpoint`, the operation's summary/description/tags, the `200` response
 *    schema (the registry `row` converted with `z.toJSONSchema`), per-column
 *    units and descriptions, and the semantics OpenAPI has no vocabulary for
 *    (result grain, group-by dimensions, caveats, capture channels, row caps,
 *    comparison direction) as `x-uptimizr-*` vendor extensions;
 * 2. the **live Fastify route table** — every parameter's JSON Schema is the Zod
 *    querystring/params schema that actually validates the request, captured
 *    through an `onRoute` hook. Nothing about a parameter's *type* is restated
 *    here, so the document cannot drift from the validator; the registry
 *    supplies the parameter's *meaning* (`FILTER_TARGETS`).
 *
 * The document is **not authenticated** — it is documentation, it contains no
 * project data, and a client needs it before it has credentials. It is served
 * under the same global rate limit as every other route (`app.register(rateLimit)`
 * in `app.ts`).
 *
 * Routes that are not registry metrics are described only when they are trivial
 * and honest to describe (`/health`, this route, the scene-representation
 * listing, and the `metadata` group of #310 — annotations, glossary, saved
 * analyses — whose bodies are converted from the Zod contracts that validate
 * them). Ingestion (`POST /api/v1/collect`), the scene-proxy write
 * (`PUT …/representation`), the retention-gated raw event stream and the live
 * SSE surface are deliberately omitted rather than half-described.
 */

import type { FastifyInstance, FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { LIMITS, SCHEMA_VERSION, annotationSchema, savedAnalysisSchema } from "@uptimizr/schema";
import {
  FILTER_TARGETS,
  allMetrics,
  isResourceMetric,
  type FilterId,
  type MetricDefinition,
} from "@uptimizr/metrics";

/** A JSON Schema object, as produced by `z.toJSONSchema`. */
type JsonSchema = Record<string, unknown>;

/** A minimal OpenAPI document shape — enough to build and serve one. */
export type OpenApiDocument = Record<string, unknown>;

/** One route as Fastify registered it, with its Zod schemas (if any). */
export interface RouteSchemaEntry {
  method: string;
  /** Fastify path, `:param` placeholders included. */
  path: string;
  querystring?: z.ZodObject;
  params?: z.ZodObject;
}

export interface MetaRoutesOptions {
  /**
   * The collector's route table, captured by {@link collectRouteSchemas} before
   * the other route plugins were registered.
   */
  routeSchemas: readonly RouteSchemaEntry[];
}

/**
 * `info.version` of the served document: the major version of the HTTP API
 * (`/api/v1`). It is deliberately *not* the npm package version — the document
 * describes the API contract, not the build that serves it. The event wire
 * format is reported separately as `x-uptimizr-schema-version`.
 */
const API_DOCUMENT_VERSION = "1.0.0";

/** Prose for each registry category, used as the OpenAPI tag description. */
const CATEGORY_DESCRIPTIONS: Readonly<Record<string, string>> = {
  sessions: "Session and scene orientation: what traffic arrived, and what to drill into.",
  attention: "Where attention went — pointer, world, gaze and view-direction aggregates.",
  interaction: "What was touched: mesh interactions, dead/rage clicks, hover and input actions.",
  navigation: "How people moved through the scene: coverage, travel, backtracking, distance.",
  performance: "Rendering performance, resource footprint and their spatial distribution.",
  errors: "Stability: runtime errors, engine diagnostics and capability fallbacks.",
  xr: "WebXR immersive sessions: comfort, locomotion, tracking and guardian contacts.",
  ar: "WebXR AR placement: how long it took, how often it was redone, and onto what.",
  conversion: "Funnels, retention and variant leaderboards.",
};

/**
 * The three `/stats` endpoints echo the **effective** voxel `cellSize` next to
 * the registry row, so the caller can label its own grid when the collector
 * derived the resolution from the scene bounds (ADR 0040 §1). The registry `row`
 * describes the aggregation's output (`cells`, `hits`); this records the extra
 * field the route wraps it in, so the document matches the wire.
 */
const RESPONSE_ENVELOPE_EXTRAS: Readonly<Record<string, Readonly<Record<string, JsonSchema>>>> = {
  world_heatmap_stats: {
    cellSize: {
      type: "number",
      exclusiveMinimum: 0,
      description:
        "The voxel edge length actually used, in world units — the requested `cellSize`, or the value derived from the scene/region bounds (ADR 0040 §1).",
      "x-uptimizr-unit": "world-units",
    },
  },
  gaze_heatmap_stats: {
    cellSize: {
      type: "number",
      exclusiveMinimum: 0,
      description:
        "The voxel edge length actually used, in world units — the requested `cellSize`, or the value derived from the scene/region bounds (ADR 0040 §1).",
      "x-uptimizr-unit": "world-units",
    },
  },
  boundary_heatmap_stats: {
    cellSize: {
      type: "number",
      exclusiveMinimum: 0,
      description:
        "The voxel edge length actually used, in world units — the requested `cellSize`, or the value derived from the scene/region bounds (ADR 0040 §1).",
      "x-uptimizr-unit": "world-units",
    },
  },
};

/**
 * Install an `onRoute` hook that records every route registered on `app` (and on
 * any plugin registered into it afterwards) together with its Zod schemas.
 * Returns the array the hook fills in — it is complete once `app.ready()` has
 * resolved, which is always before the first request is served.
 */
export function collectRouteSchemas(app: FastifyInstance): RouteSchemaEntry[] {
  const routes: RouteSchemaEntry[] = [];
  app.addHook("onRoute", (routeOptions) => {
    const schema = routeOptions.schema as { querystring?: unknown; params?: unknown } | undefined;
    const methods = Array.isArray(routeOptions.method)
      ? routeOptions.method
      : [routeOptions.method];
    for (const method of methods) {
      routes.push({
        method,
        path: routeOptions.url,
        querystring: schema?.querystring instanceof z.ZodObject ? schema.querystring : undefined,
        params: schema?.params instanceof z.ZodObject ? schema.params : undefined,
      });
    }
  });
  return routes;
}

/** `/api/v1/sessions/:id/meta` → `/api/v1/sessions/{id}/meta`. */
function toOpenApiPath(fastifyPath: string): string {
  return fastifyPath.replace(/:([A-Za-z0-9_]+)/g, "{$1}");
}

/** The `:param` names of a Fastify path, in order. */
function pathParamNames(fastifyPath: string): string[] {
  return [...fastifyPath.matchAll(/:([A-Za-z0-9_]+)/g)].map((match) => match[1]!);
}

/**
 * Convert a Zod schema to JSON Schema and drop the `$schema` dialect marker —
 * OpenAPI 3.1 declares the dialect once on the document (`jsonSchemaDialect`),
 * so repeating it on every subschema is noise.
 */
function toJsonSchema(schema: z.ZodType, io: "input" | "output"): JsonSchema {
  const json = z.toJSONSchema(schema, { io, unrepresentable: "any" }) as JsonSchema;
  delete json.$schema;
  return json;
}

/** The registry row schema, with each property annotated from `columns`. */
function rowSchema(metric: MetricDefinition): JsonSchema {
  const json = toJsonSchema(metric.row, "output");
  const properties = json.properties as Record<string, JsonSchema> | undefined;
  if (properties) {
    for (const [name, column] of Object.entries(metric.columns)) {
      const property = properties[name];
      if (!property) continue;
      property.description = column.description;
      if (column.unit) property["x-uptimizr-unit"] = column.unit;
      if (column.rateOf) property["x-uptimizr-rate-of"] = column.rateOf;
    }
  }
  const extras = RESPONSE_ENVELOPE_EXTRAS[metric.id];
  if (extras && properties) {
    json.properties = { ...extras, ...properties };
    json.required = [...Object.keys(extras), ...((json.required as string[]) ?? [])];
  }
  json.title = metric.title;
  return json;
}

/** The parameters of one operation: path params first, then the querystring. */
function parametersFor(metric: MetricDefinition, route: RouteSchemaEntry | undefined): unknown[] {
  const parameters: unknown[] = [];
  const names = pathParamNames(metric.endpoint!.path);
  const declared = metric.endpoint!.pathParams ?? [];
  const paramsJson = route?.params ? toJsonSchema(route.params, "input") : undefined;
  const paramsProperties = (paramsJson?.properties ?? {}) as Record<string, JsonSchema>;

  names.forEach((name, index) => {
    const filter = declared[index] as FilterId | undefined;
    parameters.push({
      name,
      in: "path",
      required: true,
      description: filter ? FILTER_TARGETS[filter].description : undefined,
      schema: paramsProperties[name] ?? { type: "string" },
      ...(filter ? { "x-uptimizr-filter": filter } : {}),
    });
  });

  if (route?.querystring) {
    const json = toJsonSchema(route.querystring, "input");
    const properties = (json.properties ?? {}) as Record<string, JsonSchema>;
    const required = new Set((json.required as string[] | undefined) ?? []);
    for (const [name, schema] of Object.entries(properties)) {
      const target = FILTER_TARGETS[name as FilterId] as { description: string } | undefined;
      parameters.push({
        name,
        in: "query",
        required: required.has(name),
        description: target?.description,
        schema,
      });
    }
  }
  return parameters;
}

/** The `x-uptimizr-*` semantics OpenAPI itself has no vocabulary for. */
function vendorExtensions(metric: MetricDefinition): Record<string, unknown> {
  const units: Record<string, string> = {};
  let measure: string | undefined;
  let label: string | undefined;
  for (const [name, column] of Object.entries(metric.columns)) {
    if (column.unit) units[name] = column.unit;
    if (column.measure) measure = name;
    if (column.label) label = name;
  }
  return {
    "x-uptimizr-metric": metric.id,
    "x-uptimizr-grain": metric.grain,
    "x-uptimizr-category": metric.category,
    "x-uptimizr-dimensions": metric.dimensions,
    "x-uptimizr-filters": metric.filters,
    "x-uptimizr-units": units,
    ...(measure ? { "x-uptimizr-measure": measure } : {}),
    ...(label ? { "x-uptimizr-label": label } : {}),
    "x-uptimizr-limits": metric.limits,
    "x-uptimizr-interpretation": metric.interpretation,
    "x-uptimizr-caveats": metric.caveats,
    "x-uptimizr-source-channels": metric.sourceChannels,
    "x-uptimizr-related": metric.related,
    ...(metric.comparable ? { "x-uptimizr-comparable": metric.comparable } : {}),
  };
}

/** The shared error responses every authenticated read can answer with. */
const AUTHENTICATED_ERRORS = {
  "400": { $ref: "#/components/responses/BadRequest" },
  "401": { $ref: "#/components/responses/Unauthorized" },
  "403": { $ref: "#/components/responses/Forbidden" },
  "429": { $ref: "#/components/responses/TooManyRequests" },
} as const;

/** The operation object for one registry metric. */
function operationFor(metric: MetricDefinition, route: RouteSchemaEntry | undefined): unknown {
  // A builder-less **resource** entry is a store read of one object (a session
  // descriptor, a scene proxy), not an aggregation: its body is that object, and
  // it answers 404 when the id is unknown. Every other metric returns rows.
  const single = isResourceMetric(metric);
  const body = single
    ? { $ref: `#/components/schemas/${metric.id}` }
    : { type: "array", items: { $ref: `#/components/schemas/${metric.id}` } };

  return {
    operationId: metric.id,
    summary: metric.title,
    description: `${metric.description}\n\n**How to read it.** ${metric.interpretation}${
      metric.caveats.length > 0
        ? `\n\n**Caveats.**\n${metric.caveats.map((caveat) => `- ${caveat}`).join("\n")}`
        : ""
    }`,
    tags: [metric.category],
    parameters: parametersFor(metric, route),
    responses: {
      "200": {
        description: single
          ? `The ${metric.title.toLowerCase()}.`
          : `${metric.title} rows (one row per ${metric.grain}).`,
        content: { "application/json": { schema: body } },
      },
      ...AUTHENTICATED_ERRORS,
      ...(single ? { "404": { $ref: "#/components/responses/NotFound" } } : {}),
    },
    ...vendorExtensions(metric),
  };
}

/** The handful of non-metric routes that are trivial and honest to describe. */
function staticPaths(): Record<string, unknown> {
  return {
    "/health": {
      get: {
        operationId: "health",
        summary: "Liveness probe",
        description: 'Always answers `{ "status": "ok" }` when the process is serving.',
        tags: ["meta"],
        security: [],
        responses: {
          "200": {
            description: "The collector is up.",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: { status: { type: "string", const: "ok" } },
                  required: ["status"],
                },
              },
            },
          },
        },
      },
    },
    "/api/v1/openapi.json": {
      get: {
        operationId: "openapi",
        summary: "This document",
        description:
          "The OpenAPI 3.1 description of the read API, generated from the semantic metric registry. Unauthenticated: it is documentation and contains no project data.",
        tags: ["meta"],
        security: [],
        responses: {
          "200": {
            description: "The OpenAPI document.",
            content: { "application/json": { schema: { type: "object" } } },
          },
        },
      },
    },
    "/api/v1/scene-representations": {
      get: {
        operationId: "list_scene_representations",
        summary: "Registered scene representations",
        description:
          "Summaries of the scene proxies registered for the project (ADR 0014) — the index behind the per-scene `scene_representation` read. The proxy blob itself is not included.",
        tags: ["meta"],
        parameters: [],
        responses: {
          "200": {
            description: "One summary per registered scene.",
            content: {
              "application/json": {
                schema: {
                  type: "array",
                  items: { $ref: "#/components/schemas/SceneRepresentationSummary" },
                },
              },
            },
          },
          ...AUTHENTICATED_ERRORS,
        },
      },
    },
  };
}

/**
 * The **metadata** paths (#310, ADR 0051 §5): annotations, glossary, saved
 * analyses. They are not registry metrics — they store what people and agents
 * write rather than aggregate what visitors did — so they are described by hand
 * here, next to the other non-metric routes. The two request bodies are
 * converted from the very Zod contracts that validate them, so the document
 * cannot drift from the validator.
 */
function metadataPaths(): Record<string, unknown> {
  const jsonBody = (schema: JsonSchema): unknown => ({
    required: true,
    content: { "application/json": { schema } },
  });
  const rows = (name: string): unknown => ({
    "application/json": {
      schema: { type: "array", items: { $ref: `#/components/schemas/${name}` } },
    },
  });
  const one = (name: string): unknown => ({
    "application/json": { schema: { $ref: `#/components/schemas/${name}` } },
  });
  const writeErrors = {
    ...AUTHENTICATED_ERRORS,
    "409": { $ref: "#/components/responses/Conflict" },
  };
  const notFound = { "404": { $ref: "#/components/responses/NotFound" } };

  return {
    "/api/v1/annotations": {
      get: {
        operationId: "list_annotations",
        summary: "Project annotations",
        description:
          "Notes left on the project, newest first. `since`/`until` select the annotations whose period **overlaps** the window; a standing note (no period) always matches. Requires the `query` capability.",
        tags: ["metadata"],
        responses: {
          "200": { description: "Matching annotations.", content: rows("Annotation") },
          ...AUTHENTICATED_ERRORS,
        },
      },
      post: {
        operationId: "create_annotation",
        summary: "Annotate something",
        description:
          "Leave a note on the project, a scene, a mesh, a region, a metric or a period of time. Requires the **`annotate`** capability; the stored row records whether a person or an agent wrote it, and the write is recorded in the agent audit log.",
        tags: ["metadata"],
        requestBody: jsonBody(toJsonSchema(annotationSchema, "input")),
        responses: {
          "201": { description: "The stored annotation.", content: one("Annotation") },
          ...writeErrors,
        },
      },
    },
    "/api/v1/annotations/{id}": {
      delete: {
        operationId: "delete_annotation",
        summary: "Delete an annotation",
        description:
          "Remove one annotation of this project. Requires the `annotate` capability. An id that does not exist — or belongs to another project — answers 404.",
        tags: ["metadata"],
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        responses: { "204": { description: "Deleted." }, ...AUTHENTICATED_ERRORS, ...notFound },
      },
    },
    "/api/v1/glossary": {
      get: {
        operationId: "list_glossary",
        summary: "Project glossary",
        description:
          "What this project's names mean, ordered by term — the vocabulary to read before interpreting mesh names, scene ids and custom events. Requires the `query` capability.",
        tags: ["metadata"],
        responses: {
          "200": { description: "The whole glossary.", content: rows("GlossaryEntry") },
          ...AUTHENTICATED_ERRORS,
        },
      },
    },
    "/api/v1/glossary/{term}": {
      put: {
        operationId: "define_term",
        summary: "Define a term",
        description:
          "Idempotent upsert: the term is the identity, so defining it again replaces the meaning. Requires the **`annotate`** capability.",
        tags: ["metadata"],
        parameters: [{ name: "term", in: "path", required: true, schema: { type: "string" } }],
        requestBody: jsonBody({
          type: "object",
          properties: {
            meaning: {
              type: "string",
              maxLength: LIMITS.maxGlossaryMeaningLength,
              description: "What the term means in this project.",
            },
          },
          required: ["meaning"],
        }),
        responses: {
          "200": { description: "The stored entry.", content: one("GlossaryEntry") },
          ...writeErrors,
        },
      },
      delete: {
        operationId: "delete_term",
        summary: "Undefine a term",
        description: "Remove one glossary entry. Requires the `annotate` capability.",
        tags: ["metadata"],
        parameters: [{ name: "term", in: "path", required: true, schema: { type: "string" } }],
        responses: { "204": { description: "Deleted." }, ...AUTHENTICATED_ERRORS, ...notFound },
      },
    },
    "/api/v1/analyses": {
      get: {
        operationId: "list_analyses",
        summary: "Saved analyses",
        description:
          "Questions worth re-asking and what was concluded from them, newest first. Requires the `query` capability.",
        tags: ["metadata"],
        responses: {
          "200": { description: "Saved analyses.", content: rows("SavedAnalysis") },
          ...AUTHENTICATED_ERRORS,
        },
      },
      post: {
        operationId: "save_analysis",
        summary: "Save an analysis",
        description:
          "Store a titled question plus the finding it produced. `query` is an opaque JSON document the collector stores but does not interpret. Requires the **`annotate`** capability.",
        tags: ["metadata"],
        requestBody: jsonBody(toJsonSchema(savedAnalysisSchema, "input")),
        responses: {
          "201": { description: "The stored analysis.", content: one("SavedAnalysis") },
          ...writeErrors,
        },
      },
    },
    "/api/v1/analyses/{id}": {
      delete: {
        operationId: "delete_analysis",
        summary: "Delete a saved analysis",
        description: "Remove one saved analysis. Requires the `annotate` capability.",
        tags: ["metadata"],
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        responses: { "204": { description: "Deleted." }, ...AUTHENTICATED_ERRORS, ...notFound },
      },
    },
  };
}

/** The stored-row schemas of the three metadata tables. */
function metadataSchemas(): Record<string, unknown> {
  const author = {
    authorKind: {
      type: "string",
      enum: ["user", "agent"],
      description:
        "Whether a person (a first-party UI session) or an agent wrote the row. Derived by the collector from the calling client, never from the payload.",
    },
    authorKeyId: {
      type: ["string", "null"],
      description: "Id of the API key that carried the write — never the key or its hash.",
    },
  };
  return {
    Annotation: {
      type: "object",
      title: "Annotation",
      properties: {
        id: { type: "string" },
        projectId: { type: "string" },
        targetKind: {
          type: "string",
          enum: ["project", "scene", "mesh", "region", "metric", "window"],
          description: "What the note is about.",
        },
        targetId: {
          type: ["string", "null"],
          description: "The scene id, mesh name, region id or metric id the note points at.",
        },
        since: {
          type: ["string", "null"],
          description: "Start of the annotated period (ISO 8601).",
        },
        until: { type: ["string", "null"], description: "End of the annotated period (ISO 8601)." },
        text: { type: "string", maxLength: LIMITS.maxAnnotationTextLength },
        ...author,
        createdAt: { type: "string" },
        updatedAt: { type: "string" },
      },
      required: ["id", "projectId", "targetKind", "text", "createdAt", "updatedAt"],
    },
    GlossaryEntry: {
      type: "object",
      title: "Glossary entry",
      properties: {
        projectId: { type: "string" },
        term: { type: "string", maxLength: LIMITS.maxGlossaryTermLength },
        meaning: { type: "string", maxLength: LIMITS.maxGlossaryMeaningLength },
        updatedAt: { type: "string" },
      },
      required: ["projectId", "term", "meaning", "updatedAt"],
    },
    SavedAnalysis: {
      type: "object",
      title: "Saved analysis",
      properties: {
        id: { type: "string" },
        projectId: { type: "string" },
        title: { type: "string", maxLength: LIMITS.maxSavedAnalysisTitleLength },
        query: {
          type: "object",
          description:
            "The stored question, as an opaque JSON document the collector does not interpret.",
        },
        conclusion: {
          type: ["string", "null"],
          maxLength: LIMITS.maxSavedAnalysisConclusionLength,
        },
        ...author,
        createdAt: { type: "string" },
      },
      required: ["id", "projectId", "title", "query", "createdAt"],
    },
  };
}

/** The reusable components: the API-key scheme, error responses, row schemas. */
function componentsFor(metrics: readonly MetricDefinition[]): Record<string, unknown> {
  const schemas: Record<string, unknown> = {
    Error: {
      type: "object",
      title: "Error",
      properties: { error: { type: "string", description: "Human-readable failure reason." } },
      required: ["error"],
    },
    SceneRepresentationSummary: {
      type: "object",
      title: "Scene representation summary",
      properties: {
        sceneId: { type: "string", description: "Developer-assigned scene id (ADR 0010)." },
        label: { type: ["string", "null"], description: "Optional display label." },
        kind: { type: "string", description: "Representation kind (e.g. `proxy`)." },
        bounds: {
          type: ["object", "null"],
          description: "Registered world-space bounds, when the proxy carried them.",
        },
        contentHash: { type: ["string", "null"], description: "Content hash of the proxy blob." },
        capturedAt: {
          type: ["string", "null"],
          description: "When the proxy was scanned client-side.",
        },
        updatedAt: { type: "string", description: "When the representation was last written." },
      },
      required: ["sceneId", "kind", "updatedAt"],
    },
    ...metadataSchemas(),
  };
  for (const metric of metrics) schemas[metric.id] = rowSchema(metric);

  const errorContent = { "application/json": { schema: { $ref: "#/components/schemas/Error" } } };
  return {
    securitySchemes: {
      apiKey: {
        type: "apiKey",
        in: "header",
        name: "x-api-key",
        description:
          "A project API key with the `query` capability. Reads are always scoped to the project the key resolves to; a client-supplied project id is ignored.",
      },
    },
    responses: {
      BadRequest: { description: "A parameter failed validation.", content: errorContent },
      Unauthorized: { description: "Missing or unknown API key.", content: errorContent },
      Forbidden: {
        description:
          "The key lacks the capability this operation needs — `query` to read, `annotate` to write metadata.",
        content: errorContent,
      },
      NotFound: { description: "No such session, scene or metadata row.", content: errorContent },
      Conflict: {
        description:
          "The project has reached its cap for that metadata table. Delete a row and retry.",
        content: errorContent,
      },
      TooManyRequests: { description: "Rate limit exceeded.", content: errorContent },
    },
    schemas,
  };
}

/**
 * Build the OpenAPI 3.1 document for the read API from the metric registry and
 * the collector's own route table. Pure: it reads definitions only, never the
 * store, so it can be built once and served as a constant.
 */
export function buildOpenApiDocument(
  routeSchemas: readonly RouteSchemaEntry[] = [],
): OpenApiDocument {
  const byPath = new Map<string, RouteSchemaEntry>(
    routeSchemas.filter((route) => route.method === "GET").map((route) => [route.path, route]),
  );
  const metrics = allMetrics();
  const served = metrics.filter((metric) => metric.endpoint != null);

  const paths: Record<string, Record<string, unknown>> = {
    ...staticPaths(),
    ...metadataPaths(),
  } as Record<string, Record<string, unknown>>;
  for (const metric of served) {
    const path = toOpenApiPath(metric.endpoint!.path);
    paths[path] ??= {};
    paths[path]!.get = operationFor(metric, byPath.get(metric.endpoint!.path));
  }

  const categories = [...new Set(served.map((metric) => metric.category))];

  return {
    openapi: "3.1.0",
    jsonSchemaDialect: "https://json-schema.org/draft/2020-12/schema",
    info: {
      title: "Uptimizr collector — read API",
      version: API_DOCUMENT_VERSION,
      summary: "Privacy-first, aggregate-only analytics for 3D scenes.",
      description:
        "Every path below is generated from the Uptimizr **semantic metric registry**, so this " +
        "document lists exactly the aggregations the collector can compute — no more and no " +
        "less. Each operation carries `x-uptimizr-*` extensions describing what one row is " +
        "(`grain`), what its columns mean (`units`), the capture channels that must be enabled " +
        "for it to have data (`source-channels`), how far to trust it (`caveats`) and how to " +
        "read it (`interpretation`).\n\n" +
        "The analytics API is **read-only and aggregate-only**: no endpoint here returns raw " +
        "per-session events or personal data, and nothing can write, alter or delete an event " +
        "(ADR 0003, ADR 0051 §9). The one writable surface is the `metadata` group — " +
        "annotations, the glossary and saved analyses — which stores what a project's own " +
        "people and agents write, requires the `annotate` capability, and is audited.",
      license: { name: "Apache-2.0", identifier: "Apache-2.0" },
      contact: { name: "Uptimizr", url: "https://uptimizr.com/docs/" },
    },
    servers: [{ url: "/", description: "This collector." }],
    security: [{ apiKey: [] }],
    tags: [
      ...categories.map((category) => ({
        name: category,
        description: CATEGORY_DESCRIPTIONS[category] ?? category,
      })),
      { name: "meta", description: "Self-description and liveness." },
      {
        name: "metadata",
        description:
          "What people and agents leave behind: annotations, the project glossary, saved analyses. Reads need `query`; every write needs `annotate` and is audited.",
      },
    ],
    paths,
    components: componentsFor(served),
    "x-uptimizr-schema-version": SCHEMA_VERSION,
    "x-uptimizr-metric-count": served.length,
  };
}

/**
 * Meta routes: the generated OpenAPI document. Registered last in `app.ts` so
 * `routeSchemas` is already populated when the document is built.
 */
export const metaRoutes: FastifyPluginAsync<MetaRoutesOptions> = async (app, { routeSchemas }) => {
  // Built lazily on the first request: `onRoute` has fired for every plugin by
  // then, which it has not while this plugin is still being registered.
  let document: OpenApiDocument | undefined;

  app.get("/api/v1/openapi.json", async (_req, reply) => {
    document ??= buildOpenApiDocument(routeSchemas);
    return reply.type("application/json; charset=utf-8").send(document);
  });
};
