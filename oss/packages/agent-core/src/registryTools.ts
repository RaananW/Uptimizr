/**
 * **Generated tool catalog** (ADR 0051 §1, design sketch §A.2).
 *
 * `registryToTools()` turns the semantic metric registry in `@uptimizr/metrics`
 * into the read-only {@link ReadTool} catalog this package exports. One registry
 * entry with an `endpoint` becomes exactly one tool, so agent coverage of the
 * collector's read surface is mechanical rather than hand-maintained: adding an
 * aggregation + a registry entry adds the tool, and there is no second list to
 * forget.
 *
 * What each part of a tool is derived from:
 *
 * | Tool field     | Registry source                                            |
 * | -------------- | ---------------------------------------------------------- |
 * | `name`         | `id` (the 20 shipped tool names are registry ids verbatim)  |
 * | `title`        | `title`                                                     |
 * | `description`  | `description` + `interpretation` + `caveats`                |
 * | `inputSchema`  | `filters` + `endpoint.pathParams`, via {@link FILTER_FIELDS} |
 * | `buildRequest` | `endpoint.path` (with `:param` substitution) + `filters`    |
 * | `outputSchema` | `row`, wrapped as `{ rows: Row[] }`                         |
 *
 * **Browser safety (ADR 0050).** This module imports `@uptimizr/metrics` — the
 * registry's own dependency-free package, whose only runtime dependencies are
 * `zod` and `@uptimizr/schema`. This package does not depend on `@uptimizr/db`
 * at all: that package owns the DuckDB store and pulls in a ~37 MB native
 * binding a browser can never use. `src/__tests__/browserSafety.test.ts` bundles
 * this package for the browser and fails if any `node:` built-in or the DuckDB
 * driver reaches the bundle, and `src/__tests__/dependencies.test.ts` fails if
 * `@uptimizr/db` ever reappears in the manifest.
 */

import { z } from "zod";
import { allMetrics, type FilterId, type MetricDefinition } from "@uptimizr/metrics";
import type { QueryParams } from "./client.js";
import type { ReadTool, ReadToolRequest } from "./tools.js";

// ---------------------------------------------------------------------------
// Shared parameter definitions
// ---------------------------------------------------------------------------
//
// One Zod field per registry `FilterId`, defined **once** and reused by every
// tool that accepts that filter — the "a param means the same thing everywhere"
// rule the capabilities resource already assumes.
//
// The fields for the parameters the hand-written catalog shipped (`since`,
// `until`, `bins`, `limit`, `scene`, `session`, `cellSize`, `interval`, `type`,
// `source`, `cameraMode`, `rapidTurn`, `steps`) are carried over **verbatim**,
// so the 20 shipped tools' JSON Schemas are byte-identical after the migration
// (`src/__tests__/shippedToolCompat.test.ts` pins that against a frozen
// fixture). Bounds on the new fields mirror the collector's own Zod querystring
// in `oss/apps/collector-server/src/routes/query.ts`.

const since = z.number().int().optional().describe("Start of the time range, epoch milliseconds.");
const until = z.number().int().optional().describe("End of the time range, epoch milliseconds.");
const bins = z.number().int().positive().max(500).optional().describe("Grid resolution per axis.");
const limit = z.number().int().positive().max(1000).optional().describe("Maximum rows to return.");
const scene = z.string().optional().describe("Restrict to one developer-assigned scene id.");
const session = z.string().optional().describe("Scope the aggregate to a single session id.");
const cellSize = z.number().positive().max(1000).optional().describe("Voxel size in world units.");
const interval = z
  .number()
  .int()
  .positive()
  .optional()
  .describe("Time-series bucket width, seconds.");
const eventType = z
  .string()
  .optional()
  .describe("Restrict to a single event type, e.g. pointer_click.");
const source = z
  .enum(["mouse", "touch", "stylus", "pen", "xr-controller", "hand", "gaze", "transient", "other"])
  .optional()
  .describe("Restrict a pointer/world heatmap to one input source.");
const cameraMode = z
  .enum(["viewer", "first-person"])
  .optional()
  .describe("Camera navigation mode to scope to: 'viewer' (orbit) or 'first-person' (walkable).");
const rapidTurn = z
  .number()
  .nonnegative()
  .max(Math.PI)
  .optional()
  .describe(
    "Rapid-turn threshold in radians (0..π); view turns above this flag motion-sickness risk.",
  );
const steps = z
  .string()
  .min(1)
  .describe(
    "Funnel steps as a JSON-encoded array of ordered step predicates (ADR 0038). Required. " +
      'Each step is `{ "type": <event_type>, ... }`; e.g. ' +
      '`[{"type":"scene_change","to":"lobby"},{"type":"mesh_interaction","mesh":"buy"}]`.',
  );

/**
 * The Zod field each {@link FilterId} contributes to a tool's input schema.
 *
 * Every entry is **optional** except the two the collector declares required
 * (see {@link REQUIRED_FILTERS}); `filterField()` re-derives requiredness per
 * metric so one shared definition serves both cases.
 */
const FILTER_FIELDS: Readonly<Record<FilterId, z.ZodType>> = {
  since,
  until,
  scene,
  session,
  source,
  mesh: z.string().min(1).max(256).optional().describe("Restrict to one mesh/object name."),
  region: z
    .string()
    .optional()
    .describe(
      "World-space drill-down box as `minX,minY,minZ,maxX,maxY,maxZ` (ADR 0040 §4). " +
        "Omit for the whole scene.",
    ),
  cameraMode,
  bins,
  limit,
  cellSize,
  interval,
  type: eventType,
  bucket: z.number().int().positive().max(240).optional().describe("Histogram bin width in FPS."),
  bucketMs: z
    .number()
    .int()
    .positive()
    .max(60_000)
    .optional()
    .describe("Histogram bin width in milliseconds."),
  bucketSize: z
    .number()
    .positive()
    .max(1000)
    .optional()
    .describe("Histogram bin width in world units."),
  minRepeats: z
    .number()
    .int()
    .min(2)
    .max(100)
    .optional()
    .describe("Minimum clicks in a window before it counts as a rage cluster."),
  windowMs: z
    .number()
    .int()
    .positive()
    .max(86_400_000)
    .optional()
    .describe("How long before a session's end a perf dip still counts as correlated."),
  fpsThreshold: z
    .number()
    .positive()
    .max(240)
    .optional()
    .describe("A frame-perf sample below this FPS counts as a dip."),
  stallMs: z
    .number()
    .nonnegative()
    .max(60_000)
    .optional()
    .describe("A shader-compile stall at least this long (ms) counts as a dip."),
  moveThreshold: z
    .number()
    .nonnegative()
    .max(1000)
    .optional()
    .describe("Inter-sample distance (world units) above which a segment counts as active travel."),
  rapidTurn,
  centerX: z.number().optional().describe("X of the reference point distances are measured from."),
  centerY: z.number().optional().describe("Y of the reference point distances are measured from."),
  centerZ: z.number().optional().describe("Z of the reference point distances are measured from."),
  severity: z
    .string()
    .min(1)
    .max(64)
    .optional()
    .describe(
      "Graphics-diagnostic severity (info / warning / error / fatal). " +
        "Setting it excludes JS runtime errors.",
    ),
  category: z
    .string()
    .min(1)
    .max(64)
    .optional()
    .describe(
      "Graphics-diagnostic category (context-loss / validation / shader-compile / …). " +
        "Setting it excludes JS runtime errors.",
    ),
  errorKind: z
    .string()
    .min(1)
    .max(64)
    .optional()
    .describe(
      "Runtime-error kind (error / unhandledrejection). Setting it excludes engine diagnostics.",
    ),
  groupByOrigin: z
    .boolean()
    .optional()
    .describe("Add the click-time standpoint voxel as a grouping dimension."),
  originVoxel: z
    .string()
    .regex(/^-?\d+(\.\d+)?,-?\d+(\.\d+)?,-?\d+(\.\d+)?$/)
    .optional()
    .describe("Restrict to clicks whose standpoint falls in this `vx,vy,vz` voxel."),
  steps: steps.optional(),
  bands: z
    .string()
    .max(256)
    .optional()
    .describe(
      "Ascending, comma-separated load-time band boundaries in ms. " +
        "Omit for the default `1000,3000,5000`.",
    ),
  variant: z
    .string()
    .min(1)
    .max(2048)
    .optional()
    .describe(
      "JSON funnel-step predicate selecting the variant events. " +
        "Omit to treat every custom event as a variant.",
    ),
  conversion: z
    .string()
    .min(1)
    .max(2048)
    .optional()
    .describe("JSON funnel-step predicate for the success event. Omit to report views only."),
  // --- insight primitives (ADR 0051 §4) ---
  // `metric` / `metrics` are the only arguments whose value is itself a
  // registry metric id, so their descriptions point at the capabilities
  // resource rather than listing 40 ids inline.
  metric: z
    .string()
    .min(1)
    .max(64)
    .optional()
    .describe(
      "The registry metric to compute the insight over. Must be a comparable metric that has a " +
        "portable bucket series; an id that has none is rejected with the list of ids that do.",
    ),
  metrics: z
    .string()
    .min(1)
    .max(1024)
    .optional()
    .describe(
      "Comma-separated allowlist of registry metric ids to scan instead of the curated default " +
        "set. Capped per request; a longer list is rejected rather than silently truncated.",
    ),
  window: z
    .number()
    .int()
    .positive()
    .max(365)
    .optional()
    .describe("Baseline window length in days, counted back from `until`. Defaults to 28."),
  refSince: z
    .number()
    .int()
    .optional()
    .describe(
      "Start of the reference window a change is measured against, epoch milliseconds. " +
        "Defaults to the equal-length window immediately before the current range.",
    ),
  refUntil: z
    .number()
    .int()
    .optional()
    .describe("End of the reference window, epoch milliseconds. Defaults to `since`."),
  // The shared result envelope (ADR 0051 §2). Declared literally rather than
  // imported from `@uptimizr/db/summary`, which would put a database driver back
  // on this package's dependency graph. `full` stays the default here: switching
  // the generated tools to `table` is a separate, documented change (#299).
  format: z
    .enum(["full", "table", "summary"])
    .optional()
    .describe(
      "Result envelope. `full` (default) returns the bare rows; `table` wraps them with a " +
        "`meta` block; `summary` returns a bounded digest — top rows, a trend or merged " +
        "spatial clusters — with shares, caveats and a plain-language reading. Prefer " +
        "`summary` for a large result such as a heatmap or a long leaderboard.",
    ),
};

/**
 * Filters the collector declares **required** in its querystring schema, by
 * metric id. The registry records requiredness in prose (a `caveats` line) but
 * not as data, so the two exceptions are listed here; everything else is
 * optional. Path parameters are always required and are handled separately.
 *
 * Keep this in step with `oss/apps/collector-server/src/routes/query.ts`
 * (`funnelQueryParams.steps`, `meshUvHeatmapQueryParams.mesh`). Promoting it
 * into the registry itself is tracked as a follow-up.
 */
const REQUIRED_FILTERS: Readonly<Record<string, readonly FilterId[]>> = {
  funnel: ["steps"],
  mesh_uv_heatmap: ["mesh"],
  insight_baseline: ["metric"],
};

/**
 * Per-metric overrides of {@link FILTER_FIELDS}, for the one filter id whose
 * *type* depends on the metric that accepts it.
 *
 * `bucket` is a histogram bin width in FPS on `fps_histogram` and the time
 * grain (`day` | `hour`) on the insight primitives. Declaring a union in the
 * shared table would weaken `fps_histogram`'s advertised schema for no reason
 * and change bytes a shipped MCP client already validates against; an override
 * keeps every existing tool exactly as it was.
 */
const METRIC_FILTER_FIELDS: Readonly<Record<string, Partial<Record<FilterId, z.ZodType>>>> = {
  insight_baseline: {
    bucket: z
      .enum(["day", "hour"])
      .optional()
      .describe("Time grain of the series: `day` (default) or `hour`."),
  },
  insight_movers: {
    bucket: z
      .enum(["day", "hour"])
      .optional()
      .describe("Time grain of the series the spread is measured over: `day` (default) or `hour`."),
  },
};

/**
 * The **required** variant of each filter named in {@link REQUIRED_FILTERS} —
 * the same field without the trailing `.optional()`. Declared rather than
 * unwrapped so the shipped `steps` schema stays byte-identical.
 */
const REQUIRED_FILTER_FIELDS: Readonly<Partial<Record<FilterId, z.ZodType>>> = {
  steps,
  mesh: z.string().min(1).max(256).describe("The mesh/object name to bin. Required."),
  metric: z
    .string()
    .min(1)
    .max(64)
    .describe(
      "The registry metric to compute the baseline of. Required. Must be a comparable metric " +
        "with a portable bucket series; an id that has none is rejected with the list of ids " +
        "that do.",
    ),
};

/**
 * Argument name for a filter that travels in the **path** rather than the
 * querystring. The registry names such a parameter by the filter it binds
 * (`session`, `scene`); the shipped tools call them `sessionId` / `sceneId` and
 * those names are part of the public MCP contract, so they are preserved.
 */
const PATH_PARAM_ARG_NAMES: Readonly<Partial<Record<FilterId, string>>> = {
  session: "sessionId",
  scene: "sceneId",
};

/** The Zod field a path parameter contributes — always a required, non-empty id. */
const PATH_PARAM_FIELDS: Readonly<Partial<Record<FilterId, z.ZodType>>> = {
  session: z.string().min(1).describe("The session id to describe."),
  scene: z.string().min(1).describe("The scene id to fetch."),
};

// ---------------------------------------------------------------------------
// Generation
// ---------------------------------------------------------------------------

/** The field a metric contributes for one filter: required where the route says so. */
function filterField(metric: MetricDefinition, filter: FilterId): z.ZodType {
  if (REQUIRED_FILTERS[metric.id]?.includes(filter)) {
    const required = REQUIRED_FILTER_FIELDS[filter];
    if (!required) throw new Error(`no required field defined for filter '${filter}'`);
    return required;
  }
  return METRIC_FILTER_FIELDS[metric.id]?.[filter] ?? FILTER_FIELDS[filter];
}

/**
 * The row schema a tool advertises, built from the registry's `row`.
 *
 * Two deliberate relaxations, both driven by what the collector really returns:
 *
 * - **Every column is nullable.** An aggregate over a range with no matching
 *   samples projects SQL `NULL` for its measures (`resource_summary`,
 *   `perf_churn`, … over an empty window). The registry's row schema describes
 *   the populated shape; a consumer that validates the advertised JSON Schema
 *   strictly — the MCP SDK's client does, with Ajv — would otherwise reject a
 *   perfectly ordinary "no data yet" answer. The column set and its types stay
 *   exactly as the registry declares them.
 * - **Unknown columns are kept.** A few routes add a field of their own on top
 *   of the aggregation (the `*_stats` endpoints echo the resolved `cellSize`),
 *   and dropping it silently would be worse than passing it through.
 *
 * The schema still *coerces*: `@uptimizr/db` declares numeric columns with
 * `z.coerce.number()` because ClickHouse renders 64-bit integers as strings over
 * HTTP, so parsing a result with this schema normalises those strings to JSON
 * numbers (ADR 0051 §2). `@uptimizr/mcp` parses with it before sending
 * `structuredContent`, which is what makes the advertised schema true on every
 * store engine.
 */
function outputRowSchema(metric: MetricDefinition): z.ZodType {
  const shape: Record<string, z.ZodType> = {};
  for (const [column, field] of Object.entries(metric.row.shape)) {
    shape[column] = (field as z.ZodType).nullable();
  }
  return z.looseObject(shape);
}

/** `[":id"]` → the ordered `:param` placeholders of a Fastify path. */
function pathPlaceholders(path: string): string[] {
  return path
    .split("/")
    .filter((segment) => segment.startsWith(":"))
    .map((segment) => segment.slice(1));
}

/**
 * Compose the agent-facing tool description: what the metric measures, how to
 * read the result, and the caveats that decide how far to trust it. All three
 * come from the registry, so the prose an agent sees and the prose the docs and
 * the capabilities resource show are the same text.
 */
export function describeMetric(metric: MetricDefinition): string {
  const caveats = metric.caveats.map((caveat) => `- ${caveat}`).join("\n");
  return (
    `${metric.description}\n\n` +
    `How to read it: ${metric.interpretation}\n\n` +
    `Caveats:\n${caveats}`
  );
}

/** The value a validated argument contributes to the collector querystring. */
function toQueryValue(value: unknown): string | number | undefined {
  if (value == null) return undefined;
  if (typeof value === "number" || typeof value === "string") return value;
  // `groupByOrigin` is a boolean in the tool schema and `"true"`/`"false"` on
  // the wire (the collector's querystring enum).
  if (typeof value === "boolean") return String(value);
  return undefined;
}

/**
 * Build the {@link ReadTool} for one registry metric. Returns `undefined` for a
 * metric with no collector endpoint (the two daily rollups), which therefore
 * cannot be called by an agent.
 */
export function metricToTool(metric: MetricDefinition): ReadTool | undefined {
  const endpoint = metric.endpoint;
  if (!endpoint) return undefined;

  const pathParams = endpoint.pathParams ?? [];
  const placeholders = pathPlaceholders(endpoint.path);
  if (placeholders.length !== pathParams.length) {
    throw new Error(
      `metric ${metric.id}: endpoint path has ${placeholders.length} path parameter(s) but ` +
        `${pathParams.length} are declared`,
    );
  }

  // `:param` placeholder (positional) → the tool argument that fills it.
  const pathArgs = placeholders.map((placeholder, index) => {
    const filter = pathParams[index] as FilterId;
    const argName = PATH_PARAM_ARG_NAMES[filter];
    const field = PATH_PARAM_FIELDS[filter];
    if (!argName || !field) {
      throw new Error(`metric ${metric.id}: no tool argument defined for path filter '${filter}'`);
    }
    return { placeholder, argName, field };
  });

  const inputSchema: Record<string, z.ZodType> = {};
  for (const { argName, field } of pathArgs) inputSchema[argName] = field;
  for (const filter of metric.filters) inputSchema[filter] = filterField(metric, filter);

  // Every row of the collector's response, in one bounded envelope. A single
  // object result (a session descriptor, a one-row summary) is reported as a
  // one-element `rows` array so the envelope is the same for every tool.
  const outputSchema: Record<string, z.ZodType> = {
    rows: z
      .array(outputRowSchema(metric))
      .describe(`Result rows (one row per ${metric.grain}). A column is null when it has no data.`),
  };

  // The collector client strips a leading slash; keep paths root-relative so a
  // tool's `path` reads the same as it always has (`api/v1/...`).
  const template = endpoint.path.replace(/^\//, "");

  return {
    name: metric.id,
    title: metric.title,
    description: describeMetric(metric),
    inputSchema,
    outputSchema,
    buildRequest: (args: Record<string, unknown>): ReadToolRequest => {
      let path = template;
      for (const { placeholder, argName } of pathArgs) {
        const raw = args[argName];
        path = path.replace(
          `:${placeholder}`,
          encodeURIComponent(typeof raw === "string" ? raw : ""),
        );
      }
      const params: QueryParams = {};
      for (const filter of metric.filters) params[filter] = toQueryValue(args[filter]);
      return { path, params };
    },
  };
}

/**
 * Generate the read-only tool catalog from the metric registry: one tool per
 * registry entry that has a collector endpoint, in registry declaration order.
 *
 * Pure — it reads definitions only and never touches a collector — so the whole
 * catalog is unit-testable without a live server.
 */
export function registryToTools(
  metrics: readonly MetricDefinition[] = allMetrics(),
): readonly ReadTool[] {
  const tools: ReadTool[] = [];
  for (const metric of metrics) {
    const tool = metricToTool(metric);
    if (tool) tools.push(tool);
  }
  return tools;
}
