/**
 * Pure unit checks for the ClickHouse dialect (no server required).
 *
 * The dialect is a string builder, so these assert the engine-specific SQL
 * fragments render as expected — the contract the parity suite relies on when a
 * live ClickHouse is available.
 */

import { describe, expect, it } from "vitest";
import { clickhouseDialect, toClickhouseTimestamp } from "@uptimizr/db";
import { CLICKHOUSE_MIGRATIONS } from "../migrations.js";

const d = clickhouseDialect;

describe("clickhouseDialect", () => {
  it("renders typed parameter placeholders", () => {
    expect(d.placeholder("projectId", "string")).toBe("{projectId:String}");
    expect(d.placeholder("bins", "u32")).toBe("{bins:UInt32}");
    expect(d.placeholder("cellSize", "f64")).toBe("{cellSize:Float64}");
    expect(d.placeholder("since", "timestamp")).toBe("{since:DateTime64(3)}");
    expect(d.placeholder("day", "date")).toBe("{day:Date}");
  });

  it("binds timestamps as naive-UTC DateTime64(3) literals", () => {
    const epoch = Date.UTC(2024, 5, 16, 10, 0, 0, 250);
    expect(toClickhouseTimestamp(epoch)).toBe("2024-06-16 10:00:00.250");
    expect(d.timestampValue(epoch)).toBe("2024-06-16 10:00:00.250");
  });

  it("renders quantile / norm / conditional aggregates", () => {
    expect(d.quantile("fps", 0.5)).toBe("quantile(0.5)(fps)");
    expect(d.vectorNorm("direction")).toBe("L2Norm(direction)");
    // `-OrNull`: an average over no matching row is absent, not `0` — the same
    // answer the `FILTER` / `CASE` forms give on the other three engines.
    expect(d.avgIf("dist", "active")).toBe("avgIfOrNull(dist, active)");
    expect(d.anyValue("scene_id")).toBe("any(scene_id)");
  });

  it("renders epoch / time-bucket / json extraction", () => {
    expect(d.epochMs("ts")).toBe("toUnixTimestamp64Milli(ts)");
    expect(d.toDate("ts")).toBe("toDate(ts)");
    expect(d.toText("day")).toBe("toString(day)");
    expect(d.jsonText("payload", "device", "engine")).toBe(
      "JSONExtractString(payload, 'device', 'engine')",
    );
  });

  it("renders rollup merge combinators as plain pass-through aggregates", () => {
    expect(d.countMerge("samples_state")).toBe("sum(samples_state)");
    expect(d.avgMerge("avg_fps_state")).toBe("avg(avg_fps_state)");
    expect(d.quantileMerge("p50_fps_state", 0.5)).toBe("quantile(0.5)(p50_fps_state)");
  });
});

/**
 * Static checks on the migration list (ADR 0007): forward-only, appended never
 * edited, and idempotent because the runner re-applies everything on every boot.
 */
describe("CLICKHOUSE_MIGRATIONS", () => {
  it("has unique, sorted ids and idempotent statements", () => {
    const ids = CLICKHOUSE_MIGRATIONS.map((m) => m.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect([...ids].sort()).toEqual(ids);
    for (const migration of CLICKHOUSE_MIGRATIONS) {
      expect(migration.sql, migration.id).toMatch(/IF NOT EXISTS/);
    }
  });

  it("adds the agent-scoped key columns and the audit table (#309)", () => {
    const columns = CLICKHOUSE_MIGRATIONS.find((m) => m.id === "0009_api_keys_capabilities");
    for (const column of ["capabilities", "label", "rate_limit_max", "rate_limit_window_ms"]) {
      expect(columns?.sql, column).toContain(`ADD COLUMN IF NOT EXISTS ${column}`);
    }
    // ClickHouse backfills through the column's DEFAULT expression rather than
    // an `ALTER … UPDATE`: migrations re-run on every boot and a mutation would
    // be re-queued each time. Existing rows therefore read their legacy single
    // capability as a one-element set, with no mutation at all.
    expect(columns?.sql).toContain("capabilities          String DEFAULT capability");
    for (const migration of CLICKHOUSE_MIGRATIONS) {
      expect(migration.sql, migration.id).not.toMatch(/ALTER TABLE \w+\s+UPDATE/);
    }

    const audit = CLICKHOUSE_MIGRATIONS.find((m) => m.id === "0010_agent_audit");
    expect(audit?.sql).toContain("CREATE TABLE IF NOT EXISTS agent_audit");
    expect(audit?.sql).toContain("ORDER BY (project_id, at)");
  });
});
