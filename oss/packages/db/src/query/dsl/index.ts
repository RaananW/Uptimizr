/**
 * The query DSL's compilation tiers (ADR 0051 §3, design sketch §C.2), and the
 * four pure layers that sit on top of them.
 *
 * - **delegated** (`compile.ts`) — a validated `queryV1` document is mapped onto
 *   the metric's existing aggregation builder, so every metric is reachable at
 *   exactly the power its canned endpoint has.
 * - **generic** (`generic.ts`) — a metric that declares `genericGroupBy` is
 *   recomputed at any grain it declares, by one shared dialect-authored builder.
 *
 * On top: `compare.ts` joins two runs of the same spec, `significance.ts` says
 * whether the difference is real, `explain.ts` renders the plan and the reasons
 * not to trust it, and `order.ts` re-sorts a delegated result honestly. All four
 * are pure — rows in, rows out — and none of them runs a query.
 */

export { builderFor } from "./builders.js";
export type { AggregationBuilder } from "./builders.js";
export { cameraTypeForMode, compileMetric, compileQuery, toBuilderOptions } from "./compile.js";
export type { MetricQueryOptions, QueryResolution } from "./compile.js";
export { buildGenericGroupBy, genericResultColumns } from "./generic.js";
export type { GenericDeviceFilter, GenericEventPredicate, GenericQueryOptions } from "./generic.js";
export { compareRows, comparisonKeys, summarizeComparison } from "./compare.js";
export type {
  ComparisonBasis,
  ComparisonContext,
  ComparisonMeta,
  ComparisonResult,
  ComparisonRow,
  ComparisonSide,
  MoversSummary,
} from "./compare.js";
export {
  DEFAULT_ALPHA,
  normalCdf,
  sampleOf,
  studentTTwoSided,
  twoProportionZ,
  welchT,
  wilsonScoreInterval,
} from "./significance.js";
export type {
  MeanSignificance,
  Proportion,
  ProportionSignificance,
  Sample,
  ScoreInterval,
  Significance,
} from "./significance.js";
export { channelRows, explainQuery, explainSpec, planWarnings, silentChannels } from "./explain.js";
export type { ExplainParam, ExplainParamType, PlanContext, QueryPlan } from "./explain.js";
export { ORDER_AFTER_CAP_CAVEAT, applyOrder, reordersCappedResult } from "./order.js";
export type { ResultOrder } from "./order.js";
