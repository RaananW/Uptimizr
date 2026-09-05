import { toPositionalParams, toTsql, type QuerySpec } from "@uptimizr/db";
import type { MssqlClient } from "./client.js";

/**
 * Execute a dialect-agnostic {@link QuerySpec} (rendered with `mssqlDialect`)
 * against the SQL Server store and return typed rows. Two execution-time
 * rewrites from `@uptimizr/db` are applied, in this order:
 *
 * 1. `toTsql` — the T-SQL adaptation of the shared SQL (JSON vector indexing,
 *    `LIMIT` → `OFFSET … FETCH`, `GROUP BY <alias>` → expression, `ATN2`).
 * 2. `toPositionalParams` — the dialect's named `$name` placeholders become
 *    positional `@p1…@pn` (the same helper the Postgres store uses with `$1…`).
 *
 * The client normalizes driver values (bigint strings → numbers, temporal
 * columns → naive-UTC text), so rows match the shapes produced by the DuckDB
 * `runDuckdbQuery`.
 */
export async function runMssqlQuery<T>(client: MssqlClient, spec: QuerySpec): Promise<T[]> {
  const { sql, values } = toPositionalParams(
    toTsql(spec.query),
    spec.query_params,
    (i) => `@p${i}`,
  );
  return client.query<T>(sql, values);
}
