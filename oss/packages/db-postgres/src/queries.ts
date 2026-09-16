import { coerceRows, toPositionalParams, type QuerySpec } from "@uptimizr/db";
import type { PostgresClient } from "./client.js";

/**
 * Execute a dialect-agnostic {@link QuerySpec} (rendered with `postgresDialect`)
 * against the Postgres store and return typed rows. The dialect emits named
 * `$name::type` placeholders; they are rewritten here to `pg`'s positional
 * `$1…$n` form (the shared `toPositionalParams` helper the SQL Server port
 * reuses with `@p1…`). The client's type parsers return plain-JS values
 * (64-bit integers and numerics as numbers, arrays as arrays), so rows match the
 * shapes produced by the DuckDB `runDuckdbQuery`.
 *
 * This is the single point where rows leave the `pg` driver, so it is where
 * {@link coerceRows} runs (ADR 0051 §2): `pg` hands back `int8`/`numeric` as
 * strings unless a type parser is registered for the OID, so the guarantee that a
 * numeric column *is* a number belongs to the store, not to a parser
 * registration that a future column type could sidestep.
 */
export async function runPostgresQuery<T>(client: PostgresClient, spec: QuerySpec): Promise<T[]> {
  const { sql, values } = toPositionalParams(spec.query, spec.query_params, (i) => `$${i}`);
  const rows = await client.query<T>(sql, values);
  return coerceRows(spec.metric, rows);
}
