/**
 * Zod mirrors of the three result envelopes — **re-exported**, not redefined.
 *
 * The collector attaches each route's 200 response schema from the registry so
 * the Zod type provider **serialises through it** — which means the `table` and
 * `summary` envelopes need schemas too, or a formatted response would be
 * stripped down to nothing on its way out. `resultEnvelopeSchema(full, row)`
 * builds the union a formatted route responds with: the untouched `full` shape
 * first, so a default request is validated by exactly the schema it has always
 * been validated by, then the two envelopes.
 *
 * The definitions themselves now live in `@uptimizr/metrics`, next to the row
 * schemas they wrap (#350): `@uptimizr/agent-core` and `@uptimizr/mcp` need the
 * same shapes to describe a tool's result, and neither may depend on this
 * package — it carries the DuckDB driver. This module keeps the names and the
 * signatures `@uptimizr/db` has always exported, so nothing downstream changes.
 */

import { z } from "zod";
import {
  METRIC_IDS,
  resultEnvelopeSchema as envelopeSchema,
  resultFormatSchema,
  summaryEnvelopeSchema,
  tableEnvelopeSchema,
} from "@uptimizr/metrics";
import type { ResultFormat } from "./types.js";

export { resultFormatSchema };

/** Fails to compile if the schema and {@link ResultFormat} ever drift apart. */
type AssertFormatsAgree = [
  z.infer<typeof resultFormatSchema> extends ResultFormat ? true : never,
  ResultFormat extends z.infer<typeof resultFormatSchema> ? true : never,
];
export type ResultFormatsAgree = AssertFormatsAgree;

// --- shapes the compare / explain envelopes below are built from -----------
//
// The four `format` digests moved to `@uptimizr/metrics` with #350 and are
// re-exported above. These five fragments stayed behind because only the
// DSL-specific envelopes at the bottom of this file use them, and a comparison
// is not something `@uptimizr/metrics` describes.

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

const measureSchema = z
  .object({
    column: z.string(),
    unit: z.string().nullable(),
    additive: z.boolean(),
  })
  .nullable();

/** `format=summary`: one of the four grain-driven shapes. */
export const resultSummarySchema = summaryEnvelopeSchema;

/** `format=table`: the `meta` envelope around a metric's own row schema. */
export function tableResultSchema(row: z.ZodType): z.ZodObject {
  return tableEnvelopeSchema(row);
}

/**
 * The 200 response schema of a route that honours `format`: the union of the
 * three envelopes.
 *
 * Order matters. `full` is first, so a default request is parsed by precisely
 * the schema it was parsed by before this existed and its bytes cannot drift.
 * The envelopes are unambiguous against it — `table` is an object with `meta`
 * and `rows`, `summary` an object with `kind` and `reading`, and neither can
 * satisfy a row array or a stats row's required numeric columns.
 *
 * A route's own `full` schema is passed explicitly because a single-record
 * endpoint (the spatial `stats` routes) answers with a bare object rather than
 * an array of rows.
 */
export function resultEnvelopeSchema(full: z.ZodType, row: z.ZodType): z.ZodType {
  return envelopeSchema(row, full);
}

// --- compare / explain (ADR 0051 §3, #304) --------------------------------

const scoreIntervalSchema = z.object({ low: z.number(), high: z.number() });

const proportionSignificanceSchema = z.object({
  test: z.literal("two-proportion-z"),
  current: z.number(),
  previous: z.number(),
  diff: z.number(),
  z: z.number(),
  pValue: z.number(),
  significant: z.boolean(),
  currentInterval: scoreIntervalSchema,
  previousInterval: scoreIntervalSchema,
});

const meanSignificanceSchema = z.object({
  test: z.literal("welch-t"),
  current: z.number(),
  previous: z.number(),
  diff: z.number(),
  t: z.number(),
  df: z.number(),
  pValue: z.number(),
  significant: z.boolean(),
  currentSamples: z.number().int(),
  previousSamples: z.number().int(),
});

const significanceSchema = z.discriminatedUnion("test", [
  proportionSignificanceSchema,
  meanSignificanceSchema,
]);

const comparisonSideSchema = z.object({
  range: rangeSchema,
  segment: filtersSchema,
  rows: z.number().int(),
  total: z.number().nullable(),
  sampleSize: sampleSizeSchema,
});

const comparisonRowSchema = z.object({
  key: z.record(z.string(), z.string()),
  label: z.string(),
  current: z.number().nullable(),
  previous: z.number().nullable(),
  delta: z.number().nullable(),
  deltaPct: z.number().nullable(),
  significance: significanceSchema.optional(),
});

/** `format=full | table` on a `compare` query: the envelope plus joined rows. */
export const comparisonResultSchema = z.object({
  meta: z.object({
    metric: metricIdSchema,
    basis: z.enum(["range", "segment"]),
    keys: z.array(z.string()),
    measure: measureSchema,
    current: comparisonSideSchema,
    previous: comparisonSideSchema,
    rows: z.number().int(),
    truncated: z.boolean(),
    overall: meanSignificanceSchema.optional(),
    caveats: z.array(z.string()),
  }),
  rows: z.array(comparisonRowSchema),
});

/** `format=summary` on a `compare` query: the biggest movers, with a reading. */
export const moversSummarySchema = z.object({
  kind: z.literal("movers"),
  metric: metricIdSchema,
  basis: z.enum(["range", "segment"]),
  measure: measureSchema,
  current: comparisonSideSchema,
  previous: comparisonSideSchema,
  top: z.array(comparisonRowSchema),
  rest: z.object({ rows: z.number().int(), delta: z.number().nullable() }),
  overall: meanSignificanceSchema.optional(),
  reading: z.string(),
  caveats: z.array(z.string()),
});

/**
 * `explain: true`: the plan instead of the rows.
 *
 * `params` carries names and logical types only — never values. That is not a
 * redaction step applied afterwards; the DSL binds every caller-supplied value,
 * so there is nothing in `sql` to redact and nothing in `params` worth echoing.
 */
export const queryPlanSchema = z.object({
  metric: metricIdSchema,
  tier: z.enum(["delegated", "generic"]),
  dialect: z.string(),
  sql: z.string(),
  params: z.array(z.object({ name: z.string(), type: z.string() })),
  rowsScanned: z.number().nullable(),
  sampleSize: sampleSizeSchema,
  warnings: z.array(z.string()),
});

/**
 * The 200 response schema of the query DSL endpoint: everything
 * {@link resultEnvelopeSchema} answers with, plus the three envelopes only the
 * DSL can produce — a comparison, a movers digest and a plan.
 *
 * Order matters for the same reason it does there: the plain-rows shape is
 * matched first so a `format=full` response cannot be reshaped on its way out.
 */
export function queryEnvelopeSchema(full: z.ZodType, row: z.ZodType): z.ZodType {
  return z.union([
    full,
    tableResultSchema(row),
    resultSummarySchema,
    comparisonResultSchema,
    moversSummarySchema,
    queryPlanSchema,
  ]);
}
