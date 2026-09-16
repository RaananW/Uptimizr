import { coerceRows, type QuerySpec } from "@uptimizr/db";
import type { ClickhouseClient } from "./client.js";

/**
 * Execute a dialect-agnostic {@link QuerySpec} (rendered with `clickhouseDialect`)
 * against the ClickHouse store and return typed rows. The client returns plain-JS
 * values (64-bit integers unquoted as numbers, arrays as arrays), so rows match
 * the shapes produced by the DuckDB `runDuckdbQuery`.
 *
 * This is the single point where rows leave the ClickHouse driver, so it is where
 * {@link coerceRows} runs (ADR 0051 §2). ClickHouse is the engine that makes the
 * guarantee necessary: its HTTP interface renders 64-bit integers and decimals as
 * JSON **strings** by default. `createClickhouseClient` already disables 64-bit
 * integer quoting, but that setting covers one family of types on one transport —
 * decimals, aggregate-function return types and any future column type are not
 * covered by it, and an operator's own `clickhouse_settings` or a server-side
 * default can undo it. Coercing here makes "the collector emits numbers" a
 * property of the store rather than of a connection setting, and the parity suite
 * asserts it on real rows.
 */
export async function runClickhouseQuery<T>(
  client: ClickhouseClient,
  spec: QuerySpec,
): Promise<T[]> {
  const rows = await client.query<T>(spec.query, spec.query_params);
  return coerceRows(spec.metric, rows);
}
