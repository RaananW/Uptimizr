/**
 * Connection settings for the OSS DuckDB store, read from the environment
 * (ADR 0020).
 *
 * Names mirror `.env.example`. Everything has a local-dev default so the package
 * is usable out of the box (a single persisted `.duckdb` file).
 */

import { existsSync } from "node:fs";
import { dirname, join } from "node:path";

/** DuckDB (OSS single-file store, ADR 0020) connection settings. */
export interface DuckdbSettings {
  /** Path to the persisted `.duckdb` file, or `:memory:` for an ephemeral store. */
  path: string;
}

/**
 * ClickHouse (optional single-tenant scale store, ADR 0020) connection settings.
 * Read from the environment but unused by the default DuckDB store, so the OSS
 * install needs neither a ClickHouse server nor the client until opted into via
 * `COLLECTOR_STORE=clickhouse`. Mirrors the `CLICKHOUSE_*` names in `.env.example`.
 */
export interface ClickhouseSettings {
  /** HTTP endpoint of the ClickHouse server (used by `@clickhouse/client`). */
  url: string;
  /** Target database. */
  database: string;
  /** Username. */
  username: string;
  /** Password (empty by default for a local dev server). */
  password: string;
}

export interface DbSettings {
  duckdb: DuckdbSettings;
  clickhouse: ClickhouseSettings;
  /** Opt-in raw per-session retention for replay (ADR 0003). */
  enableRawSessionRetention: boolean;
}

type Env = Record<string, string | undefined>;

function bool(value: string | undefined, fallback: boolean): boolean {
  if (value == null) return fallback;
  return value === "1" || value.toLowerCase() === "true";
}

/**
 * Walk up from `start` until a directory containing `pnpm-workspace.yaml` is
 * found, i.e. the monorepo root. Returns `undefined` if none exists.
 */
function findRepoRoot(start: string): string | undefined {
  let dir = start;
  for (;;) {
    if (existsSync(join(dir, "pnpm-workspace.yaml"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

/**
 * The default DuckDB file location when `DUCKDB_PATH` is unset.
 *
 * Resolved against the **repo root** (not the process cwd) so every tool — the
 * collector server, the migrate/seed/new-project CLIs — converges on one
 * canonical store no matter which package directory it runs from. Falls back to
 * the cwd-relative path only when the repo root can't be located (e.g. when the
 * package is consumed outside the monorepo).
 */
function defaultDuckdbPath(): string {
  const root = findRepoRoot(process.cwd());
  return root ? join(root, "data", "uptimizr.duckdb") : "./data/uptimizr.duckdb";
}

/**
 * Build {@link DbSettings} from an env-like record (defaults to `process.env`).
 * Passing an explicit record keeps this pure and testable.
 */
export function readDbSettings(env: Env = process.env): DbSettings {
  return {
    duckdb: {
      path: env.DUCKDB_PATH ?? defaultDuckdbPath(),
    },
    clickhouse: {
      url: env.CLICKHOUSE_URL ?? "http://localhost:8123",
      database: env.CLICKHOUSE_DATABASE ?? "uptimizr",
      username: env.CLICKHOUSE_USER ?? "default",
      password: env.CLICKHOUSE_PASSWORD ?? "",
    },
    enableRawSessionRetention: bool(env.ENABLE_RAW_SESSION_RETENTION, false),
  };
}
