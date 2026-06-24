/**
 * OSS cross-engine parity suite — DuckDB vs golden (Phase C, ADR 0020).
 *
 * Runs every dialect-agnostic aggregation through DuckDB against the shared
 * fixtures and asserts equality with the engine-independent golden output under
 * the documented tolerance rules. Because the golden is authored as truth, a
 * second engine (ClickHouse in the scale tier) that also matches it is, by
 * transitivity, in parity with DuckDB — which is how the separately-licensed
 * DuckDB-vs-ClickHouse suite reuses these exact cases and golden.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PARITY_CASES, PARITY_EVENTS, diffParity, duckdbDialect } from "../index.js";
import { createDuckdbClient, type DuckdbClient } from "../duckdb/client.js";
import { migrateDuckdb } from "../duckdb/migrations.js";
import { insertEvents } from "../duckdb/events.js";
import { runDuckdbQuery } from "../duckdb/queries.js";

describe("duckdb parity (vs golden)", () => {
  let db: DuckdbClient;

  beforeAll(async () => {
    db = await createDuckdbClient(":memory:");
    await migrateDuckdb(db);
    await insertEvents(db, PARITY_EVENTS);
  });

  afterAll(async () => {
    await db.close();
  });

  it("covers all 47 aggregations", () => {
    expect(PARITY_CASES.map((c) => c.name)).toEqual([
      "listSessions",
      "pointerHeatmap",
      "worldHeatmap",
      "gazeHeatmap",
      "cameraDirectionHeatmap",
      "cameraPositionHeatmap",
      "sessionTrajectory",
      "aggregateTrajectories",
      "clickGazeRay",
      "flowHeatmap",
      "flowHeatmapByStandpoint",
      "topMeshes",
      "meshDwell",
      "topMeshesBySource",
      "topMeshesTrend",
      "meshInteractionKinds",
      "topInputActions",
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
      "funnel",
    ]);
  });

  for (const parityCase of PARITY_CASES) {
    it(`matches golden: ${parityCase.name}`, async () => {
      const rows = await runDuckdbQuery<Record<string, unknown>>(
        db,
        parityCase.build(duckdbDialect),
      );
      const errors = diffParity(rows, parityCase.golden, {
        sortKeys: parityCase.sortKeys,
        ignoreColumns: parityCase.ignoreColumns,
      });
      expect(errors, errors.join("\n")).toEqual([]);
    });
  }
});
