/**
 * ClickHouse client — the optional single-tenant scale store (ADR 0020).
 *
 * A thin wrapper over `@clickhouse/client` (HTTP interface) that centralizes
 * connection settings and exposes the small surface the store needs: parameter-
 * bound queries, DDL commands, and batched row inserts. Mirrors the shape of the
 * DuckDB client so the store assembly reads the same across engines.
 *
 * ClickHouse, unlike DuckDB, is a networked server safe for concurrent
 * statements, so there is no single-writer serialization here — the underlying
 * client pools HTTP connections.
 *
 * Numeric coercion: `output_format_json_quote_64bit_integers` is disabled so
 * `UInt64`/`Int64` columns (`count()`, `toUnixTimestamp64Milli(...)`) come back
 * as JS numbers rather than strings, matching the plain-JS rows the DuckDB client
 * returns (and the row shapes the query layer's types declare).
 *
 * Two settings make ClickHouse evaluate the shared (DuckDB-authored) aggregations
 * with the same semantics DuckDB uses, so the cross-engine parity suite holds:
 * - `aggregate_functions_null_for_empty`: SQL-standard empty-set behaviour. Over
 *   an empty (filtered-out) input `sum`/`avg`/`max`/`quantile` return NULL while
 *   `count()` stays 0 — matching DuckDB. (ClickHouse otherwise returns 0/NaN for
 *   the former.)
 * - `prefer_column_name_to_alias`: when a SELECT alias shadows a source column of
 *   the same name (the query layer aliases `toUnixTimestamp64Milli(ts) AS ts` and
 *   `toString(day) AS day`), resolve the name to the *column* in `WHERE` /
 *   `GROUP BY` / `ORDER BY`. ClickHouse otherwise prefers the alias there (unlike
 *   standard SQL / DuckDB), which would mis-filter the range and break `GROUP BY`.
 */

import { createClient, type ClickHouseClient } from "@clickhouse/client";
import type { ClickhouseSettings } from "@uptimizr/db";

/** A row of plain-JS values returned by a query. */
export type ClickhouseRow = Record<string, unknown>;

export interface ClickhouseClient {
  /** Run a parameter-bound query and return all rows as plain-JS objects. */
  query<T = ClickhouseRow>(sql: string, params?: Record<string, unknown>): Promise<T[]>;
  /** Run a DDL/maintenance statement, ignoring any result set. */
  command(sql: string): Promise<void>;
  /** Batched insert of row objects into `table` (column names must match). */
  insert(table: string, rows: readonly Record<string, unknown>[]): Promise<void>;
  /** Close the client and release pooled connections. */
  close(): Promise<void>;
}

/**
 * Create a ClickHouse client from {@link ClickhouseSettings}, bound to
 * `settings.database` so the query layer's unqualified table names resolve.
 * The database itself is created up front by {@link migrateClickhouse} (which
 * bootstraps the `CREATE DATABASE` from a `default`-bound connection), so the
 * target database already exists by the time this client runs any statement.
 */
export function createClickhouseClient(settings: ClickhouseSettings): ClickhouseClient {
  const client: ClickHouseClient = createClient({
    url: settings.url,
    username: settings.username,
    password: settings.password,
    database: settings.database,
    clickhouse_settings: {
      // Emit 64-bit integers as JSON numbers (not quoted strings) so rows match
      // the plain-number shapes the DuckDB client returns.
      output_format_json_quote_64bit_integers: 0,
      // SQL-standard empty-set aggregates (sum/avg/max/quantile -> NULL, count
      // -> 0), matching DuckDB so the shared aggregations agree over empty input.
      aggregate_functions_null_for_empty: 1,
      // Resolve a SELECT alias that shadows a source column (e.g. `... AS ts`,
      // `... AS day`) to the column in WHERE/GROUP BY/ORDER BY, as DuckDB does.
      prefer_column_name_to_alias: 1,
    },
  });

  return {
    async query<T = ClickhouseRow>(sql: string, params?: Record<string, unknown>) {
      const rs = await client.query({
        query: sql,
        query_params: params,
        format: "JSONEachRow",
      });
      return rs.json<T>();
    },
    async command(sql: string) {
      await client.command({ query: sql });
    },
    async insert(table: string, rows: readonly Record<string, unknown>[]) {
      if (rows.length === 0) return;
      await client.insert({
        table,
        values: rows as Record<string, unknown>[],
        format: "JSONEachRow",
      });
    },
    async close() {
      await client.close();
    },
  };
}
