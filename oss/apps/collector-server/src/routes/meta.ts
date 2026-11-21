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
 * Routes that are not registry metrics are described by hand, next to each
 * other below: `/health` and this route, the project context, the
 * scene-representation listing, the `metadata` and `panels` groups, the
 * conditional-subscription resource, and the routes an agent needs besides the
 * metrics (#343) — key identity and the audit trail (`identity`), the scene
 * registry writes and region reads (`scene-registry`), the retention-gated raw
 * event stream (`raw`), the live surface (`live`) and ingestion (`ingest`).
 * Wherever a Zod schema validates a body, querystring or path parameter, the
 * JSON Schema is converted from it rather than restated.
 *
 * The live routes are `text/event-stream` responses on a hijacked socket. They
 * are described as such — a `text/event-stream` body whose event names are given
 * in prose — rather than as JSON operations, so a generated client is not misled
 * into expecting one JSON body. The conditional-subscription stream
 * (`GET /api/v1/subscriptions/stream`) is still left out.
 */

import type { FastifyInstance, FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { API_KEY_CAPABILITIES } from "@uptimizr/db";
import {
  LIMITS,
  SCHEMA_VERSION,
  aabbSchema,
  annotationSchema,
  collectRequestSchema,
  collectResponseSchema,
  panelSpecV1Schema,
  queryV1Schema,
  savedAnalysisSchema,
  sceneProxySchema,
  sceneRegionsSchema,
} from "@uptimizr/schema";
import { projectContextSchema } from "./context.js";
import {
  FILTER_TARGETS,
  metricCapability,
  allMetrics,
  isResourceMetric,
  type FilterId,
  type MetricDefinition,
} from "@uptimizr/metrics";

/** A JSON Schema object, as produced by `z.toJSONSchema`. */
type JsonSchema = Record<string, unknown>;

/**
 * The project context document's JSON Schema, derived from the very Zod schema
 * that serialises the response (`routes/context.ts`) rather than restated here —
 * the same rule the registry rows follow, for the same reason.
 */
function contextSchema(): JsonSchema {
  const schema = z.toJSONSchema(projectContextSchema, {
    io: "output",
    unrepresentable: "any",
  }) as JsonSchema;
  delete schema.$schema;
  return { title: "Project context", ...schema };
}

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
    "x-uptimizr-capability": metricCapability(metric),
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

/**
 * The **query DSL** operations (ADR 0051 §3). Unlike the paths above, these are
 * not generated from a registry entry — one route serves every metric — so the
 * operation is described here and its request body is the `queryV1` Zod schema
 * converted to JSON Schema, which is the same schema that validates the request.
 *
 * The response is deliberately loose: the row shape is the metric's, and the
 * document already describes every metric's row under `components.schemas`.
 */
function queryDslPath(): Record<string, unknown> {
  const body = toJsonSchema(queryV1Schema, "input");
  body.title = "Analytics query (v1)";
  const description =
    "Run **any** registry metric in one validated request: pick the `metric`, bound it with a " +
    "`range`, narrow it with the filters that metric declares, cap it with `limit`, and choose " +
    "the result envelope with `format` (`table` by default).\n\n" +
    "The grammar is **closed**: there is no raw SQL and no free-form expression, and the metric, " +
    "dimension and filter vocabularies are exactly this document's. A metric that does not accept " +
    "a filter, a dimension it is not keyed by, or a `limit` above its cap is a `400` naming what " +
    "it does accept.\n\n" +
    "**v1 is the delegated tier**: a query runs the metric's existing aggregation, so it is " +
    "reachable at exactly the power of its canned endpoint. `compare`, `segment`, `order`, " +
    "`explain`, `filters.event` and `filters.device` are part of the published grammar and are " +
    "answered with `400 … not supported yet` until the generic group-by tier lands.";

  const responses = {
    "200": {
      description:
        "The metric's rows (`format=full`), the rows plus a `meta` envelope (`table`), or a " +
        "bounded digest (`summary`).",
      content: { "application/json": { schema: { type: "object" } } },
    },
    ...AUTHENTICATED_ERRORS,
  };

  return {
    "/api/v1/query": {
      post: {
        operationId: "query",
        summary: "Run an analytics query",
        description,
        tags: ["meta"],
        requestBody: { required: true, content: { "application/json": { schema: body } } },
        responses,
      },
      get: {
        operationId: "query_get",
        summary: "Run an analytics query (GET form)",
        description:
          "The same query as `POST /api/v1/query`, URL-encoded into a single `q` parameter, for " +
          "GET-only clients.\n\n" +
          description,
        tags: ["meta"],
        parameters: [
          {
            name: "q",
            in: "query",
            required: true,
            description: "The query document, JSON-encoded and URL-encoded (at most 8 KiB).",
            schema: { type: "string", minLength: 1, maxLength: 8192 },
          },
        ],
        responses,
      },
    },
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
    "/api/v1/context": {
      get: {
        operationId: "project_context",
        summary: "Project context document",
        description:
          "Everything an agent needs to know about *this* project before it asks anything: the store engine and versions, data freshness and retention flags, which capture channels produce data, the scenes with their labels and named regions, the discovered custom-event/mesh/input vocabulary, the glossary and recent annotations, and which registry metrics are disabled because their capture channels are off (ADR 0051 §5). Bounded and cached briefly per project. Not a registry metric — it describes the project, not a row grain.",
        tags: ["meta"],
        parameters: [],
        responses: {
          "200": {
            description: "The project context document.",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/ProjectContext" },
              },
            },
          },
          ...AUTHENTICATED_ERRORS,
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

/**
 * The **panels** paths (#315, ADR 0051 §7): the declarative panel specs an
 * agent pins to the dashboard. Like the metadata group these are not registry
 * metrics, so they are described by hand here; the request body is converted
 * from the very Zod contract that validates it, so the document cannot drift
 * from the validator.
 */
function panelPaths(): Record<string, unknown> {
  const rows = {
    "application/json": {
      schema: { type: "array", items: { $ref: "#/components/schemas/PanelSpec" } },
    },
  };
  const one = { "application/json": { schema: { $ref: "#/components/schemas/PanelSpec" } } };
  const specBody = {
    required: true,
    content: { "application/json": { schema: toJsonSchema(panelSpecV1Schema, "input") } },
  };
  const idParam = [{ name: "id", in: "path", required: true, schema: { type: "string" } }];
  const refusal =
    "A spec whose query the registry cannot answer — an unknown metric, a filter the metric " +
    "does not accept — or whose `chart` does not suit the metric's grain, or whose `encoding` " +
    "names a column the result does not carry, is refused with the validator's issue codes, so " +
    "the spec can be fixed from the response rather than guessed at.";

  return {
    "/api/v1/panels": {
      get: {
        operationId: "list_panels",
        summary: "Pinned panels",
        description:
          "The project's declarative panel specs, **oldest first** — these are positions in a " +
          "dashboard grid rather than a feed, so a newly pinned panel is appended instead of " +
          "displacing the ones already there. Requires the `query` capability.",
        tags: ["panels"],
        responses: {
          "200": { description: "The pinned panels.", content: rows },
          ...AUTHENTICATED_ERRORS,
        },
      },
      post: {
        operationId: "pin_panel",
        summary: "Pin a panel",
        description:
          "Store a query, a chart and a one-line reading as a panel the dashboard renders on " +
          "every load. The spec is **data, never code**: no module is loaded and nothing is " +
          "evaluated, so pinning a panel does not widen the dashboard's trust boundary " +
          "(ADR 0041). Requires the **`annotate`** capability; the stored row records whether a " +
          "person or an agent pinned it, and the write is recorded in the agent audit log.\n\n" +
          refusal,
        tags: ["panels"],
        requestBody: specBody,
        responses: {
          "201": { description: "The stored panel.", content: one },
          ...AUTHENTICATED_ERRORS,
          "409": { $ref: "#/components/responses/Conflict" },
        },
      },
    },
    "/api/v1/panels/{id}": {
      put: {
        operationId: "update_panel",
        summary: "Replace a pinned panel's spec",
        description:
          "A full replacement rather than a patch — the spec is one closed document, and half " +
          "of one is not a panel. The row keeps its id, its place in the grid and its original " +
          "authorship: an edit is not a new pin. Requires the `annotate` capability.\n\n" +
          refusal,
        tags: ["panels"],
        parameters: idParam,
        requestBody: specBody,
        responses: {
          "200": { description: "The stored panel.", content: one },
          ...AUTHENTICATED_ERRORS,
          "404": { $ref: "#/components/responses/NotFound" },
        },
      },
      delete: {
        operationId: "unpin_panel",
        summary: "Unpin a panel",
        description:
          "Remove one panel from the project's dashboard. Requires the `annotate` capability. " +
          "An id that does not exist — or belongs to another project — answers 404.",
        tags: ["panels"],
        parameters: idParam,
        responses: {
          "204": { description: "Unpinned." },
          ...AUTHENTICATED_ERRORS,
          "404": { $ref: "#/components/responses/NotFound" },
        },
      },
    },
  };
}

/** Looks up the captured GET route for a Fastify path. */
type RouteLookup = (fastifyPath: string) => RouteSchemaEntry | undefined;

/**
 * The parameters of a hand-described operation, converted from the Zod params
 * and querystring schemas the captured route validates with — so their *types*
 * have one source, as they do for the metric paths. `descriptions` supplies the
 * meaning; `required` marks a query parameter the handler refuses without even
 * though its schema leaves it optional (the live `token`, which answers 401).
 */
function capturedParameters(
  fastifyPath: string,
  route: RouteSchemaEntry | undefined,
  descriptions: Readonly<Record<string, string>> = {},
  required: readonly string[] = [],
): unknown[] {
  const parameters: unknown[] = [];
  const paramsJson = route?.params ? toJsonSchema(route.params, "input") : undefined;
  const paramsProperties = (paramsJson?.properties ?? {}) as Record<string, JsonSchema>;
  for (const name of pathParamNames(fastifyPath)) {
    parameters.push({
      name,
      in: "path",
      required: true,
      ...(descriptions[name] ? { description: descriptions[name] } : {}),
      schema: paramsProperties[name] ?? { type: "string" },
    });
  }
  if (route?.querystring) {
    const json = toJsonSchema(route.querystring, "input");
    const properties = (json.properties ?? {}) as Record<string, JsonSchema>;
    const declared = new Set([...((json.required as string[] | undefined) ?? []), ...required]);
    for (const [name, schema] of Object.entries(properties)) {
      parameters.push({
        name,
        in: "query",
        required: declared.has(name),
        ...(descriptions[name] ? { description: descriptions[name] } : {}),
        schema,
      });
    }
  }
  return parameters;
}

/** The two 403 cases of the doubly-gated raw routes, in words. */
const RAW_GATE =
  "Raw per-session data needs **both** halves of the gate (ADR 0003, ADR 0051 §7): the key " +
  "must hold `query:raw`, and the collector must have been started with " +
  "`ENABLE_RAW_SESSION_RETENTION`.";

/**
 * Key **identity** and the agent **audit** trail (#309, ADR 0051 §7). `whoami`
 * is the call an agent makes first, to learn what its key may do.
 */
function identityPaths(route: RouteLookup): Record<string, unknown> {
  return {
    "/api/v1/whoami": {
      get: {
        operationId: "whoami",
        summary: "What this API key may do",
        description:
          "Reports the calling key's project, its id (never the key itself), its capability set, its label and the rate-limit budget it is held to. Agent clients call it first, so that they offer only the operations their capabilities permit — compare the capabilities with each operation's `x-uptimizr-capability`. Requires the `query` capability.",
        tags: ["identity"],
        parameters: [],
        responses: {
          "200": {
            description: "The calling key's identity.",
            content: { "application/json": { schema: { $ref: "#/components/schemas/WhoAmI" } } },
          },
          ...AUTHENTICATED_ERRORS,
        },
        "x-uptimizr-capability": "query",
      },
    },
    "/api/v1/audit": {
      get: {
        operationId: "list_audit",
        summary: "Agent audit trail",
        description:
          "What every agent key of this project has asked for, newest first: the surface, the path or tool, bounded and redacted parameters, the row count, the duration and the status. Rows carry no key material. Requests from the dashboard's own session are not recorded unless the collector is configured to record them. Requires the `query` capability.",
        tags: ["identity"],
        parameters: capturedParameters("/api/v1/audit", route("/api/v1/audit"), {
          since: "Inclusive lower bound, epoch milliseconds.",
          until: "Exclusive upper bound, epoch milliseconds.",
          limit: "Row cap (at most 1000).",
        }),
        responses: {
          "200": {
            description: "Audit rows, newest first.",
            content: {
              "application/json": {
                schema: { type: "array", items: { $ref: "#/components/schemas/AuditEntry" } },
              },
            },
          },
          ...AUTHENTICATED_ERRORS,
        },
        "x-uptimizr-capability": "query",
      },
    },
  };
}

/**
 * The **scene registry** writes and the region reads (ADR 0010/0014, ADR 0051
 * §2). The registry's two resource reads (`scene_representation`, the listing)
 * are described elsewhere; this adds what an agent writes and the region
 * vocabulary it reads back.
 */
function scenePaths(route: RouteLookup): Record<string, unknown> {
  const regionsRoute = route("/api/v1/scenes/:sceneId/regions");
  const sceneIdDescription = {
    sceneId: "Developer-assigned scene id (ADR 0010).",
  };
  const regionRows = {
    "application/json": {
      schema: { type: "array", items: { $ref: "#/components/schemas/SceneRegion" } },
    },
  };
  const regionsBody = {
    type: "object",
    title: "Scene regions",
    properties: { regions: toJsonSchema(sceneRegionsSchema, "input") },
    required: ["regions"],
  };
  const representationBody = {
    type: "object",
    title: "Scene representation",
    properties: {
      proxy: toJsonSchema(sceneProxySchema, "input"),
      label: { type: "string", maxLength: 200, description: "Optional display label." },
    },
    required: ["proxy"],
  };
  // The PUTs validate the same `sceneId` params schema as the GET beside them.
  const representationParams = capturedParameters(
    "/api/v1/scenes/:sceneId/representation",
    route("/api/v1/scenes/:sceneId/representation"),
    sceneIdDescription,
  );
  const regionsParams = capturedParameters(
    "/api/v1/scenes/:sceneId/regions",
    regionsRoute,
    sceneIdDescription,
  );

  return {
    "/api/v1/scene-regions": {
      get: {
        operationId: "list_scene_regions",
        summary: "Every declared region, across scenes",
        description:
          "The project's whole spatial vocabulary in one read: one row per declared region, names only — no boxes. The sibling of `/api/v1/scene-representations`. Requires the `query` capability.",
        tags: ["scene-registry"],
        parameters: [],
        responses: {
          "200": {
            description: "One row per region, across every scene.",
            content: {
              "application/json": {
                schema: {
                  type: "array",
                  items: { $ref: "#/components/schemas/SceneRegionListing" },
                },
              },
            },
          },
          ...AUTHENTICATED_ERRORS,
        },
        "x-uptimizr-capability": "query",
      },
    },
    "/api/v1/scenes/{sceneId}/regions": {
      get: {
        operationId: "get_scene_regions",
        summary: "One scene's regions",
        description:
          "The named, labelled boxes declared for one scene. A scene with no regions — or one never registered — answers an empty array, not 404. Requires the `query` capability.",
        tags: ["scene-registry"],
        parameters: regionsParams,
        responses: {
          "200": { description: "The scene's regions.", content: regionRows },
          ...AUTHENTICATED_ERRORS,
        },
        "x-uptimizr-capability": "query",
      },
      put: {
        operationId: "put_scene_regions",
        summary: "Declare a scene's regions",
        description:
          "Replaces the scene's whole region set; an empty array clears it. Region ids must be unique within the scene, `max` must be at least `min` on every axis, and the count is bounded. A declared region can then be named in `?region=<id>` on the spatial reads. Requires the **`annotate`** capability.",
        tags: ["scene-registry"],
        parameters: regionsParams,
        requestBody: { required: true, content: { "application/json": { schema: regionsBody } } },
        responses: {
          "200": { description: "The scene's regions as stored.", content: regionRows },
          ...AUTHENTICATED_ERRORS,
        },
        "x-uptimizr-capability": "annotate",
      },
    },
    "/api/v1/scenes/{sceneId}/representation": {
      put: {
        operationId: "put_scene_representation",
        summary: "Register or replace a scene's proxy geometry",
        description:
          "Stores the scene proxy (ADR 0014) the dashboard and spatial summaries draw on, with an optional display label. The proxy's own `sceneId` must match the path, or the request is a 400. Requires the **`annotate`** capability, so a read-only key cannot replace the geometry.",
        tags: ["scene-registry"],
        parameters: representationParams,
        requestBody: {
          required: true,
          content: { "application/json": { schema: representationBody } },
        },
        responses: {
          "200": {
            description: "The stored scene representation.",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/scene_representation" },
              },
            },
          },
          ...AUTHENTICATED_ERRORS,
        },
        "x-uptimizr-capability": "annotate",
      },
    },
  };
}

/** The **raw** session event stream (ADR 0003, ADR 0015) — doubly gated. */
function rawPaths(route: RouteLookup): Record<string, unknown> {
  const eventsArray = { type: "array", items: { type: "object" } };
  return {
    "/api/v1/sessions/{id}/events": {
      get: {
        operationId: "session_events",
        summary: "One session's raw event timeline",
        description:
          "The ordered events of one session, for replay. The default is one JSON array. Ask for `application/x-ndjson` — with an `Accept` header or `?format=ndjson` — to stream one event per line with bounded server memory.\n\n" +
          RAW_GATE +
          " A plain `query` key is still authenticated, so an unknown key answers 401, but it is refused the events.",
        tags: ["raw"],
        parameters: capturedParameters(
          "/api/v1/sessions/:id/events",
          route("/api/v1/sessions/:id/events"),
          {
            id: "Session id.",
            format: "`ndjson` streams one event per line; `json` (the default) is one array.",
          },
        ),
        responses: {
          "200": {
            description: "The session's events, in order.",
            content: {
              "application/json": { schema: eventsArray },
              "application/x-ndjson": {
                schema: {
                  type: "string",
                  description: "One JSON event object per line.",
                },
              },
            },
          },
          ...AUTHENTICATED_ERRORS,
          "403": {
            description:
              "Refused: the key lacks `query` (`api key not permitted to read`), the collector was started without `ENABLE_RAW_SESSION_RETENTION` (`raw session retention is disabled`), or the key lacks `query:raw` (`api key not permitted to read raw session data`).",
            content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } },
          },
        },
        "x-uptimizr-capability": "query:raw",
      },
    },
  };
}

/**
 * The **live** surface (ADR 0032): a token exchange, then three SSE streams.
 * `EventSource` cannot send `x-api-key`, so the streams take a short-lived
 * `?token=` minted from a key instead; the token carries the minting key's
 * capability set.
 */
function livePaths(route: RouteLookup): Record<string, unknown> {
  const tokenDescription =
    "Short-lived live token from `POST /api/v1/live/token`. Required: a missing, invalid or expired token answers 401.";
  const sseResponse = (description: string): unknown => ({
    description,
    content: {
      "text/event-stream": {
        schema: {
          type: "string",
          description:
            "A server-sent event stream. Each `data:` line is one JSON object; comment lines are heartbeats.",
        },
      },
    },
  });
  const tokenErrors = {
    "400": { $ref: "#/components/responses/BadRequest" },
    "401": {
      description: "The `token` is missing, invalid or expired.",
      content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } },
    },
    "429": { $ref: "#/components/responses/TooManyRequests" },
    "503": {
      description: "The collector's live connection limit has been reached. Retry later.",
      content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } },
    },
  };
  const tokenAuth =
    "Authenticated by the `token` query parameter, not by `x-api-key`: mint one with `POST /api/v1/live/token`.";

  return {
    "/api/v1/live/token": {
      post: {
        operationId: "live_token",
        summary: "Exchange an API key for a live token",
        description:
          "Server-to-server: mints a short-lived token for the live streams, because a browser `EventSource` cannot send `x-api-key`. The token carries the key's project and its whole capability set, so the per-session follow can still enforce `query:raw`. Requires the `query` capability.",
        tags: ["live"],
        responses: {
          "200": {
            description: "The token and when it expires.",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    token: { type: "string", description: "Pass as `?token=` to a live stream." },
                    expiresAt: {
                      type: "integer",
                      description: "When the token expires, epoch milliseconds.",
                    },
                  },
                  required: ["token", "expiresAt"],
                },
              },
            },
          },
          ...AUTHENTICATED_ERRORS,
        },
        "x-uptimizr-capability": "query",
      },
    },
    "/api/v1/live/presence": {
      get: {
        operationId: "live_presence",
        summary: "Live presence (SSE)",
        description:
          "An aggregate snapshot of who is in the project right now, sent at once and then on an interval that doubles as the heartbeat, as `presence` events. Aggregate, so it is not gated by raw-session retention. " +
          tokenAuth,
        tags: ["live"],
        security: [],
        parameters: capturedParameters(
          "/api/v1/live/presence",
          route("/api/v1/live/presence"),
          { token: tokenDescription },
          ["token"],
        ),
        responses: {
          "200": sseResponse("A stream of `presence` events."),
          ...tokenErrors,
        },
        "x-uptimizr-capability": "query",
      },
    },
    "/api/v1/live/stream": {
      get: {
        operationId: "live_stream",
        summary: "Live project event stream (SSE)",
        description:
          "Every event arriving for the project, as `event` events, optionally narrowed to a list of event types. Drives the dashboard's in-place updates. " +
          tokenAuth,
        tags: ["live"],
        security: [],
        parameters: capturedParameters(
          "/api/v1/live/stream",
          route("/api/v1/live/stream"),
          {
            token: tokenDescription,
            types: "Comma-separated event types to keep; all types when omitted.",
          },
          ["token"],
        ),
        responses: {
          "200": sseResponse("A stream of `event` events."),
          ...tokenErrors,
        },
        "x-uptimizr-capability": "query",
      },
    },
    "/api/v1/live/sessions/{id}": {
      get: {
        operationId: "live_session",
        summary: "Follow one session live (SSE)",
        description:
          "The recent events of one session, then each new one as it arrives, as `event` events — live replay. " +
          RAW_GATE +
          " Here `query:raw` is read from the capabilities of the key that minted the token. " +
          tokenAuth,
        tags: ["live"],
        security: [],
        parameters: capturedParameters(
          "/api/v1/live/sessions/:id",
          route("/api/v1/live/sessions/:id"),
          { id: "Session id.", token: tokenDescription },
          ["token"],
        ),
        responses: {
          "200": sseResponse("A stream of `event` events for the session."),
          ...tokenErrors,
          "403": {
            description:
              "Refused: the collector was started without `ENABLE_RAW_SESSION_RETENTION` (`raw session retention is disabled`), or the key that minted the token lacks `query:raw` (`api key not permitted to read raw session data`).",
            content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } },
          },
        },
        "x-uptimizr-capability": "query:raw",
      },
    },
  };
}

/**
 * **Ingestion** (`POST /api/v1/collect`): the browser SDK's endpoint, not an
 * agent's. Described for completeness; the body and response are the very Zod
 * contracts that validate and serialise them.
 */
function ingestPaths(): Record<string, unknown> {
  const errorContent = { "application/json": { schema: { $ref: "#/components/schemas/Error" } } };
  return {
    "/api/v1/collect": {
      post: {
        operationId: "collect",
        summary: "Ingest a batch of events",
        description:
          "The browser SDK's ingestion endpoint. It takes no API key: a beacon cannot send a secret header, so the public `projectId` in each event is the credential. Every event in a batch must share one `projectId`, and a project that does not exist is refused. The collector adds a cookieless daily visitor id; the raw IP is never stored. Bounded by a dedicated ingest rate limit and the CORS allow-list.",
        tags: ["ingest"],
        security: [],
        requestBody: {
          required: true,
          content: {
            "application/json": { schema: toJsonSchema(collectRequestSchema, "input") },
          },
        },
        responses: {
          "200": {
            description: "How many events were accepted.",
            content: {
              "application/json": { schema: toJsonSchema(collectResponseSchema, "output") },
            },
          },
          "400": {
            description:
              "The batch failed validation, or its events name more than one `projectId`.",
            content: errorContent,
          },
          "401": { description: "The `projectId` names no known project.", content: errorContent },
          "429": { $ref: "#/components/responses/TooManyRequests" },
        },
      },
    },
  };
}

/** The response schemas of the identity and scene-registry routes. */
function agentSchemas(): Record<string, unknown> {
  return {
    WhoAmI: {
      type: "object",
      title: "API key identity",
      properties: {
        projectId: { type: "string", description: "The project the key resolves to." },
        keyId: { type: "string", description: "The key row's id — never the key or its hash." },
        capabilities: {
          type: "array",
          items: { type: "string", enum: [...API_KEY_CAPABILITIES] },
          description: "What the key may do.",
        },
        label: { type: ["string", "null"], description: "Operator-supplied name of the key." },
        rateLimit: {
          type: "object",
          properties: {
            max: { type: "integer", description: "Requests allowed per window." },
            windowMs: { type: "integer", description: "Window length, milliseconds." },
          },
          required: ["max", "windowMs"],
        },
        rateLimitSource: {
          type: "string",
          enum: ["key", "default"],
          description: "Whether `rateLimit` is the key's own budget or the collector default.",
        },
      },
      required: ["projectId", "keyId", "capabilities", "label", "rateLimit", "rateLimitSource"],
    },
    AuditEntry: {
      type: "object",
      title: "Agent audit entry",
      properties: {
        id: { type: "string" },
        projectId: { type: "string" },
        keyId: { type: "string", description: "The key row's id — never the key or its hash." },
        at: { type: "string", format: "date-time", description: "When the request was made." },
        surface: { type: "string", enum: ["http", "mcp-http", "mcp-stdio", "assistant"] },
        toolOrPath: { type: "string", description: "Endpoint path (`http`) or tool name." },
        params: { type: "string", description: "Bounded, redacted JSON of the parameters." },
        rowCount: {
          type: ["integer", "null"],
          description: "Rows returned, when the result was countable.",
        },
        durationMs: { type: "number" },
        status: { type: "integer", description: "HTTP status, or its equivalent." },
      },
      required: [
        "id",
        "projectId",
        "keyId",
        "at",
        "surface",
        "toolOrPath",
        "params",
        "rowCount",
        "durationMs",
        "status",
      ],
    },
    SceneRegion: {
      type: "object",
      title: "Scene region",
      properties: {
        projectId: { type: "string" },
        sceneId: { type: "string" },
        regionId: { type: "string", description: "Stable region id, unique within the scene." },
        label: { type: "string" },
        description: { type: ["string", "null"] },
        bounds: {
          ...toJsonSchema(aabbSchema, "output"),
          description: "World-space box `[minX,minY,minZ,maxX,maxY,maxZ]`.",
        },
        updatedAt: { type: "string", description: "When the region was last written." },
      },
      required: ["projectId", "sceneId", "regionId", "label", "description", "bounds", "updatedAt"],
    },
    SceneRegionListing: {
      type: "object",
      title: "Scene region listing row",
      properties: {
        sceneId: { type: "string" },
        regionId: { type: "string" },
        label: { type: "string" },
      },
      required: ["sceneId", "regionId", "label"],
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
    PanelSpec: {
      type: "object",
      title: "Pinned panel",
      properties: {
        id: { type: "string" },
        projectId: { type: "string" },
        spec: {
          ...(toJsonSchema(panelSpecV1Schema, "output") as Record<string, unknown>),
          description:
            "The declarative spec the dashboard renders: a query, a chart, an optional encoding and the agent's one-line reading. Data, never code — nothing here is evaluated.",
        },
        ...author,
        createdAt: { type: "string" },
        updatedAt: { type: "string" },
      },
      required: ["id", "projectId", "spec", "createdAt", "updatedAt"],
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
    ProjectContext: contextSchema(),
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
    ...agentSchemas(),
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
          "A project API key with the `query` capability. Reads are always scoped to the project the key resolves to; a client-supplied project id is ignored. An operation whose `x-uptimizr-capability` is `query:raw` needs a key holding that capability as well, on a collector started with `ENABLE_RAW_SESSION_RETENTION` (ADR 0003 / ADR 0051 §7).",
      },
    },
    responses: {
      BadRequest: { description: "A parameter failed validation.", content: errorContent },
      Unauthorized: { description: "Missing or unknown API key.", content: errorContent },
      Forbidden: {
        description:
          "The key does not hold the capability this operation requires — an ingest-only key " +
          "trying to read, a `query` key asking for a `query:raw` operation, or a key without " +
          "`annotate` trying to write metadata. A `query:raw` operation also answers 403 when " +
          "the collector was started without `ENABLE_RAW_SESSION_RETENTION` (ADR 0003). Check " +
          "each operation's `x-uptimizr-capability`.",
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
  const route: RouteLookup = (fastifyPath) => byPath.get(fastifyPath);
  const metrics = allMetrics();
  const served = metrics.filter((metric) => metric.endpoint != null);

  const paths: Record<string, Record<string, unknown>> = {
    ...staticPaths(),
    ...queryDslPath(),
    ...metadataPaths(),
    ...panelPaths(),
    ...identityPaths(route),
    ...scenePaths(route),
    ...rawPaths(route),
    ...livePaths(route),
    ...ingestPaths(),
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
        "Every metric path below is generated from the Uptimizr **semantic metric registry**, " +
        "so this document lists exactly the aggregations the collector can compute — no more " +
        "and no less. Each metric operation carries `x-uptimizr-*` extensions describing what " +
        "one row is (`grain`), what its columns mean (`units`), the capture channels that must " +
        "be enabled for it to have data (`source-channels`), how far to trust it (`caveats`) " +
        "and how to read it (`interpretation`).\n\n" +
        "The analytics reads are **aggregate-only**, and nothing here can alter or delete a " +
        "stored event (ADR 0003, ADR 0051 §9). Raw per-session data is reachable only through " +
        "the doubly-gated `query:raw` operations — `session_narrative`, the raw event " +
        "timeline (`raw`) and the live per-session follow (`live`) — each of which needs both " +
        "a `query:raw` key and a collector started with `ENABLE_RAW_SESSION_RETENTION`. " +
        "The writable surface is project metadata — the `metadata` and `panels` groups, " +
        "conditional `subscriptions` and the `scene-registry` writes — which needs the " +
        "`annotate` capability and is audited; and ingestion (`ingest`), the browser SDK's " +
        "endpoint, which takes no API key because the public project id is its credential. " +
        "Start with `GET /api/v1/whoami` to learn what a key may do, and check each " +
        "operation's `x-uptimizr-capability`.",
      license: { name: "Apache-2.0", identifier: "Apache-2.0" },
      contact: { name: "Uptimizr", url: "https://www.uptimizr.com/docs/" },
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
      {
        name: "panels",
        description:
          "Declarative panel specs an agent pins to the dashboard (ADR 0051 §7): a query, a chart and a reading, stored as data and rendered with the panels the dashboard already ships — never as loaded code. Reads need `query`; every write needs `annotate` and is audited.",
      },
      {
        name: "subscriptions",
        description:
          "Conditional subscriptions: standing predicates over a metric, delivered over SSE and signed webhooks (ADR 0051 §6).",
      },
      {
        name: "identity",
        description:
          "Who the calling key is and what it may do (`whoami`), and the project's agent audit trail. Both need `query`.",
      },
      {
        name: "scene-registry",
        description:
          "The scene registry (ADR 0014) and its named regions (ADR 0051 §2): the vocabulary for *where*. Reads need `query`; writes need `annotate`.",
      },
      {
        name: "raw",
        description:
          "Raw per-session data, gated twice: a `query:raw` key and a collector started with `ENABLE_RAW_SESSION_RETENTION` (ADR 0003).",
      },
      {
        name: "live",
        description:
          "Live server-sent event streams (ADR 0032). Exchange a `query` key for a short-lived token with `POST /api/v1/live/token`, then pass it as `?token=`; the per-session follow also needs `query:raw` and raw-session retention.",
      },
      {
        name: "ingest",
        description:
          "Event ingestion from the browser SDK. Unauthenticated by API key: the public project id in each event is the credential.",
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
