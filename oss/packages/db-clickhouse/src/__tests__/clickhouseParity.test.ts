/**
 * OSS cross-engine parity suite — ClickHouse vs golden (Phase C, ADR 0020).
 *
 * Runs every dialect-agnostic aggregation through ClickHouse against the shared
 * fixtures and asserts equality with the engine-independent golden output under
 * the documented tolerance rules. Because DuckDB also matches that same golden
 * (see `@uptimizr/db`'s `duckdbParity.test.ts`), a passing run here proves
 * DuckDB↔ClickHouse parity by transitivity.
 *
 * The suite is **skipped gracefully** when no ClickHouse server is reachable, so
 * it never fails a CI/dev run without the optional scale engine. Point it at a
 * server with the `CLICKHOUSE_*` env vars (defaults to the local docker-compose
 * instance). It uses a throwaway database that it drops on teardown.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PARITY_CASES, PARITY_EVENTS, clickhouseDialect, diffParity } from "@uptimizr/db";
import { createClickhouseClient, type ClickhouseClient } from "../client.js";
import { migrateClickhouse } from "../migrations.js";
import { insertEvents } from "../events.js";
import { runClickhouseQuery } from "../queries.js";

const CH_URL = process.env.CLICKHOUSE_URL ?? "http://localhost:8123";
const CH_USER = process.env.CLICKHOUSE_USER ?? "default";
const CH_PASSWORD = process.env.CLICKHOUSE_PASSWORD ?? "";
const TEST_DB = "uptimizr_ch_parity_test";

/** Probe the server's `/ping` so the suite can skip when it is unreachable. */
async function clickhouseReachable(): Promise<boolean> {
  try {
    const res = await fetch(`${CH_URL.replace(/\/$/, "")}/ping`, {
      signal: AbortSignal.timeout(2000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

const available = await clickhouseReachable();

describe.skipIf(!available)("clickhouse parity (vs golden)", () => {
  let ch: ClickhouseClient;

  beforeAll(async () => {
    ch = createClickhouseClient({
      url: CH_URL,
      database: TEST_DB,
      username: CH_USER,
      password: CH_PASSWORD,
    });
    await migrateClickhouse(ch, {
      url: CH_URL,
      database: TEST_DB,
      username: CH_USER,
      password: CH_PASSWORD,
    });
    // Idempotent across local re-runs: wipe any rows from a previous run before
    // re-seeding the fixtures.
    await ch.command(`TRUNCATE TABLE IF EXISTS events`);
    await ch.command(`TRUNCATE TABLE IF EXISTS node_samples`);
    await insertEvents(ch, [...PARITY_EVENTS]);
  });

  afterAll(async () => {
    if (ch) {
      await ch.command(`DROP DATABASE IF EXISTS ${TEST_DB}`);
      await ch.close();
    }
  });

  it("covers all 40 aggregations", () => {
    expect(PARITY_CASES.map((c) => c.name)).toEqual([
      "listSessions",
      "pointerHeatmap",
      "worldHeatmap",
      "gazeHeatmap",
      "cameraDirectionHeatmap",
      "cameraPositionHeatmap",
      "sessionTrajectory",
      "clickGazeRay",
      "flowHeatmap",
      "flowHeatmapByStandpoint",
      "topMeshes",
      "meshDwell",
      "perfSummary",
      "perfDistribution",
      "fpsHistogram",
      "frameTimePercentiles",
      "jankRate",
      "perfByDevice",
      "perfByScene",
      "resourcePercentiles",
      "stabilityCounts",
      "deadClicks",
      "rageClicks",
      "hoverDwell",
      "compileStalls",
      "resourceSummary",
      "capabilityChanges",
      "cameraGestures",
      "perfDaily",
      "eventsDaily",
      "distinctScenes",
      "timeseries",
      "eventTypeCounts",
      "sceneCoverage",
      "cameraDistance",
      "navigationStats",
      "xrRotationRate",
      "xrSourceUsage",
      "xrAbandonment",
      "interactionsBySource",
    ]);
  });

  for (const parityCase of PARITY_CASES) {
    it(`matches golden: ${parityCase.name}`, async () => {
      const rows = await runClickhouseQuery<Record<string, unknown>>(
        ch,
        parityCase.build(clickhouseDialect),
      );
      const errors = diffParity(rows, parityCase.golden, {
        sortKeys: parityCase.sortKeys,
        ignoreColumns: parityCase.ignoreColumns,
      });
      expect(errors, errors.join("\n")).toEqual([]);
    });
  }
});
