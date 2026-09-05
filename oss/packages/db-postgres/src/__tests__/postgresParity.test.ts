/**
 * OSS cross-engine parity suite — Postgres vs golden **and** Postgres vs DuckDB
 * (ADR 0020, #84).
 *
 * Runs every dialect-agnostic aggregation through Postgres against the shared
 * fixtures and asserts equality (under the documented tolerance rules) with
 * (a) the engine-independent golden output and (b) the rows the DuckDB store
 * returns for the very same builders — so the Postgres ⇄ DuckDB parity the
 * issue asks for is asserted directly, not only by transitivity.
 *
 * The suite is **skipped gracefully** when no Postgres server is reachable, so
 * it never fails a CI/dev run without the optional engine (default `pnpm test`
 * stays Docker-free). Point it at a server with `POSTGRES_URL` (or
 * `DATABASE_URL`; defaults to the local docker-compose instance). It works in a
 * throwaway schema that it drops on teardown.
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
  postgresDialect,
  readDbSettings,
  runDuckdbQuery,
  type DuckdbClient,
  type PostgresSettings,
} from "@uptimizr/db";
import { createPostgresClient, type PostgresClient } from "../client.js";
import { migratePostgres } from "../migrations.js";
import { insertEvents } from "../events.js";
import { runPostgresQuery } from "../queries.js";
import { postgresReachable } from "./probe.js";

const SETTINGS: PostgresSettings = {
  ...readDbSettings().postgres,
  schema: "uptimizr_pg_parity_test",
};

const available = await postgresReachable(SETTINGS.url);

describe.skipIf(!available)("postgres parity (vs golden, vs duckdb)", () => {
  let pg: PostgresClient;
  let duck: DuckdbClient;

  beforeAll(async () => {
    pg = createPostgresClient(SETTINGS);
    await migratePostgres(pg, SETTINGS);
    // Idempotent across local re-runs: wipe any rows from a previous run before
    // re-seeding the fixtures.
    await pg.command("TRUNCATE TABLE events, node_samples");
    await insertEvents(pg, PARITY_EVENTS);

    duck = await createDuckdbClient(":memory:");
    await migrateDuckdb(duck);
    await duckdbInsertEvents(duck, PARITY_EVENTS);
  });

  afterAll(async () => {
    if (pg) {
      await pg.command(`DROP SCHEMA IF EXISTS ${SETTINGS.schema} CASCADE`);
      await pg.close();
    }
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
      const rows = await runPostgresQuery<Record<string, unknown>>(
        pg,
        parityCase.build(postgresDialect),
      );
      const errors = diffParity(rows, parityCase.golden, {
        sortKeys: parityCase.sortKeys,
        ignoreColumns: parityCase.ignoreColumns,
      });
      expect(errors, errors.join("\n")).toEqual([]);
    });

    it(`matches duckdb: ${parityCase.name}`, async () => {
      const pgRows = await runPostgresQuery<Record<string, unknown>>(
        pg,
        parityCase.build(postgresDialect),
      );
      const duckRows = await runDuckdbQuery<Record<string, unknown>>(
        duck,
        parityCase.build(duckdbDialect),
      );
      const errors = diffParity(pgRows, duckRows, {
        sortKeys: parityCase.sortKeys,
        ignoreColumns: parityCase.ignoreColumns,
      });
      expect(errors, errors.join("\n")).toEqual([]);
    });
  }
});
