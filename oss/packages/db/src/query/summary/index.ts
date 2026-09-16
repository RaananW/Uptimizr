/**
 * `format=table | summary` result envelopes (ADR 0051 §2, design sketch §B.1).
 *
 * Pure, registry-driven and browser-safe — no store, no I/O, no `node:` import —
 * so the same code shapes a collector response, a CLI result and (eventually) an
 * in-browser demo store's output. Re-exported from both `@uptimizr/db` and the
 * browser-safe `@uptimizr/db/query` subpath.
 */

export { summarizeRows, tableResult } from "./summarize.js";
export type { ResultRow } from "./summarize.js";
export { clusterCells } from "./cluster.js";
export type { ClusterOptions, ClusterResult, GridCell } from "./cluster.js";
export { wilsonInterval, leastSquaresSlope, trendOf, Z_95 } from "./stats.js";
export { sampleSizeOf } from "./columns.js";
export { isAdditiveUnit } from "./format.js";
export { RESULT_FORMATS } from "./types.js";
export type {
  AppliedFilters,
  ClusterRest,
  ClusterSummary,
  DrillHints,
  RankedRow,
  RankedSummary,
  RecordSummary,
  ResolvedRate,
  RestBucket,
  ResultFormat,
  ResultLimits,
  ResultRange,
  ResultSummary,
  SampleSize,
  SeriesDigest,
  SeriesSummary,
  ShareInterval,
  SpatialCluster,
  SummaryBase,
  SummaryConfidence,
  SummaryContext,
  SummaryMeasure,
  TableMeta,
  TableResult,
  TrendDirection,
} from "./types.js";
export {
  resultEnvelopeSchema,
  resultFormatSchema,
  resultSummarySchema,
  tableResultSchema,
} from "./schema.js";
