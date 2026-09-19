/**
 * **Insight primitives** — `baseline` and `movers` (ADR 0051 §4, sketch §D).
 *
 * The shape of this directory is the design:
 *
 * - `measures.ts` declares, per comparable registry metric, how its primary
 *   column is reproduced as a per-bucket series;
 * - `buckets.ts` renders exactly one generic, dialect-agnostic query from that
 *   declaration (parity-tested on DuckDB, ClickHouse, Postgres and SQL Server);
 * - `stats.ts`, `baseline.ts`, `movers.ts` and `windows.ts` are **pure
 *   TypeScript** over the rows that query returns — no SQL, no I/O, no dialect.
 *
 * Statistics never run in SQL. Five engines disagree about `quantile`, `median`
 * and `stddev`, and an insight that changes when a self-hoster switches store is
 * not an insight. `anomalies`, `significance` and `scene_health` (ADR 0051 §4)
 * are designed to slot in here the same way: a new pure module over the same
 * bucket series, with no new per-dialect SQL.
 */

export {
  BUCKETABLE_METRIC_IDS,
  BUCKET_MEASURES,
  BUCKET_SECONDS,
  MOVERS_DEFAULT_METRICS,
  MOVERS_MAX_METRICS,
  bucketMeasureFor,
  isBucketGrain,
  isBucketableMetric,
} from "./measures.js";
export type {
  BucketAggregate,
  BucketGrain,
  BucketMeasure,
  BucketPredicate,
  BucketRollup,
  BucketValueColumn,
} from "./measures.js";

export { buildMetricBuckets, toMetricBucketRows } from "./buckets.js";
export type { MetricBucketOptions, MetricBucketRow } from "./buckets.js";

export { evaluateBucketMeasure } from "./evaluate.js";
export type { BucketEventLike, EvaluateBucketOptions } from "./evaluate.js";

export { BASELINE_PRECISION, computeBaseline } from "./baseline.js";
export type { BaselineRow } from "./baseline.js";

export {
  MIN_SPREAD_FRACTION,
  MOVERS_PRECISION,
  computeMover,
  rankMovers,
  referenceSpread,
  rollupWindow,
} from "./movers.js";
export type { MoverInput, MoverRow } from "./movers.js";

export {
  MAD_TO_SIGMA,
  ROBUST_Z_EPSILON,
  leastSquaresSlope,
  mean,
  median,
  medianAbsoluteDeviation,
  quantile,
  relativeChange,
  robustZ,
  round,
  sum,
  trendOf,
} from "./stats.js";

export {
  DAY_MS,
  DEFAULT_BASELINE_WINDOW_DAYS,
  DEFAULT_MOVERS_RANGE_DAYS,
  MAX_BASELINE_WINDOW_DAYS,
  floorToBucket,
  inWindow,
  resolveBaselineWindow,
  resolveMoversWindows,
  spanningWindow,
} from "./windows.js";
export type { ResolvedWindow } from "./windows.js";

// --- anomalies (#306) ------------------------------------------------------
// The third insight primitive: which *bucket* was abnormal, in what way, and
// which dimension value inside the metric accounts for it. Two pure modules over
// the same bucket series — `changepoint.ts` holds the generic algorithms,
// `anomalies.ts` the primitive itself. The only new store-facing surface is the
// optional `groupBy` on `buildMetricBuckets`, exported above.
export {
  ANOMALY_MAX_CONTRIBUTOR_SCANS,
  ANOMALY_MIN_TRAILING,
  ANOMALY_PRECISION,
  ANOMALY_TRAILING_BUCKETS,
  DEFAULT_ANOMALY_SENSITIVITY,
  MAX_ANOMALY_SENSITIVITY,
  MIN_ANOMALY_SENSITIVITY,
  attributeContributor,
  clampSensitivity,
  contributorDimensionFor,
  contributorWindows,
  detectAnomalies,
  inContributorWindow,
} from "./anomalies.js";
export type {
  AnomalyContributor,
  AnomalyKind,
  AnomalyRow,
  AnomalyWindow,
  DetectAnomaliesOptions,
} from "./anomalies.js";

export {
  CUSUM_DECISION_FACTOR,
  CUSUM_SLACK,
  cusumChangePoints,
  rollingRobustStats,
} from "./changepoint.js";
export type { ChangePoint, RollingRobustPoint } from "./changepoint.js";

export { byBucketThenDimension } from "./buckets.js";
export { BUCKET_SPLIT_COLUMNS, isBucketSplitDimension } from "./measures.js";
export type { BucketSplitDimension } from "./measures.js";
