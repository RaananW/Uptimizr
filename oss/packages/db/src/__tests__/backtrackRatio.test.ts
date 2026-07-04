import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AnyEvent } from "@uptimizr/schema";
import { buildBacktrackRatio, duckdbDialect } from "../index.js";
import type { BacktrackRatioRow } from "../index.js";
import { createDuckdbClient, type DuckdbClient } from "../duckdb/client.js";
import { migrateDuckdb } from "../duckdb/migrations.js";
import { insertEvents } from "../duckdb/events.js";
import { runDuckdbQuery } from "../duckdb/queries.js";

/**
 * Path-retrace / backtracking ratio (#153) — focused DuckDB tests for the
 * coarse-grid revisit proxy: consecutive dwell samples must collapse (not
 * inflate the ratio), a re-entered cell must count as a revisit, and the ratio
 * must pool per scene into a leaderboard ordered by backtrack ratio.
 */

const PID = "backtrack-project";
const T0 = Date.UTC(2024, 5, 16, 10, 0, 0);
const RANGE = { since: T0 - 60_000, until: T0 + 60_000 };

/** A `camera_sample` at world `(x, 0, z)`, `ms` after T0, in `scene`, for `session`. */
function sample(session: string, scene: string, ms: number, x: number, z: number): AnyEvent {
  return {
    type: "camera_sample",
    projectId: PID,
    sessionId: session,
    ts: T0 + ms,
    sdkVersion: "0.1.0",
    sceneId: scene,
    position: [x, 0, z],
    direction: [0, 0, 1],
  } as AnyEvent;
}

async function run(db: DuckdbClient, cellSize = 2): Promise<BacktrackRatioRow[]> {
  const rows = await runDuckdbQuery<Record<string, unknown>>(
    db,
    buildBacktrackRatio(PID, { ...RANGE, cellSize }, duckdbDialect),
  );
  return rows.map((r) => ({
    scene: String(r.scene ?? ""),
    sessions: Number(r.sessions),
    entries: Number(r.entries),
    revisits: Number(r.revisits),
    backtrack_ratio: Number(r.backtrack_ratio),
  }));
}

describe("buildBacktrackRatio (coarse-grid revisit proxy)", () => {
  let db: DuckdbClient;

  beforeEach(async () => {
    db = await createDuckdbClient(":memory:");
    await migrateDuckdb(db);
  });

  afterEach(async () => {
    await db.close();
  });

  it("collapses dwell, counts re-entries, and pools per scene into a leaderboard", async () => {
    await insertEvents(db, [
      // scene "hall", session s1 — walks 0 -> 1 -> 2 then BACK to 1 -> 0.
      // Cells (cellSize 2): x=0.5 dwells in the start cell (0) and must NOT count.
      sample("s1", "hall", 1_000, 0, 0), // enter cell 0 (first sample)
      sample("s1", "hall", 2_000, 0.5, 0), // dwell in cell 0 — collapsed
      sample("s1", "hall", 3_000, 3, 0), // enter cell 1
      sample("s1", "hall", 4_000, 5, 0), // enter cell 2
      sample("s1", "hall", 5_000, 3, 0), // re-enter cell 1 -> revisit
      sample("s1", "hall", 6_000, 1, 0), // re-enter cell 0 -> revisit
      // scene "hall", session s2 — a clean straight walk, zero backtracking.
      sample("s2", "hall", 1_000, 0, 0), // cell 0
      sample("s2", "hall", 2_000, 2, 0), // cell 1
      sample("s2", "hall", 3_000, 4, 0), // cell 2
      // scene "plaza", session s3 — pure standing/dwell in one cell.
      sample("s3", "plaza", 1_000, 0, 0),
      sample("s3", "plaza", 2_000, 0.2, 0),
      sample("s3", "plaza", 3_000, 0.3, 0),
    ]);

    const rows = await run(db);

    // Leaderboard ordered by backtrack ratio, worst first.
    expect(rows.map((r) => r.scene)).toEqual(["hall", "plaza"]);

    // hall: s1 has 5 entries / 3 distinct cells = 2 revisits; s2 has 3 entries /
    // 3 distinct = 0. Pooled: 8 entries, 2 revisits -> 0.25 over 2 sessions.
    expect(rows[0]).toMatchObject({
      scene: "hall",
      sessions: 2,
      entries: 8,
      revisits: 2,
    });
    expect(rows[0]!.backtrack_ratio).toBeCloseTo(0.25, 6);

    // plaza: dwelling never leaves the cell, so one entry and zero revisits.
    expect(rows[1]).toMatchObject({
      scene: "plaza",
      sessions: 1,
      entries: 1,
      revisits: 0,
      backtrack_ratio: 0,
    });
  });

  it("returns no rows when there are no camera samples in range", async () => {
    await insertEvents(db, [sample("s1", "hall", -120_000, 0, 0)]);
    expect(await run(db)).toEqual([]);
  });

  it("cell size controls what counts as the same area", async () => {
    // Three samples at x = 0, 3, 0. With a coarse 10-unit cell they all fall in
    // cell 0 (one entry, no revisit); with a fine 1-unit cell 0 -> 3 -> 0 is a
    // real out-and-back (one revisit of cell 0).
    await insertEvents(db, [
      sample("s1", "hall", 1_000, 0, 0),
      sample("s1", "hall", 2_000, 3, 0),
      sample("s1", "hall", 3_000, 0, 0),
    ]);

    const coarse = await run(db, 10);
    expect(coarse[0]).toMatchObject({ scene: "hall", entries: 1, revisits: 0 });

    const fine = await run(db, 1);
    expect(fine[0]).toMatchObject({ scene: "hall", entries: 3, revisits: 1 });
    expect(fine[0]!.backtrack_ratio).toBeCloseTo(1 / 3, 6);
  });
});
