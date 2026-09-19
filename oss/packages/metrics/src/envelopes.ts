/**
 * Zod mirrors of the three result envelopes (ADR 0051 §2, design sketch §B.1).
 *
 * `format=full | table | summary` is the shared querystring of every
 * registry-served aggregate endpoint, and the same three shapes are what an
 * agent gets back through MCP. They are described **here**, next to the row
 * schemas they wrap, because three different packages need them and none of
 * them may depend on the others:
 *
 * - `@uptimizr/db` attaches each route's 200 response schema from the registry,
 *   so the collector's Zod type provider serialises a formatted response
 *   *through* one of these — without them a `table` or `summary` response would
 *   be stripped to nothing on its way out. `@uptimizr/db/summary` re-exports
 *   every schema below under its established names, so that package's public
 *   API is unchanged.
 * - `@uptimizr/agent-core` derives each generated tool's `outputSchema` from
 *   them, and `@uptimizr/mcp` validates `structuredContent` with them. Neither
 *   package may depend on `@uptimizr/db` (it carries a ~37 MB DuckDB binding;
 *   `dependencies.test.ts` in both packages fails if it reappears) — which is
 *   exactly why the *pure* schemas live in this dependency-free package.
 *
 * Only the schemas moved. The summariser that *builds* an envelope
 * (`summarizeRows`, `tableResult`, `clusterCells`, …) is still
 * `@uptimizr/db/summary`'s; relocating it is #337.
 */

import { z } from "zod";
import { METRIC_IDS } from "./registry.js";

/**
 * `format=full | table | summary`, the shared querystring value every
 * registry-served aggregate endpoint accepts. Spelled out literally rather than
 * built from a `RESULT_FORMATS` array so the inferred type is the string union
 * itself and a route handler keeps its narrowing.
 */
export const resultFormatSchema = z.enum(["full", "table", "summary"]);

/** Any registry metric id. */
const metricIdSchema = z.enum(METRIC_IDS as unknown as [string, ...string[]]);

const rangeSchema = z.object({
  since: z.number().nullable(),
  until: z.number().nullable(),
});

/** Applied filter values are whatever the route's own schema produced. */
const filtersSchema = z.record(z.string(), z.unknown());

const sampleSizeSchema = z.object({
  sessions: z.number().nullable(),
  events: z.number().nullable(),
});

const limitsSchema = z.object({
  maxRows: z.number().int(),
  maxSummaryRows: z.number().int(),
});

const measureSchema = z
  .object({
    column: z.string(),
    unit: z.string().nullable(),
    additive: z.boolean(),
  })
  .nullable();

const shareIntervalSchema = z.object({ low: z.number(), high: z.number() });

const confidenceSchema = z.object({
  kind: z.literal("wilson"),
  level: z.number(),
  note: z.string(),
});

const drillSchema = z.record(z.string(), z.string());

const restSchema = z.object({
  rows: z.number().int(),
  value: z.number().nullable(),
  share: z.number().nullable(),
});

const clusterRestSchema = z.object({
  clusters: z.number().int(),
  cells: z.number().int(),
  weight: z.number().nullable(),
  share: z.number().nullable(),
});

const rankedRowSchema = z.object({
  label: z.string(),
  value: z.number().nullable(),
  share: z.number().nullable(),
  shareInterval: shareIntervalSchema.optional(),
  drill: drillSchema.optional(),
});

const seriesDigestSchema = z.object({
  axis: z.string(),
  points: z.number().int(),
  first: z.number().nullable(),
  last: z.number().nullable(),
  min: z.number().nullable(),
  max: z.number().nullable(),
  firstLabel: z.string().nullable(),
  lastLabel: z.string().nullable(),
  minLabel: z.string().nullable(),
  maxLabel: z.string().nullable(),
  trend: z.enum(["up", "down", "flat"]),
  slope: z.number().nullable(),
});

const spatialClusterSchema = z.object({
  centroid: z.array(z.number()),
  extent: z.object({ min: z.array(z.number()), max: z.array(z.number()) }),
  cells: z.number().int(),
  weight: z.number(),
  share: z.number().nullable(),
  drill: drillSchema.optional(),
  // Spatial labelling (ADR 0051 §2 / sketch §B.2, #302). Optional as a group: a
  // labelled cluster carries all four; they are absent entirely when the grid is
  // not world-space or the request selected no scene. `null` inside the group
  // means "the scene was checked and nothing contains this hotspot".
  region: z.string().nullable().optional(),
  regions: z.array(z.string()).optional(),
  nearestMesh: z.string().nullable().optional(),
  distance: z.number().nullable().optional(),
});

const recordValueSchema = z.record(
  z.string(),
  z.union([z.string(), z.number(), z.boolean(), z.null()]),
);

const ratesSchema = z.record(
  z.string(),
  z.object({
    value: z.number().nullable(),
    numerator: z.string(),
    denominator: z.string(),
  }),
);

/** Fields every summary carries, whatever its grain. */
const summaryBase = {
  metric: metricIdSchema,
  range: rangeSchema,
  filters: filtersSchema,
  sampleSize: sampleSizeSchema,
  total: z.number().nullable(),
  measure: measureSchema,
  confidence: confidenceSchema.optional(),
  reading: z.string(),
  caveats: z.array(z.string()),
};

const rankedSummarySchema = z.object({
  ...summaryBase,
  kind: z.literal("ranked"),
  top: z.array(rankedRowSchema),
  rest: restSchema,
});

const seriesSummarySchema = z.object({
  ...summaryBase,
  kind: z.literal("series"),
  series: seriesDigestSchema,
});

const clusterSummarySchema = z.object({
  ...summaryBase,
  kind: z.literal("clusters"),
  axes: z.array(z.string()),
  occupiedCells: z.number().int(),
  densityThreshold: z.number(),
  clusters: z.array(spatialClusterSchema),
  rest: clusterRestSchema,
});

const recordSummarySchema = z.object({
  ...summaryBase,
  kind: z.literal("record"),
  record: recordValueSchema,
  rates: ratesSchema,
});

/** `format=summary`: one of the four grain-driven shapes. */
export const summaryEnvelopeSchema = z.discriminatedUnion("kind", [
  rankedSummarySchema,
  seriesSummarySchema,
  clusterSummarySchema,
  recordSummarySchema,
]);

/** The `meta` block `format=table` wraps a metric's rows in. */
export const tableMetaSchema = z.object({
  metric: metricIdSchema,
  range: rangeSchema,
  filters: filtersSchema,
  sampleSize: sampleSizeSchema,
  rows: z.number().int(),
  truncated: z.boolean(),
  limits: limitsSchema,
});

/** `format=table`: the `meta` envelope around a metric's own row schema. */
export function tableEnvelopeSchema(row: z.ZodType): z.ZodObject {
  return z.object({
    meta: tableMetaSchema,
    rows: z.array(row),
  });
}

/**
 * The result a caller gets from a surface that honours `format`: the union of
 * the three envelopes.
 *
 * Order matters. The `full` shape is first, so a default request is parsed by
 * precisely the schema it was parsed by before this existed and its bytes
 * cannot drift. The envelopes are unambiguous against it — `table` is an object
 * with `meta` and `rows`, `summary` an object with `kind` and `reading`, and
 * neither can satisfy a row array or a stats row's required numeric columns.
 *
 * `full` defaults to a plain array of `row`, which is what an agent-facing
 * caller wants; the collector passes its own route-level 200 schema instead,
 * because a single-record route (the spatial `stats` endpoints) answers with a
 * bare object rather than an array.
 */
export function resultEnvelopeSchema(row: z.ZodType, full: z.ZodType = z.array(row)): z.ZodType {
  return z.union([full, tableEnvelopeSchema(row), summaryEnvelopeSchema]);
}

/**
 * The **object** form of {@link resultEnvelopeSchema}, for a tool that must
 * advertise its result as a single JSON Schema object — which is what MCP's
 * `outputSchema` is: a `type: "object"` schema the SDK validates
 * `structuredContent` against, on the server with Zod and again on the client
 * with Ajv.
 *
 * A top-level `z.union` cannot be used there. The MCP TypeScript SDK normalises
 * an output schema to an object schema and **silently drops** anything that is
 * not one (`normalizeObjectSchema` returns `undefined` for a union), so
 * `tools/list` would advertise no output schema at all and every call would then
 * fail validation — worse than the bug this replaces. So the three envelopes are
 * merged into one loose object whose every key is optional:
 *
 * - `rows` — `format=full` (wrapped as `{ rows }` by the MCP server, so a
 *   single-record read looks like every other) and the rows of `format=table`.
 *   Its element schema stays the metric's own, so a column that is out of
 *   contract is still reported by name.
 * - `meta` — only `format=table` carries it.
 * - `kind` and the summary fields — only `format=summary` carries them, and
 *   `kind` says which grain-specific fields (`top`, `series`, `clusters`,
 *   `record`) came with it.
 *
 * The object is deliberately *loose*: an envelope key a newer collector adds is
 * passed through rather than dropped. Callers that can express a union — a
 * collector route's response schema, a test — should use
 * {@link resultEnvelopeSchema}, which discriminates strictly.
 */
export function structuredEnvelopeSchema(row: z.ZodType, metric?: string): z.ZodObject {
  // A tool answers for exactly one metric, so naming it collapses two copies
  // of the 69-value registry enum (~2.7 kB per tool in `tools/list`) into a
  // literal — smaller *and* more precise. Omitted, the enum stands.
  const id = metric == null ? metricIdSchema : z.literal(metric);
  return z.looseObject({
    rows: z
      .array(row)
      .optional()
      .describe("`format=full` and `format=table`: the result rows. Absent from a summary."),
    meta: (metric == null ? tableMetaSchema : tableMetaSchema.extend({ metric: id }))
      .optional()
      .describe("`format=table` only: metric, range, applied filters, row count, caps."),
    kind: z
      .enum(["ranked", "series", "clusters", "record"])
      .optional()
      .describe("`format=summary` only: which digest this is."),
    metric: id.optional().describe("`format=summary` only: the metric summarised."),
    range: rangeSchema.optional(),
    filters: filtersSchema.optional(),
    sampleSize: sampleSizeSchema.optional(),
    total: z.number().nullable().optional(),
    measure: measureSchema.optional(),
    confidence: confidenceSchema.optional(),
    reading: z
      .string()
      .optional()
      .describe("`format=summary` only: one plain-language sentence, templated — never written."),
    caveats: z.array(z.string()).optional(),
    top: z.array(rankedRowSchema).optional().describe('`kind: "ranked"`: the leading rows.'),
    rest: z
      .looseObject({
        rows: z.number().int().optional(),
        clusters: z.number().int().optional(),
        cells: z.number().int().optional(),
        value: z.number().nullable().optional(),
        weight: z.number().nullable().optional(),
        share: z.number().nullable().optional(),
      })
      .optional()
      .describe(
        "What the digest did not list individually: `rows`/`value` for a ranked digest, " +
          "`clusters`/`cells`/`weight` for a spatial one.",
      ),
    series: seriesDigestSchema.optional().describe('`kind: "series"`: the per-bucket digest.'),
    axes: z.array(z.string()).optional(),
    occupiedCells: z.number().int().optional(),
    densityThreshold: z.number().optional(),
    clusters: z
      .array(spatialClusterSchema)
      .optional()
      .describe('`kind: "clusters"`: merged spatial hotspots.'),
    record: recordValueSchema.optional().describe('`kind: "record"`: the single row itself.'),
    rates: ratesSchema.optional(),
  });
}
