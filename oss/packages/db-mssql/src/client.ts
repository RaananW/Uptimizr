/**
 * SQL Server client — the optional single-tenant relational store (ADR 0020,
 * #85).
 *
 * A thin wrapper over the `mssql` (tedious) connection pool that centralizes
 * connection settings and exposes the small surface the store needs:
 * positional-parameter queries (`@p1…@pn`), DDL batches, and transactions.
 * Mirrors the shape of the DuckDB / ClickHouse / Postgres clients so the store
 * assembly reads the same across engines.
 *
 * SQL Server is a networked, multi-writer server safe for concurrent
 * statements, so there is no single-writer serialization here — several
 * collector instances can share one database, which is the point of this store.
 *
 * Value coercion: the TDS driver returns `bigint` columns as **strings** and
 * `datetime2` / `date` columns as JS `Date`s. Rows are normalized so `bigint`
 * becomes a plain number and temporal columns the naive-UTC text the other
 * stores render (`YYYY-MM-DD HH:MM:SS[.fff]` / `YYYY-MM-DD`), matching the row
 * shapes the query layer's types declare. `float`, `int` and `numeric` already
 * arrive as numbers.
 */

import sql from "mssql";
import type { MssqlSettings } from "@uptimizr/db";

/** A row of plain-JS values returned by a query. */
export type MssqlRow = Record<string, unknown>;

/** The statement surface available both on the pool and inside a transaction. */
export interface MssqlExecutor {
  /** Run a positional-parameter (`@p1…@pn`) query and return all rows. */
  query<T = MssqlRow>(text: string, values?: readonly unknown[]): Promise<T[]>;
  /** Run a DDL/maintenance batch (may hold several statements), ignoring results. */
  command(text: string): Promise<void>;
}

export interface MssqlClient extends MssqlExecutor {
  /** Run `fn` inside one transaction (committed on success, rolled back on throw). */
  transaction<T>(fn: (tx: MssqlExecutor) => Promise<T>): Promise<T>;
  /** Name of the database this client is connected to. */
  readonly database: string;
  /** Drain the pool and release every connection. */
  close(): Promise<void>;
}

/**
 * Guard an operator-supplied identifier (a database name) before interpolating
 * it into DDL. It comes from trusted env, not request input, but a strict
 * allow-list keeps the statements injection-proof.
 */
export function assertSafeIdentifier(name: string, what = "SQL Server database name"): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
    throw new Error(
      `Invalid ${what} ${JSON.stringify(name)}: ` +
        "expected letters, digits and underscores (starting with a letter or underscore).",
    );
  }
  return name;
}

/** Per-client deviations from the configured settings. */
export interface MssqlClientOverrides {
  /** Target another database on the same server. */
  database?: string;
  /** Connect timeout in milliseconds (the reachability probe uses a short one). */
  connectionTimeout?: number;
}

/**
 * Resolve {@link MssqlSettings} into an `mssql` pool config: the `MSSQL_URL`
 * connection string when given (ADO.NET keys — `Server=…;Database=…;User
 * Id=…;Password=…;Encrypt=…;TrustServerCertificate=…`), else the discrete
 * fields. `overrides.database` targets another database on the same server
 * (used to create databases from `master` and by the throwaway test databases).
 */
export function resolveMssqlConfig(
  settings: MssqlSettings,
  overrides: MssqlClientOverrides = {},
): sql.config {
  const base: sql.config = settings.url
    ? sql.ConnectionPool.parseConnectionString(settings.url)
    : {
        server: settings.server,
        port: settings.port,
        database: settings.database,
        user: settings.user,
        password: settings.password,
        options: {
          encrypt: settings.encrypt,
          trustServerCertificate: settings.trustServerCertificate,
        },
      };
  return {
    ...base,
    database: overrides.database ?? base.database ?? settings.database,
    connectionTimeout: overrides.connectionTimeout ?? base.connectionTimeout,
    pool: { ...base.pool, max: settings.poolMax },
    options: {
      ...base.options,
      // Wall-clock UTC in and out: JS Dates are written/read as their UTC parts.
      useUTC: true,
      enableArithAbort: true,
    },
  };
}

const p = (n: number, w = 2) => String(n).padStart(w, "0");

/**
 * Render a `Date` read from a `datetime2` / `date` column as the naive-UTC
 * text DuckDB and Postgres produce for the same value (`YYYY-MM-DD HH:MM:SS`,
 * with a `.fff` fraction only when non-zero; `YYYY-MM-DD` for dates).
 */
export function formatTemporal(value: Date, isDate: boolean): string {
  const day = `${value.getUTCFullYear()}-${p(value.getUTCMonth() + 1)}-${p(value.getUTCDate())}`;
  if (isDate) return day;
  const ms = value.getUTCMilliseconds();
  const fraction = ms === 0 ? "" : `.${p(ms, 3)}`.replace(/0+$/, "");
  return `${day} ${p(value.getUTCHours())}:${p(value.getUTCMinutes())}:${p(value.getUTCSeconds())}${fraction}`;
}

function declarationOf(column: sql.IColumnMetadata[string]): string {
  const type = column.type as unknown as { declaration?: string } | undefined;
  return (type?.declaration ?? "").toLowerCase();
}

/** Normalize a recordset in place (see module doc on value coercion). */
function normalizeRows<T>(result: sql.IResult<unknown>): T[] {
  const recordset = result.recordset as sql.IRecordSet<MssqlRow> | undefined;
  if (!recordset) return [];
  const bigints: string[] = [];
  const dates: string[] = [];
  const temporals: string[] = [];
  for (const [name, column] of Object.entries(recordset.columns)) {
    const decl = declarationOf(column);
    if (decl === "bigint") bigints.push(name);
    else if (decl === "date") dates.push(name);
    else if (decl.startsWith("datetime") || decl === "smalldatetime") temporals.push(name);
  }
  if (bigints.length + dates.length + temporals.length === 0) return recordset as T[];
  for (const row of recordset) {
    for (const name of bigints) {
      const v = row[name];
      if (typeof v === "string") row[name] = Number(v);
    }
    for (const name of dates) {
      const v = row[name];
      if (v instanceof Date) row[name] = formatTemporal(v, true);
    }
    for (const name of temporals) {
      const v = row[name];
      if (v instanceof Date) row[name] = formatTemporal(v, false);
    }
  }
  return recordset as T[];
}

function bind(request: sql.Request, values?: readonly unknown[]): sql.Request {
  values?.forEach((value, i) => request.input(`p${i + 1}`, value ?? null));
  return request;
}

function makeExecutor(newRequest: () => sql.Request): MssqlExecutor {
  return {
    async query<T = MssqlRow>(text: string, values?: readonly unknown[]) {
      const result = await bind(newRequest(), values).query(text);
      return normalizeRows<T>(result);
    },
    async command(text: string) {
      // `batch` sends the text verbatim (no sp_executesql), which `CREATE VIEW`
      // / `CREATE FUNCTION` require as the first statement of their batch.
      await newRequest().batch(text);
    },
  };
}

/**
 * Create a pooled SQL Server client from {@link MssqlSettings}. Connections are
 * established lazily on first use; a dropped connection is replaced by the
 * pool. The schema (tables in `dbo`) is created by `migrateMssql` on first
 * boot; the database itself by `ensureMssqlDatabase`.
 */
export function createMssqlClient(
  settings: MssqlSettings,
  overrides: MssqlClientOverrides = {},
): MssqlClient {
  const config = resolveMssqlConfig(settings, overrides);
  const pool = new sql.ConnectionPool(config);
  // A connection dropped by the server would otherwise surface as an unhandled
  // 'error' event and crash the process; the pool replaces it lazily.
  pool.on("error", () => {});
  let connecting: Promise<sql.ConnectionPool> | undefined;
  const ready = () => (connecting ??= pool.connect());

  const executor = makeExecutor(() => pool.request());
  const withPool = <T>(run: () => Promise<T>) => ready().then(run);

  return {
    database: config.database ?? settings.database,
    query: (text, values) => withPool(() => executor.query(text, values)),
    command: (text) => withPool(() => executor.command(text)),
    async transaction<T>(fn: (tx: MssqlExecutor) => Promise<T>): Promise<T> {
      await ready();
      const tx = new sql.Transaction(pool);
      await tx.begin();
      try {
        const result = await fn(makeExecutor(() => tx.request()));
        await tx.commit();
        return result;
      } catch (error) {
        await tx.rollback().catch(() => {});
        throw error;
      }
    },
    async close() {
      if (connecting) await connecting.catch(() => {});
      await pool.close();
    },
  };
}

/**
 * Create `database` on the configured server when it does not exist yet, using
 * a short-lived connection to `master`. SQL Server images and most managed
 * offerings do not create application databases from configuration, so the
 * store does it on first boot when the login has `CREATE ANY DATABASE`. Any
 * failure (no permission, `master` unreachable) is swallowed: the subsequent
 * real connection reports the actionable error.
 */
export async function ensureMssqlDatabase(settings: MssqlSettings, database: string): Promise<void> {
  const name = assertSafeIdentifier(database);
  const master = createMssqlClient(settings, { database: "master" });
  try {
    await master.command(`IF DB_ID(N'${name}') IS NULL CREATE DATABASE [${name}]`);
  } catch {
    // Best effort — see doc comment.
  } finally {
    await master.close().catch(() => {});
  }
}

/**
 * Drop `database` (used by the live test suites to discard their throwaway
 * databases). Forces other sessions off first; no-op when it does not exist.
 */
export async function dropMssqlDatabase(settings: MssqlSettings, database: string): Promise<void> {
  const name = assertSafeIdentifier(database);
  const master = createMssqlClient(settings, { database: "master" });
  try {
    await master.command(
      `IF DB_ID(N'${name}') IS NOT NULL
       BEGIN
         ALTER DATABASE [${name}] SET SINGLE_USER WITH ROLLBACK IMMEDIATE;
         DROP DATABASE [${name}];
       END`,
    );
  } finally {
    await master.close().catch(() => {});
  }
}
