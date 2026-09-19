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

// --- significance / scene health (#307) ------------------------------------

export { BUCKET_MEASURE_VARIANTS, bucketVariantFor, resolveBucketMeasure } from "./measures.js";
export type { BucketVariant } from "./measures.js";

export {
  SIGNIFICANCE_ALPHA,
  SIGNIFICANCE_PRECISION,
  Z_80,
  binomialCdf,
  computeSignificance,
  newcombeDifferenceInterval,
  normalCdf,
  normalTwoSidedP,
  poissonRateTest,
  regularizedIncompleteBeta,
  studentTCritical,
  studentTwoSidedP,
  twoProportionTest,
  welchTest,
  wilsonBounds,
} from "./significance.js";
export type {
  SignificanceArm,
  SignificanceInput,
  SignificanceRow,
  SignificanceTest,
} from "./significance.js";

export {
  HEALTH_DEFAULT_SCENES,
  HEALTH_DEFAULT_WEIGHTS,
  HEALTH_DEFAULT_WINDOW_DAYS,
  HEALTH_FACTORS,
  HEALTH_FACTOR_IDS,
  HEALTH_MAX_SCENES,
  HEALTH_MIN_SESSIONS,
  HEALTH_PRECISION,
  HEALTH_Z_SPAN,
  computeSceneHealth,
  normaliseFactor,
  rankSceneHealth,
  resolveHealthWindows,
  resolveWeights,
} from "./health.js";
export type {
  HealthFactorInput,
  HealthFactorRow,
  HealthFactorSpec,
  HealthSeries,
  SceneHealthRow,
} from "./health.js";
