import { toPositionalParams, type QuerySpec } from "@uptimizr/db";
import type { PostgresClient } from "./client.js";

/**
 * Execute a dialect-agnostic {@link QuerySpec} (rendered with `postgresDialect`)
 * against the Postgres store and return typed rows. The dialect emits named
 * `$name::type` placeholders; they are rewritten here to `pg`'s positional
 * `$1…$n` form (the shared `toPositionalParams` helper the SQL Server port
 * reuses with `@p1…`). The client's type parsers return plain-JS values
 * (64-bit integers and numerics as numbers, arrays as arrays), so rows match the
 * shapes produced by the DuckDB `runDuckdbQuery`.
 */
export async function runPostgresQuery<T>(client: PostgresClient, spec: QuerySpec): Promise<T[]> {
  const { sql, values } = toPositionalParams(spec.query, spec.query_params, (i) => `$${i}`);
  return client.query<T>(sql, values);
}
