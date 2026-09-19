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
 * listing, and the conditional-subscription resource). Ingestion
 * (`POST /api/v1/collect`), the scene-proxy write (`PUT …/representation`), the
 * retention-gated raw event stream and every SSE surface — the live endpoints
 * and `GET /api/v1/subscriptions/stream` alike — are deliberately omitted rather
 * than half-described: a hijacked `text/event-stream` response is not an
 * operation with a JSON body, and pretending otherwise misleads a generated
 * client.
 *
 * Conditional subscriptions (#311) are the one **write** surface described here.
 * They earn it: they are a CRUD resource rather than a query, and the only place
 * a caller needs a written contract for a request *body* — a closed Zod union
 * that cannot be inferred from a querystring.
 */

import type { FastifyInstance, FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { SCHEMA_VERSION } from "@uptimizr/schema";
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

/** The `{id}` path parameter shared by every per-subscription operation. */
const SUBSCRIPTION_ID_PARAM = {
  name: "id",
  in: "path" as const,
  required: true,
  schema: { type: "string", maxLength: 64 },
  description: "Collector-assigned subscription id (`sub_…`).",
};

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
    // --- Conditional subscriptions (#311, ADR 0051 §6 / sketch §F.1–F.3) ----
    // Described here rather than derived, because a subscription is project
    // *configuration* and not a metric: it has no rows, no grain and no window,
    // so there is nothing in the registry to generate an operation from.
    //
    // The SSE stream stays omitted, for the reason the module note gives: a
    // hijacked `text/event-stream` response is not honestly describable as a
    // JSON operation, and a half-description is worse than the docs-site prose.
    "/api/v1/subscriptions": {
      get: {
        operationId: "list_subscriptions",
        summary: "Conditional subscriptions",
        description:
          "The project's standing conditional subscriptions (ADR 0051 §6): what the collector watches for, how often it checks, where a firing is delivered, and how each one last went. Any webhook secret is masked. Needs the `query` capability.",
        tags: ["subscriptions"],
        parameters: [],
        responses: {
          "200": {
            description: "One entry per subscription, oldest first.",
            content: {
              "application/json": {
                schema: { type: "array", items: { $ref: "#/components/schemas/Subscription" } },
              },
            },
          },
          ...AUTHENTICATED_ERRORS,
        },
      },
      post: {
        operationId: "create_subscription",
        summary: "Create a conditional subscription",
        description:
          "Store a new subscription. Needs the `annotate` capability, because creating one is how a caller asks the collector to make an outbound request on its behalf. A webhook `secret` is write-only: it is accepted here and never returned again. A webhook URL must be http(s) and its host must appear in `COLLECTOR_WEBHOOK_ALLOWED_HOSTS`, or the request is refused.",
        tags: ["subscriptions"],
        requestBody: {
          required: true,
          content: {
            "application/json": { schema: { $ref: "#/components/schemas/Subscription" } },
          },
        },
        responses: {
          "201": {
            description: "The stored subscription, with any secret masked.",
            content: {
              "application/json": { schema: { $ref: "#/components/schemas/Subscription" } },
            },
          },
          "409": {
            description: "The project already holds the maximum number of subscriptions.",
            content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } },
          },
          ...AUTHENTICATED_ERRORS,
        },
      },
    },
    "/api/v1/subscriptions/{id}": {
      get: {
        operationId: "get_subscription",
        summary: "One conditional subscription",
        tags: ["subscriptions"],
        parameters: [SUBSCRIPTION_ID_PARAM],
        responses: {
          "200": {
            description: "The subscription.",
            content: {
              "application/json": { schema: { $ref: "#/components/schemas/Subscription" } },
            },
          },
          "404": { $ref: "#/components/responses/NotFound" },
          ...AUTHENTICATED_ERRORS,
        },
      },
      patch: {
        operationId: "set_subscription_enabled",
        summary: "Enable or disable a subscription",
        description:
          "The only patchable field is `enabled`. Everything else changes what the subscription *means*, so it is replaced rather than edited. Needs `annotate`.",
        tags: ["subscriptions"],
        parameters: [SUBSCRIPTION_ID_PARAM],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: { enabled: { type: "boolean" } },
                required: ["enabled"],
              },
            },
          },
        },
        responses: {
          "200": {
            description: "The updated subscription.",
            content: {
              "application/json": { schema: { $ref: "#/components/schemas/Subscription" } },
            },
          },
          "404": { $ref: "#/components/responses/NotFound" },
          ...AUTHENTICATED_ERRORS,
        },
      },
      delete: {
        operationId: "delete_subscription",
        summary: "Delete a subscription and its firing log",
        tags: ["subscriptions"],
        parameters: [SUBSCRIPTION_ID_PARAM],
        responses: {
          "204": { description: "Deleted." },
          "404": { $ref: "#/components/responses/NotFound" },
          ...AUTHENTICATED_ERRORS,
        },
      },
    },
    "/api/v1/subscriptions/{id}/events": {
      get: {
        operationId: "list_subscription_events",
        summary: "Recent firings of one subscription",
        description:
          "The bounded firing log — the last 100 firings, newest first. Each row is { id, subscriptionId, projectId, at, payload }, where `payload` is the firing record plus the `format=summary` block that was delivered with it.",
        tags: ["subscriptions"],
        parameters: [
          SUBSCRIPTION_ID_PARAM,
          {
            name: "limit",
            in: "query",
            required: false,
            schema: { type: "integer", minimum: 1, maximum: 100 },
            description: "Newest-first cap; clamped to the retained window.",
          },
        ],
        responses: {
          "200": {
            description: "One entry per recorded firing.",
            content: {
              "application/json": { schema: { type: "array", items: { type: "object" } } },
            },
          },
          "404": { $ref: "#/components/responses/NotFound" },
          ...AUTHENTICATED_ERRORS,
        },
      },
    },
    "/api/v1/subscriptions/{id}/test": {
      post: {
        operationId: "test_subscription",
        summary: "Evaluate a subscription once, now",
        description:
          "Runs the predicate immediately and answers with the evaluation, including why it did **not** fire. A dry run by default; `deliver=true` records and delivers a real firing (honouring the cooldown), which is how a webhook receiver is proved to work without waiting for the condition to occur. Needs `annotate`.",
        tags: ["subscriptions"],
        parameters: [
          SUBSCRIPTION_ID_PARAM,
          {
            name: "deliver",
            in: "query",
            required: false,
            schema: { type: "boolean", default: false },
            description: "Record and deliver the firing if the predicate is satisfied.",
          },
        ],
        responses: {
          "200": {
            description: "The evaluation.",
            content: { "application/json": { schema: { type: "object" } } },
          },
          "404": { $ref: "#/components/responses/NotFound" },
          "409": {
            description: "An evaluation of this subscription is already in flight.",
            content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } },
          },
          ...AUTHENTICATED_ERRORS,
        },
      },
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
    Subscription: {
      type: "object",
      title: "Conditional subscription",
      description:
        "A standing question (ADR 0051 §6): a registry metric, a window, a predicate over that window, and where a firing is delivered. A webhook secret is accepted on create and never returned — reads carry a masked placeholder.",
      properties: {
        id: { type: "string", description: "Collector-assigned (sub_…); absent on create." },
        projectId: { type: "string" },
        name: { type: "string", maxLength: 120 },
        metric: { type: "string", description: "Registry metric id (`@uptimizr/metrics`)." },
        filters: {
          type: "object",
          properties: { scene: { type: "string" } },
          description: "Narrows the metric the subscription watches.",
        },
        evaluate: {
          type: "object",
          properties: {
            every: { type: "string", description: "Evaluation interval, e.g. 5m. Minimum 1m." },
            window: {
              type: "string",
              description: "Span each evaluation measures, e.g. 1h. Minimum 1h.",
            },
            bucket: { type: "string", enum: ["hour", "day"] },
          },
          required: ["every", "window"],
        },
        predicate: {
          type: "object",
          description:
            "Closed union discriminated on `kind`: threshold {column, op, value, minSample}, anomaly {sensitivity}, movers {pct, direction}, new_value {dimension}, presence {op, value}.",
          properties: {
            kind: {
              type: "string",
              enum: ["threshold", "anomaly", "movers", "new_value", "presence"],
            },
          },
          required: ["kind"],
        },
        cooldown: { type: "string", description: "Quiet period after a firing; 0s for none." },
        delivery: {
          type: "array",
          description: "{ kind: sse } and/or one { kind: webhook, url, secret? }.",
          items: { type: "object" },
        },
        enabled: { type: "boolean", default: true },
        lastFiredAt: { type: ["string", "null"] },
        lastError: { type: ["string", "null"] },
        failures: { type: "integer" },
      },
      required: ["name", "metric", "evaluate", "predicate", "delivery"],
    },
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
        description: "The key is ingest-only and may not read.",
        content: errorContent,
      },
      NotFound: { description: "No such session or scene.", content: errorContent },
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

  const paths: Record<string, Record<string, unknown>> = staticPaths() as Record<
    string,
    Record<string, unknown>
  >;
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
        "The API is **read-only and aggregate-only**: there is no endpoint here that returns raw " +
        "per-session events or personal data (ADR 0003).",
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
        name: "subscriptions",
        description:
          "Conditional subscriptions: standing predicates over a metric, delivered over SSE and signed webhooks (ADR 0051 §6).",
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
