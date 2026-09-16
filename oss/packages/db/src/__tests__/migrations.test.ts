import { describe, expect, it } from "vitest";
import { DUCKDB_MIGRATIONS } from "../duckdb/migrations.js";

/**
 * Static, no-database checks on the DuckDB migration list (ADR 0007): ids are
 * unique and sorted (the array order *is* the apply order), and every statement
 * is idempotent, because the runner re-applies all of them on every boot.
 */
describe("DUCKDB_MIGRATIONS", () => {
  it("has unique, sorted ids", () => {
    const ids = DUCKDB_MIGRATIONS.map((m) => m.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect([...ids].sort()).toEqual(ids);
  });

  it("is idempotent: every statement guards itself or is a no-op on re-run", () => {
    for (const migration of DUCKDB_MIGRATIONS) {
      // `IF NOT EXISTS` for DDL, `CREATE OR REPLACE` for views, and a `WHERE`
      // guard for the one data backfill (ADR 0007 §1).
      expect(migration.sql, migration.id).toMatch(/IF NOT EXISTS|CREATE OR REPLACE|WHERE /);
    }
  });

  it("adds the agent-scoped key columns and the idempotent backfill (#309)", () => {
    const capabilities = DUCKDB_MIGRATIONS.find((m) => m.id === "0031_api_keys_capabilities");
    expect(capabilities?.sql).toContain("ADD COLUMN IF NOT EXISTS capabilities");

    const backfill = DUCKDB_MIGRATIONS.find((m) => m.id === "0032_api_keys_capabilities_backfill");
    // Guarded so re-running on every boot is a no-op after the first pass, and
    // a key already carrying a capability set is never clobbered.
    expect(backfill?.sql).toContain("WHERE capabilities IS NULL OR capabilities = ''");

    for (const [id, column] of [
      ["0033_api_keys_label", "label"],
      ["0034_api_keys_rate_limit_max", "rate_limit_max"],
      ["0035_api_keys_rate_limit_window_ms", "rate_limit_window_ms"],
    ] as const) {
      expect(DUCKDB_MIGRATIONS.find((m) => m.id === id)?.sql, id).toContain(
        `ADD COLUMN IF NOT EXISTS ${column}`,
      );
    }
  });

  it("creates the agent audit table with its full column set (#309)", () => {
    const audit = DUCKDB_MIGRATIONS.find((m) => m.id === "0036_agent_audit");
    expect(audit?.sql).toContain("CREATE TABLE IF NOT EXISTS agent_audit");
    for (const column of [
      "project_id",
      "key_id",
      `"at"`,
      "surface",
      "tool_or_path",
      "params",
      "row_count",
      "duration_ms",
      "status",
    ]) {
      expect(audit?.sql, column).toContain(column);
    }
  });

  it("never edits a shipped migration's id (the api_keys capability column stays)", () => {
    // `0027_api_keys_capability` is the legacy singular column. #309 layers a
    // set on top of it rather than rewriting it — the read path still falls back
    // to it for any row the backfill has not reached.
    expect(DUCKDB_MIGRATIONS.find((m) => m.id === "0027_api_keys_capability")?.sql).toContain(
      "ADD COLUMN IF NOT EXISTS capability VARCHAR DEFAULT 'query'",
    );
  });
});
