/**
 * OSS cross-engine parity suite — SQL Server vs golden **and** SQL Server vs
 * DuckDB (ADR 0020, #85).
 *
 * Runs every dialect-agnostic aggregation through SQL Server against the shared
 * fixtures and asserts equality (under the documented tolerance rules) with
 * (a) the engine-independent golden output and (b) the rows the DuckDB store
 * returns for the very same builders — so the MSSQL ⇄ DuckDB parity the issue
 * asks for is asserted directly, not only by transitivity.
 *
 * The suite is **skipped gracefully** when no SQL Server is reachable, so it
 * never fails a CI/dev run without the optional engine (default `pnpm test`
 * stays Docker-free). Point it at a server with `MSSQL_URL` (or the discrete
 * `MSSQL_*` variables; defaults to the local docker-compose instance). It works
 * in a throwaway database that it drops on teardown.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  PARITY_CASES,
  PARITY_EVENTS,
  createDuckdbClient,
  diffParity,
  duckdbDialect,
  duckdbInsertEvents,
  migrateDuckdb,
  mssqlDialect,
  readDbSettings,
  runDuckdbQuery,
  type DuckdbClient,
  type MssqlSettings,
} from "@uptimizr/db";
import type { MssqlClient } from "../client.js";
import { migrateMssql } from "../migrations.js";
import { insertEvents } from "../events.js";
import { runMssqlQuery } from "../queries.js";
import { discardTestDatabase, mssqlReachable, openTestDatabase } from "./probe.js";

const SETTINGS: MssqlSettings = readDbSettings().mssql;
const DATABASE = "uptimizr_mssql_parity_test";

const available = await mssqlReachable(SETTINGS);

describe.skipIf(!available)("mssql parity (vs golden, vs duckdb)", () => {
  let ms: MssqlClient;
  let duck: DuckdbClient;

  beforeAll(async () => {
    ms = await openTestDatabase(SETTINGS, DATABASE);
    await migrateMssql(ms);
    await insertEvents(ms, PARITY_EVENTS);

    duck = await createDuckdbClient(":memory:");
    await migrateDuckdb(duck);
    await duckdbInsertEvents(duck, PARITY_EVENTS);
  });

  afterAll(async () => {
    await discardTestDatabase(SETTINGS, ms, DATABASE);
    if (duck) await duck.close();
  });

  it("covers all 68 aggregations", () => {
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
    ]);
  });

  for (const parityCase of PARITY_CASES) {
    it(`matches golden: ${parityCase.name}`, async () => {
      const rows = await runMssqlQuery<Record<string, unknown>>(ms, parityCase.build(mssqlDialect));
      const errors = diffParity(rows, parityCase.golden, {
        sortKeys: parityCase.sortKeys,
        ignoreColumns: parityCase.ignoreColumns,
      });
      expect(errors, errors.join("\n")).toEqual([]);
    });

    it(`matches duckdb: ${parityCase.name}`, async () => {
      const msRows = await runMssqlQuery<Record<string, unknown>>(
        ms,
        parityCase.build(mssqlDialect),
      );
      const duckRows = await runDuckdbQuery<Record<string, unknown>>(
        duck,
        parityCase.build(duckdbDialect),
      );
      const errors = diffParity(msRows, duckRows, {
        sortKeys: parityCase.sortKeys,
        ignoreColumns: parityCase.ignoreColumns,
      });
      expect(errors, errors.join("\n")).toEqual([]);
    });
  }
});
