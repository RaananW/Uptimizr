/**
 * The query DSL's compilation tier (ADR 0051 §3, design sketch §C.2).
 *
 * v1 is **delegated only**: a validated `queryV1` document is mapped onto the
 * metric's existing aggregation builder. The generic group-by tier, `compare`
 * and `explain` land in #304.
 */

export { builderFor } from "./builders.js";
export type { AggregationBuilder } from "./builders.js";
export { cameraTypeForMode, compileMetric, compileQuery, toBuilderOptions } from "./compile.js";
export type { MetricQueryOptions, QueryResolution } from "./compile.js";
