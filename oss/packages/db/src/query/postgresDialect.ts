/**
 * PostgreSQL dialect for the query layer (ADR 0020, #84).
 *
 * Postgres is the optional single-tenant *relational* store: a multi-writer
 * server many self-hosters already operate, for shops that "only want Postgres"
 * and have outgrown DuckDB's single read-write process. This dialect renders the
 * engine-specific fragments of each shared aggregation (`aggregations.ts`) to
 * Postgres SQL, so the bulk of every query stays shared with DuckDB/ClickHouse.
 *
 * Like the other dialects it is *single-tenant* — no `org_id`, no tenant
 * isolation — which keeps it relocatable across the open-core boundary.
 *
 * Binding model: parameters are emitted as named `$name::type` placeholders
 * (every logical {@link ParamType} carries an explicit cast so Postgres never has
 * to infer a parameter type from context) and rewritten to positional `$1…$n`
 * by `toPositionalParams` in the `@uptimizr/db-postgres` runner. Timestamp params
 * are bound as naive-UTC strings (see {@link toPostgresTimestamp}) against
 * `timestamp` (without time zone) columns, so ordering, bucketing, and `::date`
 * truncation are wall-clock-UTC exactly as on DuckDB and ClickHouse, independent
 * of the session `TimeZone`.
 *
 * Row-store fit gaps (issue #84) and how they are closed here:
 * - **No `ASOF JOIN`.** `asofJoin` renders the shared nearest-row emulation
 *   (`renderNearestRowJoin`, `relational.ts`) as `JOIN LATERAL (… ORDER BY ts
 *   DESC LIMIT 1) ON TRUE`.
 * - **No MergeTree rollups.** The daily rollups are plain views that recompute
 *   at query time (see the `@uptimizr/db-postgres` migrations), so the `-Merge`
 *   combinators reduce to pass-through aggregates, as on DuckDB.
 * - **Arrays are 1-indexed** — the same convention DuckDB and ClickHouse use, so
 *   `position[1]` in the shared SQL needs no translation; `arrayLength` maps to
 *   `cardinality` and `vectorNorm` unnests the array.
 * - **JSON** lives in a `jsonb` column; extraction is `#>>` with a text[] path,
 *   and the numeric extractors regex-guard the cast (Postgres has no `TRY_CAST`)
 *   so an absent / non-numeric key yields NULL exactly like DuckDB's `TRY_CAST`.
 */

import type { Dialect, ParamType } from "./dialect.js";
import { renderNearestRowJoin, type NearestRowJoinTokens } from "./relational.js";

/** Map a logical {@link ParamType} to the explicit Postgres cast it is bound with. */
function pgCast(type: ParamType): string {
  switch (type) {
    case "string":
      return "text";
    case "u32":
      return "integer";
    case "f64":
      return "double precision";
    case "timestamp":
      return "timestamp";
    case "date":
      return "date";
  }
}

/**
 * Format an epoch-millisecond timestamp as a naive-UTC `YYYY-MM-DD HH:MM:SS.mmm`
 * string for binding to a Postgres `timestamp` (without time zone) column/param.
 * Mirrors the DuckDB / ClickHouse literal format so all stores order and bucket
 * time identically.
 */
export function toPostgresTimestamp(epochMs: number): string {
  const d = new Date(epochMs);
  const p = (n: number, w = 2) => String(n).padStart(w, "0");
  return (
    `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ` +
    `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}.${p(d.getUTCMilliseconds(), 3)}`
  );
}

/** Join keywords for the Postgres flavour of the nearest-row ASOF emulation. */
export const POSTGRES_NEAREST_ROW_JOIN: NearestRowJoinTokens = {
  inner: "INNER JOIN LATERAL",
  left: "LEFT JOIN LATERAL",
  onTrue: "ON TRUE",
  selectPrefix: "SELECT",
  selectSuffix: "LIMIT 1",
};

/** Render a trusted compile-time key path as a Postgres `text[]` literal. */
function jsonPath(path: readonly string[]): string {
  return `'{${path.map((k) => `"${k}"`).join(",")}}'`;
}

/** `(column #>> '{path}')` — the JSON value at `path` as text, NULL when absent. */
function jsonAt(column: string, path: readonly string[]): string {
  return `(${column} #>> ${jsonPath(path)})`;
}

/**
 * Regex-guarded numeric cast of a JSON text extraction. Postgres has no
 * `TRY_CAST`, so the value is only cast when it matches the numeric shape;
 * anything else (absent key, non-numeric string) yields NULL — parity with
 * DuckDB's `TRY_CAST(... AS BIGINT|DOUBLE)`.
 */
function guardedCast(extract: string, pattern: string, type: string): string {
  return `CASE WHEN ${extract} ~ '${pattern}' THEN ${extract}::${type} END`;
}

export const postgresDialect: Dialect = {
  name: "postgres",
  placeholder(name, type: ParamType) {
    return `$${name}::${pgCast(type)}`;
  },
  timestampValue(epochMs) {
    return toPostgresTimestamp(epochMs as number);
  },
  quantile(expr, q) {
    // `percentile_cont` interpolates linearly between adjacent ranks (type-7),
    // exactly like DuckDB's `quantile_cont` and ClickHouse's `quantile`; NULLs
    // are ignored and an empty input yields NULL. Cast so integer-typed
    // expressions (e.g. `long_frames` sums) are accepted.
    return `percentile_cont(${q}) WITHIN GROUP (ORDER BY (${expr})::double precision)`;
  },
  vectorNorm(expr) {
    // Postgres has no vector norm; unnest the array in a correlated scalar
    // subquery. Works for any length (matches L2Norm / list_dot_product).
    return `sqrt((SELECT sum(v * v) FROM unnest(${expr}) AS u(v)))`;
  },
  arrayLength(expr) {
    // `cardinality` returns 0 for an empty array (`array_length` returns NULL).
    return `cardinality(${expr})`;
  },
  avgIf(value, cond) {
    return `avg(${value}) FILTER (WHERE ${cond})`;
  },
  anyValue(expr) {
    // `min` is a valid "any" (the callers use it on values constant within the
    // group), ignores NULLs like DuckDB's `any_value`, and — unlike PG 16's
    // `any_value()` — works on every supported Postgres version.
    return `min(${expr})`;
  },
  timeBucketMs(tsExpr, intervalPlaceholder) {
    // Integer epoch-ms floored to the interval grid (same arithmetic as DuckDB /
    // ClickHouse). Divide in double precision so the interval param's integer
    // type can never turn `/` into a truncating integer division.
    const ms = `(EXTRACT(EPOCH FROM ${tsExpr}) * 1000)::bigint`;
    const bucket = `(${intervalPlaceholder} * 1000)`;
    return `(floor(${ms}::double precision / ${bucket}) * ${bucket})::bigint`;
  },
  epochMs(tsExpr) {
    // EXTRACT(EPOCH) of a naive timestamp is wall-clock UTC seconds; the store
    // writes millisecond precision, so `* 1000` is exact before the cast.
    return `(EXTRACT(EPOCH FROM ${tsExpr}) * 1000)::bigint`;
  },
  toDate(expr) {
    return `CAST(${expr} AS DATE)`;
  },
  toText(expr) {
    return `CAST(${expr} AS TEXT)`;
  },
  jsonText(column, ...path) {
    return jsonAt(column, path);
  },
  jsonInt(column, ...path) {
    return guardedCast(jsonAt(column, path), "^-?[0-9]+$", "bigint");
  },
  jsonFloat(column, ...path) {
    // Numeric path components index a JSON array (0-based) natively in `#>>`.
    return guardedCast(
      jsonAt(column, path),
      "^-?[0-9]+(\\.[0-9]+)?([eE][-+]?[0-9]+)?$",
      "double precision",
    );
  },
  // The daily rollups are query-time views (pre-grouped by day), so each read
  // GROUP BY sees exactly one source row per group and the "merge" of a single
  // precomputed value is a plain pass-through aggregate — as on DuckDB.
  countMerge(stateExpr) {
    return `sum(${stateExpr})`;
  },
  avgMerge(stateExpr) {
    return `avg(${stateExpr})`;
  },
  quantileMerge(stateExpr, q) {
    return `percentile_cont(${q}) WITHIN GROUP (ORDER BY (${stateExpr})::double precision)`;
  },
  asofJoin(spec) {
    return renderNearestRowJoin(spec, POSTGRES_NEAREST_ROW_JOIN);
  },
};
