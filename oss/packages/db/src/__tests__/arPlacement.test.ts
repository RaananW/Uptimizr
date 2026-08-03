import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AnyEvent } from "@uptimizr/schema";
import {
  buildArPlacementAttempts,
  buildArPlacementSurfaces,
  buildArPlacementTimeToPlace,
  duckdbDialect,
} from "../index.js";
import type {
  ArPlacementAttemptsRow,
  ArPlacementSurfaceRow,
  ArPlacementTimeToPlaceRow,
} from "../index.js";
import { createDuckdbClient, type DuckdbClient } from "../duckdb/client.js";
import { migrateDuckdb } from "../duckdb/migrations.js";
import { insertEvents } from "../duckdb/events.js";
import { runDuckdbQuery } from "../duckdb/queries.js";

/**
 * AR placement funnel builders (#156, ADR 0048 §1) — DuckDB tests for the
 * time-to-place distribution, the re-placement (attempts) distribution, and the
 * coarse-surface breakdown. `mesh`/`position` promote to columns; the
 * `surface`/`attempts`/`timeToPlaceMs`/`scale` fields are read back out of the
 * JSON `payload`, so these tests double as coverage for the payload extraction.
 */

const PID = "ar-placement-project";
const T0 = Date.UTC(2024, 5, 16, 10, 0, 0);
const RANGE = { since: T0 - 60_000, until: T0 + 600_000 };

interface PlacementInput {
  sessionId?: string;
  ts: number;
  mesh: string;
  position: [number, number, number];
  surface?: string;
  attempts: number;
  timeToPlaceMs: number;
  scale: number;
  final: boolean;
}

function placement(p: PlacementInput): AnyEvent {
  const { sessionId = "s1", ts, ...rest } = p;
  return {
    type: "ar_placement",
    projectId: PID,
    sessionId,
    ts,
    sdkVersion: "0.1.0",
    sceneId: "showroom",
    ...rest,
  } as AnyEvent;
}

/** A representative spread of settles used by several cases. */
const SETTLES: AnyEvent[] = [
  placement({
    ts: T0 + 1_000,
    mesh: "sofa",
    position: [1, 0, 1],
    surface: "floor",
    attempts: 1,
    timeToPlaceMs: 1_500,
    scale: 1,
    final: false,
  }),
  placement({
    ts: T0 + 2_000,
    mesh: "lamp",
    position: [2, 0, 1],
    surface: "table",
    attempts: 3,
    timeToPlaceMs: 4_200,
    scale: 0.5,
    final: false,
  }),
  placement({
    ts: T0 + 3_000,
    mesh: "sofa",
    position: [1, 0, 1],
    surface: "floor",
    attempts: 2,
    timeToPlaceMs: 3_000,
    scale: 1,
    final: true,
  }),
];

describe("AR placement funnel builders (#156, ADR 0048)", () => {
  let db: DuckdbClient;

  beforeEach(async () => {
    db = await createDuckdbClient(":memory:");
    await migrateDuckdb(db);
  });

  afterEach(async () => {
    await db.close();
  });

  it("buckets time-to-place from the payload into fixed bins", async () => {
    await insertEvents(db, SETTLES);
    const rows = await runDuckdbQuery<ArPlacementTimeToPlaceRow>(
      db,
      buildArPlacementTimeToPlace(PID, RANGE, duckdbDialect),
    );
    // Default 2000 ms bins: 1500 -> 0, 3000 -> 2000, 4200 -> 4000.
    expect(
      rows.map((r) => ({ bucket: Number(r.bucket), placements: Number(r.placements) })),
    ).toEqual([
      { bucket: 0, placements: 1 },
      { bucket: 2000, placements: 1 },
      { bucket: 4000, placements: 1 },
    ]);
  });

  it("honours a custom bucket width", async () => {
    await insertEvents(db, SETTLES);
    const rows = await runDuckdbQuery<ArPlacementTimeToPlaceRow>(
      db,
      buildArPlacementTimeToPlace(PID, { ...RANGE, bucketMs: 5000 }, duckdbDialect),
    );
    // 5000 ms bins collapse 1500/3000/4200 all into bucket 0.
    expect(
      rows.map((r) => ({ bucket: Number(r.bucket), placements: Number(r.placements) })),
    ).toEqual([{ bucket: 0, placements: 3 }]);
  });

  it("distributes settles by their re-placement (attempts) count", async () => {
    await insertEvents(db, SETTLES);
    const rows = await runDuckdbQuery<ArPlacementAttemptsRow>(
      db,
      buildArPlacementAttempts(PID, RANGE, duckdbDialect),
    );
    expect(
      rows.map((r) => ({ attempts: Number(r.attempts), placements: Number(r.placements) })),
    ).toEqual([
      { attempts: 1, placements: 1 },
      { attempts: 2, placements: 1 },
      { attempts: 3, placements: 1 },
    ]);
  });

  it("breaks placements down by coarse surface with the average committed scale", async () => {
    await insertEvents(db, SETTLES);
    const rows = await runDuckdbQuery<ArPlacementSurfaceRow>(
      db,
      buildArPlacementSurfaces(PID, RANGE, duckdbDialect),
    );
    const bySurface = Object.fromEntries(rows.map((r) => [r.surface, r]));
    expect(Number(bySurface.floor.placements)).toBe(2);
    expect(Number(bySurface.floor.avg_scale)).toBeCloseTo(1);
    expect(Number(bySurface.table.placements)).toBe(1);
    expect(Number(bySurface.table.avg_scale)).toBeCloseTo(0.5);
    // Most-used surface first.
    expect(rows[0].surface).toBe("floor");
  });

  it("falls back to 'unknown' when the connector could not classify the surface", async () => {
    await insertEvents(db, [
      placement({
        ts: T0 + 1_000,
        mesh: "chair",
        position: [0, 0, 0],
        attempts: 1,
        timeToPlaceMs: 900,
        scale: 1,
        final: true,
      }),
    ]);
    const rows = await runDuckdbQuery<ArPlacementSurfaceRow>(
      db,
      buildArPlacementSurfaces(PID, RANGE, duckdbDialect),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].surface).toBe("unknown");
    expect(Number(rows[0].placements)).toBe(1);
  });

  it("returns no rows when the range excludes every settle", async () => {
    await insertEvents(db, SETTLES);
    const rows = await runDuckdbQuery<ArPlacementTimeToPlaceRow>(
      db,
      buildArPlacementTimeToPlace(PID, { since: T0 + 100_000, until: T0 + 200_000 }, duckdbDialect),
    );
    expect(rows).toEqual([]);
  });
});
