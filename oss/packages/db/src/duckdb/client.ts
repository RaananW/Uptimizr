/**
 * DuckDB client — the OSS single-file store (ADR 0020).
 *
 * DuckDB is in-process and ACID, but a single connection is *not* safe for
 * concurrent statements. We therefore expose one shared connection and serialize
 * every operation through a promise chain ("single-writer discipline"). Reads and
 * writes alike run one-at-a-time; for a self-hosted collector this is more than
 * fast enough and removes an entire class of races.
 *
 * Values returned by the Neo client are post-processed by {@link convertValue}
 * into plain JS so the rest of the codebase never sees DuckDB value wrappers.
 */

import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";

import { DuckDBInstance, type DuckDBConnection } from "@duckdb/node-api";

/** A row of already-converted, plain-JS values. */
export type DuckdbRow = Record<string, unknown>;

export interface DuckdbClient {
  /** Run a statement, ignoring any result set. */
  run(sql: string, params?: Record<string, unknown>): Promise<void>;
  /** Run a query and return all rows as plain JS objects. */
  all<T = DuckdbRow>(sql: string, params?: Record<string, unknown>): Promise<T[]>;
  /**
   * Acquire exclusive access to the underlying connection for a unit of work
   * (e.g. a bulk append). No other client operation runs until `fn` settles.
   */
  exclusive<T>(fn: (con: DuckDBConnection) => Promise<T>): Promise<T>;
  /** Close the connection and release the instance. */
  close(): Promise<void>;
}

/**
 * Convert a single DuckDB Neo value into a plain JS value:
 * - `bigint` (from BIGINT/COUNT) → `number`
 * - list values (`{ items: [...] }`) → arrays (recursively converted)
 * - timestamp/date values → naive-UTC string via `toString()`
 * - everything else (string/number/boolean/null) passes through unchanged.
 */
export function convertValue(value: unknown): unknown {
  if (typeof value === "bigint") return Number(value);
  if (value == null || typeof value !== "object") return value;
  // DuckDBListValue exposes `.items`; arrays already plain.
  if (Array.isArray(value)) return value.map(convertValue);
  const obj = value as Record<string, unknown>;
  if (Array.isArray(obj.items)) return (obj.items as unknown[]).map(convertValue);
  // DuckDBTimestampValue (`micros`) / DuckDBDateValue (`days`) → naive-UTC text.
  if ("micros" in obj || "days" in obj) return String(value);
  return value;
}

function convertRow(row: DuckdbRow): DuckdbRow {
  const out: DuckdbRow = {};
  for (const key of Object.keys(row)) out[key] = convertValue(row[key]);
  return out;
}

/**
 * Open (or create) a DuckDB store at `path`. Use `":memory:"` for tests.
 * The returned client owns a single serialized connection.
 */
export async function createDuckdbClient(path: string): Promise<DuckdbClient> {
  // DuckDB opens/creates the file but not its parent directory; ensure it
  // exists first so a fresh checkout (e.g. ./data/uptimizr.duckdb) doesn't fail
  // with ENOENT. Skip for the in-memory store, which has no filesystem path.
  if (path !== ":memory:") {
    await mkdir(dirname(path), { recursive: true });
  }
  const instance = await DuckDBInstance.create(path);
  const connection = await instance.connect();

  // Serialize every operation onto a single promise chain.
  let tail: Promise<unknown> = Promise.resolve();
  function enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const result = tail.then(fn, fn);
    // Keep the chain alive even if an op rejects.
    tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  return {
    run(sql, params) {
      return enqueue(async () => {
        if (params) await connection.run(sql, params as Record<string, never>);
        else await connection.run(sql);
      });
    },
    all<T = DuckdbRow>(sql: string, params?: Record<string, unknown>) {
      return enqueue(async () => {
        const reader = params
          ? await connection.runAndReadAll(sql, params as Record<string, never>)
          : await connection.runAndReadAll(sql);
        return reader.getRowObjects().map(convertRow) as T[];
      });
    },
    exclusive<T>(fn: (con: DuckDBConnection) => Promise<T>) {
      return enqueue(() => fn(connection));
    },
    close() {
      return enqueue(async () => {
        connection.closeSync();
      });
    },
  };
}
