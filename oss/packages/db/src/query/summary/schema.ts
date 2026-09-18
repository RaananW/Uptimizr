/**
 * Zod mirrors of the three result envelopes.
 *
 * The collector attaches each route's 200 response schema from the registry so
 * the Zod type provider **serialises through it** — which means the `table` and
 * `summary` envelopes need schemas too, or a formatted response would be
 * stripped down to nothing on its way out. `resultEnvelopeSchema(row)` builds
 * the union a formatted route responds with: the untouched `full` shape first,
 * so a default request is validated by exactly the schema it has always been
 * validated by, then the two envelopes.
 *
 * These live next to the types rather than in the collector so the shapes have
 * one definition — the same reason the row schemas live in the registry.
 */

import { z } from "zod";
import { METRIC_IDS } from "@uptimizr/metrics";
import type { ResultFormat } from "./types.js";

/**
 * `format=full | table | summary`, the shared querystring value every
 * registry-served aggregate endpoint accepts. Spelled out literally rather than
 * built from `RESULT_FORMATS` so the inferred type is the `ResultFormat` union
 * and a route handler keeps its narrowing.
 */
export const resultFormatSchema = z.enum(["full", "table", "summary"]);

/** Fails to compile if the schema and {@link ResultFormat} ever drift apart. */
type AssertFormatsAgree = [
  z.infer<typeof resultFormatSchema> extends ResultFormat ? true : never,
  ResultFormat extends z.infer<typeof resultFormatSchema> ? true : never,
];
export type ResultFormatsAgree = AssertFormatsAgree;

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
  top: z.array(
    z.object({
      label: z.string(),
      value: z.number().nullable(),
      share: z.number().nullable(),
      shareInterval: shareIntervalSchema.optional(),
      drill: drillSchema.optional(),
    }),
  ),
  rest: restSchema,
});

const seriesSummarySchema = z.object({
  ...summaryBase,
  kind: z.literal("series"),
  series: z.object({
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
  }),
});

const clusterSummarySchema = z.object({
  ...summaryBase,
  kind: z.literal("clusters"),
  axes: z.array(z.string()),
  occupiedCells: z.number().int(),
  densityThreshold: z.number(),
  clusters: z.array(
    z.object({
      centroid: z.array(z.number()),
      extent: z.object({ min: z.array(z.number()), max: z.array(z.number()) }),
      cells: z.number().int(),
      weight: z.number(),
      share: z.number().nullable(),
      drill: drillSchema.optional(),
      // Spatial labelling (ADR 0051 §2 / sketch §B.2). Optional as a group: a
      // labelled cluster carries all four, and they are absent entirely when
      // the grid is not world-space (viewport bins, view-direction angles) or
      // the request selected no scene. `null` inside the group is meaningful —
      // "the scene was checked and nothing contains this hotspot".
      region: z.string().nullable().optional(),
      regions: z.array(z.string()).optional(),
      nearestMesh: z.string().nullable().optional(),
      distance: z.number().nullable().optional(),
    }),
  ),
  rest: z.object({
    clusters: z.number().int(),
    cells: z.number().int(),
    weight: z.number().nullable(),
    share: z.number().nullable(),
  }),
});

const recordSummarySchema = z.object({
  ...summaryBase,
  kind: z.literal("record"),
  record: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()])),
  rates: z.record(
    z.string(),
    z.object({
      value: z.number().nullable(),
      numerator: z.string(),
      denominator: z.string(),
    }),
  ),
});

/** `format=summary`: one of the four grain-driven shapes. */
export const resultSummarySchema = z.discriminatedUnion("kind", [
  rankedSummarySchema,
  seriesSummarySchema,
  clusterSummarySchema,
  recordSummarySchema,
]);

/** `format=table`: the `meta` envelope around a metric's own row schema. */
export function tableResultSchema(row: z.ZodType): z.ZodObject {
  return z.object({
    meta: z.object({
      metric: metricIdSchema,
      range: rangeSchema,
      filters: filtersSchema,
      sampleSize: sampleSizeSchema,
      rows: z.number().int(),
      truncated: z.boolean(),
      limits: limitsSchema,
    }),
    rows: z.array(row),
  });
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
 */
export function resultEnvelopeSchema(full: z.ZodType, row: z.ZodType): z.ZodType {
  return z.union([full, tableResultSchema(row), resultSummarySchema]);
}
