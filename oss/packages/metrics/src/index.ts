/**
 * `@uptimizr/metrics` — the semantic metric registry (ADR 0051 §1).
 *
 * One machine-readable {@link MetricDefinition} per Uptimizr analytics metric:
 * what it measures, the collector endpoint that serves it, the filters it
 * accepts, the Zod schema of one row, per-column units and semantics, row
 * limits, how to read the result, and what not to trust. Everything that used to
 * restate the query surface by hand — the agent tool catalog
 * (`@uptimizr/agent-core`), the MCP capabilities resource and the OpenAPI
 * document, the docs tables — is **derived** from this package, so coverage
 * cannot drift.
 *
 * **Dependency-free and browser-safe.** The only runtime dependencies are `zod`
 * and `@uptimizr/schema` (a type-only import). No `node:` built-in, no DOM, no
 * database driver: the registry used to live in `@uptimizr/db`, which depends on
 * the ~37 MB `@duckdb/node-api` native binding that a browser bundle or an `npx`
 * MCP client can never use.
 *
 * ```ts
 * import { allMetrics, getMetric } from "@uptimizr/metrics";
 *
 * const metric = getMetric("top_meshes");
 * metric?.endpoint?.path; // "/api/v1/meshes/top"
 * metric?.row; // z.ZodObject — the shape of one row
 * ```
 */

export {
  AGGREGATION_BUILDER_NAMES,
  DIMENSION_COLUMNS,
  DIMENSION_ROW_COLUMNS,
  FILTER_TARGETS,
  GENERIC_DIMENSIONS,
  METRIC_BY_BUILDER,
  METRIC_IDS,
  METRIC_REGISTRY,
  allMetrics,
  getMetric,
  isMetricId,
  isResourceMetric,
  metricForBuilder,
} from "./registry.js";

// --- Query DSL validation (ADR 0051 §3) ---
// The registry half of validating a `queryV1` document: `@uptimizr/schema`
// checks the shape, this checks the vocabulary.
export {
  REQUIRED_FILTERS,
  dimensionColumn,
  genericDimensions,
  nativeDimensions,
  orderableColumns,
  queryTier,
  queryableFilters,
  requiredFilters,
  segmentableDimensions,
  validateQuery,
} from "./query.js";
export type { QueryIssue, QueryIssueCode, QueryTier, QueryValidation } from "./query.js";

export type {
  AggregationBuilderName,
  ColumnSemantics,
  ColumnUnit,
  DimensionId,
  FilterId,
  FilterOptionInterface,
  FilterTarget,
  GenericGroupBy,
  GenericMeasure,
  GenericMeasureKind,
  GenericScope,
  MetricCategory,
  MetricComparison,
  MetricDefinition,
  MetricEndpoint,
  MetricGrain,
  MetricId,
  MetricRegistry,
  NoUnregisteredAggregations,
  UnregisteredAggregation,
} from "./registry.js";

// --- Result envelopes (ADR 0051 §2) ---
// The Zod mirrors of `format=full | table | summary`. They live here, next to
// the row schemas they wrap, so the collector (`@uptimizr/db`), the generated
// tool catalog (`@uptimizr/agent-core`) and the MCP server can all describe the
// same three shapes without any of them depending on the others. The summariser
// that *builds* an envelope stays in `@uptimizr/db/summary` (#337).
export {
  resultEnvelopeSchema,
  resultFormatSchema,
  structuredEnvelopeSchema,
  summaryEnvelopeSchema,
  tableEnvelopeSchema,
  tableMetaSchema,
} from "./envelopes.js";
