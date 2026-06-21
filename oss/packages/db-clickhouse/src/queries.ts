import type { QuerySpec } from "@uptimizr/db";
import type { ClickhouseClient } from "./client.js";

/**
 * Execute a dialect-agnostic {@link QuerySpec} (rendered with `clickhouseDialect`)
 * against the ClickHouse store and return typed rows. The client returns plain-JS
 * values (64-bit integers unquoted as numbers, arrays as arrays), so rows match
 * the shapes produced by the DuckDB `runDuckdbQuery`.
 */
export async function runClickhouseQuery<T>(
  client: ClickhouseClient,
  spec: QuerySpec,
): Promise<T[]> {
  return client.query<T>(spec.query, spec.query_params);
}
