import { coerceRows } from "../query/coerce.js";
import type { QuerySpec } from "../query/types.js";
import type { DuckdbClient } from "./client.js";

/**
 * Execute a dialect-agnostic {@link QuerySpec} (rendered with `duckdbDialect`)
 * against the DuckDB store and return typed rows. Values are already converted to
 * plain JS by the client (bigint→number, list→array, timestamp→string), so rows
 * match the shapes produced by the ClickHouse `runQuery`.
 *
 * This is the single point where rows leave the DuckDB driver, so it is where
 * {@link coerceRows} runs (ADR 0051 §2): every column the spec's registry metric
 * declares numeric is a number by the time it is returned. DuckDB already returns
 * numbers, so the pass is allocation-free here — it is applied all the same so
 * that *every* store upholds the same contract and a future driver or type-map
 * regression is caught by the parity suite rather than by a consumer.
 */
export async function runDuckdbQuery<T>(client: DuckdbClient, spec: QuerySpec): Promise<T[]> {
  const rows = await client.all<T>(spec.query, spec.query_params as Record<string, unknown>);
  return coerceRows(spec.metric, rows);
}
