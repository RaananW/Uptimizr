/**
 * DuckDB dialect for the query layer (ADR 0020).
 *
 * DuckDB is the OSS default engine: a single, persisted file with ACID + WAL,
 * in-process and zero-service. This dialect renders the engine-specific
 * fragments of each shared aggregation (`aggregations.ts`) to DuckDB SQL.
 *
 * Like the ClickHouse dialect, it is *single-tenant* — it carries no
 * `org_id`/tenant-isolation concerns — which keeps it relocatable across the
 * open-core boundary.
 *
 * Binding model: parameters are emitted as DuckDB named placeholders (`$name`)
 * and supplied as a `query_params` record. Timestamp params are bound as
 * naive-UTC strings (see {@link toDuckdbTimestamp}) and cast in-place with
 * `::TIMESTAMP`; DuckDB treats naive `TIMESTAMP` as UTC, matching the
 * ClickHouse store's epoch handling.
 */

import type { Dialect, ParamType } from "./dialect.js";

/**
 * Format an epoch-millisecond timestamp as a naive-UTC `YYYY-MM-DD HH:MM:SS.mmm`
 * string for binding to a DuckDB `TIMESTAMP` column/param. Mirrors the
 * ClickHouse `DateTime64(3)` literal format so both stores order and bucket time
 * identically.
 */
export function toDuckdbTimestamp(epochMs: number): string {
  const d = new Date(epochMs);
  const p = (n: number, w = 2) => String(n).padStart(w, "0");
  return (
    `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ` +
    `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}.${p(d.getUTCMilliseconds(), 3)}`
  );
}

export const duckdbDialect: Dialect = {
  name: "duckdb",
  placeholder(name, type: ParamType) {
    // Timestamp params are bound as naive-UTC strings and cast in-place. Other
    // logical types bind directly; DuckDB infers the concrete type from the value.
    return type === "timestamp" ? `$${name}::TIMESTAMP` : `$${name}`;
  },
  timestampValue(epochMs) {
    return toDuckdbTimestamp(epochMs as number);
  },
  quantile(expr, q) {
    return `quantile_cont(${expr}, ${q})`;
  },
  vectorNorm(expr) {
    return `sqrt(list_dot_product(${expr}, ${expr}))`;
  },
  avgIf(value, cond) {
    return `avg(${value}) FILTER (WHERE ${cond})`;
  },
  anyValue(expr) {
    return `any_value(${expr})`;
  },
  timeBucketMs(tsExpr, intervalPlaceholder) {
    // epoch_ms(ts) yields integer milliseconds (UTC); floor to the interval grid.
    return `floor(epoch_ms(${tsExpr}) / (${intervalPlaceholder} * 1000)) * (${intervalPlaceholder} * 1000)`;
  },
  epochMs(tsExpr) {
    return `epoch_ms(${tsExpr})`;
  },
  toDate(expr) {
    return `CAST(${expr} AS DATE)`;
  },
  toText(expr) {
    return `CAST(${expr} AS VARCHAR)`;
  },
  jsonText(column, ...path) {
    return `json_extract_string(${column}, '$.${path.join(".")}')`;
  },
  jsonInt(column, ...path) {
    return `TRY_CAST(json_extract_string(${column}, '$.${path.join(".")}') AS BIGINT)`;
  },
  // Rollup tables are exposed as DuckDB views (see migrations) that pre-group by
  // `(project_id, …, day)`, so each read GROUP BY yields exactly one source row
  // per group. The "merge" of a single precomputed value is the value itself.
  countMerge(stateExpr) {
    return `sum(${stateExpr})`;
  },
  avgMerge(stateExpr) {
    return `avg(${stateExpr})`;
  },
  quantileMerge(stateExpr, q) {
    return `quantile_cont(${stateExpr}, ${q})`;
  },
  asofInnerJoin: "ASOF INNER JOIN",
  asofLeftJoin: "ASOF LEFT JOIN",
};
