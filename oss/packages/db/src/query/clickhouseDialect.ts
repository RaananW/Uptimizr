/**
 * ClickHouse dialect for the query layer (ADR 0020).
 *
 * ClickHouse is the optional single-tenant scale engine: a columnar, concurrent
 * store for self-hosters who outgrow DuckDB's single-writer file. This dialect
 * renders the engine-specific fragments of each shared aggregation
 * (`aggregations.ts`) to ClickHouse SQL, so the bulk of every query stays shared
 * with DuckDB.
 *
 * Like the DuckDB dialect, it is *single-tenant* — it carries no
 * `org_id`/tenant-isolation concerns — which keeps it relocatable across the
 * open-core boundary.
 *
 * Binding model: parameters are emitted as ClickHouse typed placeholders
 * (`{name:Type}`) and supplied to `@clickhouse/client` as a `query_params`
 * record. Timestamp params are bound as naive-UTC `DateTime64(3)` strings (see
 * {@link toClickhouseTimestamp}); DuckDB binds the same literal form, so both
 * engines order and bucket time identically.
 *
 * Rollup note: the single-tenant store exposes the daily rollups as plain
 * ClickHouse views (not `AggregatingMergeTree` materialized views — those are
 * the scale tier), pre-grouped by `(project_id, …, day)`. Each read GROUP BY
 * therefore sees one source row per group, so the `-Merge` combinators reduce to
 * a plain pass-through aggregate of the precomputed value, mirroring the DuckDB
 * view strategy.
 */

import type { Dialect, ParamType } from "./dialect.js";

/** Map a logical {@link ParamType} to its ClickHouse parameter type name. */
function chParamType(type: ParamType): string {
  switch (type) {
    case "string":
      return "String";
    case "u32":
      return "UInt32";
    case "f64":
      return "Float64";
    case "timestamp":
      return "DateTime64(3)";
    case "date":
      return "Date";
  }
}

/**
 * Format an epoch-millisecond timestamp as a naive-UTC `YYYY-MM-DD HH:MM:SS.mmm`
 * string for binding to a ClickHouse `DateTime64(3)` column/param. Mirrors the
 * DuckDB `TIMESTAMP` literal format so both stores order and bucket time
 * identically (both treat the naive literal as UTC).
 */
export function toClickhouseTimestamp(epochMs: number): string {
  const d = new Date(epochMs);
  const p = (n: number, w = 2) => String(n).padStart(w, "0");
  return (
    `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ` +
    `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}.${p(d.getUTCMilliseconds(), 3)}`
  );
}

export const clickhouseDialect: Dialect = {
  name: "clickhouse",
  placeholder(name, type: ParamType) {
    return `{${name}:${chParamType(type)}}`;
  },
  timestampValue(epochMs) {
    return toClickhouseTimestamp(epochMs as number);
  },
  quantile(expr, q) {
    // Plain `quantile` does type-7 linear interpolation between adjacent ranks,
    // matching DuckDB's `quantile_cont`. It is exact (and deterministic) for
    // datasets within the reservoir (≤8192 values); NULLs are ignored, mirroring
    // DuckDB. (`quantileExact` returns an actual element instead of interpolating,
    // so it would diverge from the golden on even-sized inputs.)
    return `quantile(${q})(${expr})`;
  },
  vectorNorm(expr) {
    return `L2Norm(${expr})`;
  },
  avgIf(value, cond) {
    return `avgIf(${value}, ${cond})`;
  },
  anyValue(expr) {
    return `any(${expr})`;
  },
  timeBucketMs(tsExpr, intervalPlaceholder) {
    // toUnixTimestamp64Milli(ts) yields integer milliseconds (UTC); floor to the
    // interval grid to match DuckDB's epoch_ms bucketing.
    return `floor(toUnixTimestamp64Milli(${tsExpr}) / (${intervalPlaceholder} * 1000)) * (${intervalPlaceholder} * 1000)`;
  },
  epochMs(tsExpr) {
    return `toUnixTimestamp64Milli(${tsExpr})`;
  },
  toDate(expr) {
    return `toDate(${expr})`;
  },
  toText(expr) {
    return `toString(${expr})`;
  },
  jsonText(column, ...path) {
    // ClickHouse JSONExtractString takes the nested key path as trailing args.
    const keys = path.map((p) => `'${p}'`).join(", ");
    return `JSONExtractString(${column}, ${keys})`;
  },
  jsonInt(column, ...path) {
    // `Nullable(Int64)` makes an absent / non-integer key yield NULL (parity with
    // DuckDB's TRY_CAST), so callers coalesce to their own default.
    const keys = path.map((p) => `'${p}'`).join(", ");
    return `JSONExtract(${column}, ${keys}, 'Nullable(Int64)')`;
  },
  // Single-tenant rollups are plain views (pre-grouped by day), so each group has
  // exactly one source row and the "merge" of a single precomputed value is a
  // plain pass-through aggregate. (AggregatingMergeTree `-Merge` combinators are
  // the scale tier.)
  countMerge(stateExpr) {
    return `sum(${stateExpr})`;
  },
  avgMerge(stateExpr) {
    return `avg(${stateExpr})`;
  },
  quantileMerge(stateExpr, q) {
    return `quantile(${q})(${stateExpr})`;
  },
  asofInnerJoin: "ASOF INNER JOIN",
  asofLeftJoin: "ASOF LEFT JOIN",
};
