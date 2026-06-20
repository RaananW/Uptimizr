import type { QuerySpec } from "../query/types.js";
import type { DuckdbClient } from "./client.js";

/**
 * Execute a dialect-agnostic {@link QuerySpec} (rendered with `duckdbDialect`)
 * against the DuckDB store and return typed rows. Values are already converted to
 * plain JS by the client (bigint→number, list→array, timestamp→string), so rows
 * match the shapes produced by the ClickHouse `runQuery`.
 */
export async function runDuckdbQuery<T>(client: DuckdbClient, spec: QuerySpec): Promise<T[]> {
  return client.all<T>(spec.query, spec.query_params as Record<string, unknown>);
}
