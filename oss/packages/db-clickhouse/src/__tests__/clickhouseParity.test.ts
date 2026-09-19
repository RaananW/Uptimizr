/**
 * OSS cross-engine parity suite — ClickHouse vs golden (Phase C, ADR 0020).
 *
 * Runs every dialect-agnostic aggregation through ClickHouse against the shared
 * fixtures and asserts equality with the engine-independent golden output under
 * the documented tolerance rules. Because DuckDB also matches that same golden
 * (see `@uptimizr/db`'s `duckdbParity.test.ts`), a passing run here proves
 * DuckDB↔ClickHouse parity by transitivity.
 *
 * The suite is **skipped gracefully** when no ClickHouse server is reachable
 * (unless `CLICKHOUSE_PARITY_REQUIRED` is set), so it never fails a dev run or
 * the default `build` job without the optional scale engine. Point it at a
 * server with the `CLICKHOUSE_*` env vars (defaults to the local docker-compose
 * instance). It uses a throwaway database that it drops on teardown.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  PARITY_CASES,
  PARITY_EVENTS,
  clickhouseDialect,
  diffParity,
  numericColumnsForSpec,
} from "@uptimizr/db";
import { createClickhouseClient, type ClickhouseClient } from "../client.js";
import { migrateClickhouse } from "../migrations.js";
import { insertEvents } from "../events.js";
import { runClickhouseQuery } from "../queries.js";

const CH_URL = process.env.CLICKHOUSE_URL ?? "http://localhost:8123";
const CH_USER = process.env.CLICKHOUSE_USER ?? "default";
const CH_PASSWORD = process.env.CLICKHOUSE_PASSWORD ?? "";
const TEST_DB = "uptimizr_ch_parity_test";

/**
 * Probe the server's `/ping` so the suite can skip when it is unreachable.
 *
 * Set `CLICKHOUSE_PARITY_REQUIRED=1` (the "Store parity (ClickHouse)" CI job
 * does) to turn an unreachable server into a hard failure instead of a skip, so
 * an outage of the service container can never pass as a green run.
 */
async function clickhouseReachable(): Promise<boolean> {
  let reason: unknown;
  try {
    const res = await fetch(`${CH_URL.replace(/\/$/, "")}/ping`, {
      signal: AbortSignal.timeout(2000),
    });
    if (res.ok) return true;
    reason = new Error(`HTTP ${res.status}`);
  } catch (error) {
    reason = error;
  }
  if (process.env.CLICKHOUSE_PARITY_REQUIRED) {
    throw new Error(
      `CLICKHOUSE_PARITY_REQUIRED is set but ClickHouse is unreachable at ${CH_URL}`,
      { cause: reason },
    );
  }
  return false;
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

  it("covers all 69 aggregations, plus the query DSL and the insight bucket series", () => {
    expect(PARITY_CASES.map((c) => c.name)).toEqual([
      "listSessions",
      "pointerHeatmap",
      "meshUvHeatmap",
      "meshUvHeatmapByMesh",
      "worldHeatmap",
      "worldHeatmapStats",
      "worldHeatmapRegion",
      "gazeHeatmap",
      "gazeHeatmapStats",
      "cameraDirectionHeatmap",
      "cameraPositionHeatmap",
      "sessionTrajectory",
      "aggregateTrajectories",
      "clickGazeRay",
      "flowHeatmap",
      "flowHeatmapByStandpoint",
      "topMeshes",
      "meshDwell",
      "meshBlindSpots",
      "topMeshesBySource",
      "topMeshesTrend",
      "meshInteractionKinds",
      "reachability",
      "topInputActions",
      "customEventVocabulary",
      "perfSummary",
      "renderScaleTruth",
      "perfDistribution",
      "fpsHistogram",
      "frameTimePercentiles",
      "jankRate",
      "perfByDevice",
      "perfByScene",
      "resourcePercentiles",
      "stabilityCounts",
      "graphicsDiagnosticCounts",
      "errorHeatmap",
      "boundaryHeatmap",
      "boundaryHeatmapStats",
      "boundaryContacts",
      "renderingTechnology",
      "deadClicks",
      "rageClicks",
      "hoverDwell",
      "compileStalls",
      "arPlacementTimeToPlace",
      "arPlacementAttempts",
      "arPlacementSurfaces",
      "resourceSummary",
      "capabilityChanges",
      "cameraGestures",
      "perfDaily",
      "eventsDaily",
      "distinctScenes",
      "timeseries",
      "eventTypeCounts",
      "sceneCoverage",
      "perfHeatmap",
      "cameraDistance",
      "navigationStats",
      "backtrackRatio",
      "xrRotationRate",
      "xrSourceUsage",
      "xrAbandonment",
      "xrLocomotion",
      "trackingQuality",
      "interactionsBySource",
      "funnel",
      "loadBounceFunnel",
      // Compiled through the query DSL rather than called directly (ADR 0051 §3):
      // the delegated compiler's specs must execute here like any other.
      "dsl:topMeshes",
      "dsl:meshSourcesFiltered",
      "dsl:funnel",
      // Compiled through the generic group-by tier (#304): one shared
      // `SELECT <dims>, <measures> … GROUP BY <dims>` rendered from registry
      // data, at a grain the metric’s own builder cannot produce.
      "dsl:genericMeshesByEventType",
      "dsl:genericMeshesByScene",
      "dsl:genericEventCountsByScene",
      "dsl:genericEventCountsByEngine",
      "dsl:genericMeshSourcesByScene",
      "dsl:genericInteractionsByCameraMode",
      // The one query behind both insight primitives (ADR 0051 §4), one case per
      // aggregate shape its measure catalog can render.
      "metricBuckets:count",
      "metricBuckets:sessions",
      "metricBuckets:quantile",
      "metricBuckets:sum",
      "metricBuckets:geometry",
      "metricBuckets:emptySeries",
      "metricBuckets:dayGrain",
      // --- anomalies (#306): the grouped split behind contributor attribution.
      "metricBuckets:splitEventType",
      "metricBuckets:splitMesh",
      "metricBuckets:splitScene",
    ]);
  });

  for (const parityCase of PARITY_CASES) {
    it(`matches golden: ${parityCase.name}`, async () => {
      const spec = parityCase.build(clickhouseDialect);
      const rows = await runClickhouseQuery<Record<string, unknown>>(ch, spec);
      const errors = diffParity(rows, parityCase.golden, {
        sortKeys: parityCase.sortKeys,
        ignoreColumns: parityCase.ignoreColumns,
        // Tolerance rule 5 (ADR 0051 §2): ClickHouse is the engine that renders
        // 64-bit integers and decimals as JSON strings over HTTP, so this is the
        // suite that most needs to prove `runClickhouseQuery` coerces at the edge.
        numericColumns: numericColumnsForSpec(spec),
      });
      expect(errors, errors.join("\n")).toEqual([]);
    });
  }
});
