/**
 * Postgres client — the optional single-tenant relational store (ADR 0020, #84).
 *
 * A thin wrapper over `pg`'s connection pool that centralizes connection
 * settings and exposes the small surface the store needs: positional-parameter
 * queries, DDL commands, and transactions. Mirrors the shape of the DuckDB and
 * ClickHouse clients so the store assembly reads the same across engines.
 *
 * Postgres is a networked, multi-writer server safe for concurrent statements,
 * so there is no single-writer serialization here — several collector instances
 * can share one database, which is the point of this store.
 *
 * Value coercion: `pg` returns `int8` (`count(*)`, epoch-ms casts) and `numeric`
 * (`avg`/`sum` over integers) as **strings**, and parses `date`/`timestamp`
 * columns into local-time `Date`s. The pool installs type parsers so those come
 * back as plain JS numbers / naive-UTC strings instead, matching the rows the
 * DuckDB client returns (and the row shapes the query layer's types declare).
 */

import pg from "pg";
import type { PostgresSettings } from "@uptimizr/db";

/** A row of plain-JS values returned by a query. */
export type PostgresRow = Record<string, unknown>;

/** The statement surface available both on the pool and inside a transaction. */
export interface PostgresExecutor {
  /** Run a positional-parameter (`$1…$n`) query and return all rows. */
  query<T = PostgresRow>(sql: string, values?: readonly unknown[]): Promise<T[]>;
  /** Run a DDL/maintenance statement, ignoring any result set. */
  command(sql: string): Promise<void>;
}

export interface PostgresClient extends PostgresExecutor {
  /** Run `fn` inside one transaction (committed on success, rolled back on throw). */
  transaction<T>(fn: (tx: PostgresExecutor) => Promise<T>): Promise<T>;
  /** Drain the pool and release every connection. */
  close(): Promise<void>;
}

// Postgres type OIDs whose default `pg` parsing is replaced (see module doc).
const OID_INT8 = 20;
const OID_NUMERIC = 1700;
const OID_INT8_ARRAY = 1016;
const OID_NUMERIC_ARRAY = 1231;
const OID_DATE = 1082;
const OID_TIMESTAMP = 1114;
const OID_TIMESTAMPTZ = 1184;

const identity = (value: string): string => value;

/**
 * Build the per-pool type-parser table: 64-bit integers and numerics (scalar
 * and array) become JS numbers; date/timestamp columns stay the naive text
 * Postgres renders (`YYYY-MM-DD`, `YYYY-MM-DD HH:MM:SS[.fff]`) — the store never
 * relies on `pg`'s local-time `Date` interpretation of a naive timestamp.
 */
function buildTypeParsers(): pg.CustomTypesConfig {
  const numericArray = (oid: number) => {
    const parseStrings = pg.types.getTypeParser(oid, "text") as (v: string) => (string | null)[];
    return (value: string) => parseStrings(value).map((v) => (v === null ? null : Number(v)));
  };
  const overrides = new Map<number, (value: string) => unknown>([
    [OID_INT8, Number],
    [OID_NUMERIC, Number],
    [OID_INT8_ARRAY, numericArray(OID_INT8_ARRAY)],
    [OID_NUMERIC_ARRAY, numericArray(OID_NUMERIC_ARRAY)],
    [OID_DATE, identity],
    [OID_TIMESTAMP, identity],
    [OID_TIMESTAMPTZ, identity],
  ]);
  return {
    getTypeParser(oid: number, format?: "text" | "binary") {
      const override = format === "binary" ? undefined : overrides.get(oid);
      return override ?? pg.types.getTypeParser(oid, format as "text");
    },
  } as pg.CustomTypesConfig;
}

/**
 * Guard an operator-supplied identifier (the `POSTGRES_SCHEMA` name) before
 * interpolating it into DDL / `search_path`. It comes from trusted env, not
 * request input, but a strict allow-list keeps the statements injection-proof.
 */
export function assertSafeIdentifier(name: string, what = "Postgres schema name"): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
    throw new Error(
      `Invalid ${what} ${JSON.stringify(name)}: ` +
        "expected letters, digits and underscores (starting with a letter or underscore).",
    );
  }
  return name;
}

function makeExecutor(
  run: (sql: string, values?: readonly unknown[]) => Promise<pg.QueryResult>,
): PostgresExecutor {
  return {
    async query<T = PostgresRow>(sql: string, values?: readonly unknown[]) {
      const result = await run(sql, values);
      return result.rows as T[];
    },
    async command(sql: string) {
      await run(sql);
    },
  };
}

/**
 * Create a pooled Postgres client from {@link PostgresSettings}. Every
 * connection pins `TimeZone=UTC` and `search_path` to the configured schema, so
 * `now()`-based defaults and unqualified table names behave identically across
 * collector instances regardless of the server's defaults. The schema itself is
 * created by {@link migratePostgres} on first boot.
 */
export function createPostgresClient(settings: PostgresSettings): PostgresClient {
  const schema = assertSafeIdentifier(settings.schema);
  const pool = new pg.Pool({
    connectionString: settings.url,
    max: settings.poolMax,
    types: buildTypeParsers(),
    // libpq startup options: UTC wall clock + the store's schema first in the
    // search path (public stays reachable for extensions).
    options: `-c TimeZone=UTC -c search_path=${schema},public`,
  });
  // A connection dropped by the server while idle would otherwise surface as an
  // unhandled 'error' event and crash the process; the pool replaces it lazily.
  pool.on("error", () => {});

  const executor = makeExecutor((sql, values) => pool.query(sql, values ? [...values] : undefined));

  return {
    ...executor,
    async transaction<T>(fn: (tx: PostgresExecutor) => Promise<T>): Promise<T> {
      const conn = await pool.connect();
      try {
        await conn.query("BEGIN");
        const tx = makeExecutor((sql, values) =>
          conn.query(sql, values ? [...values] : undefined),
        );
        const result = await fn(tx);
        await conn.query("COMMIT");
        return result;
      } catch (error) {
        await conn.query("ROLLBACK").catch(() => {});
        throw error;
      } finally {
        conn.release();
      }
    },
    async close() {
      await pool.end();
    },
  };
}
