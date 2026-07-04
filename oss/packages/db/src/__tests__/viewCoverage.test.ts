import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AnyEvent } from "@uptimizr/schema";
import { buildViewCoverageHistogram, duckdbDialect } from "../index.js";
import type { ViewCoverageHistogramRow } from "../index.js";
import { createDuckdbClient, type DuckdbClient } from "../duckdb/client.js";
import { migrateDuckdb } from "../duckdb/migrations.js";
import { insertEvents } from "../duckdb/events.js";
import { runDuckdbQuery } from "../duckdb/queries.js";

/**
 * 360° view-coverage histogram (#146) — focused DuckDB tests. Each session's
 * `camera_sample` directions are binned into the view-direction dome grid; the
 * fraction of the `bins × bins` cells it visited is its coverage score, and
 * sessions are grouped into 25%-wide buckets. With `bins = 2` the grid has four
 * cells, so 1/2/3/4 distinct cells map cleanly to 25/50/75/100% coverage — the
 * exact bucket boundaries we want to assert (including the `least(…, 3)` fold
 * that keeps a 100% session in the top `75` bucket rather than a fifth `100`).
 */

const PID = "coverage-project";
const T0 = Date.UTC(2024, 5, 16, 10, 0, 0);
const RANGE = { since: T0 - 60_000, until: T0 + 60_000 };

/**
 * Four direction vectors that land in the four distinct dome cells when
 * `bins = 2` (verified: bin ids 0/1/2/3). The azimuth split follows the sign of
 * `z`, the elevation split the sign of `y`; `x` is a small non-zero constant so
 * `atan2(z, x)` stays clear of the ±π wrap boundary.
 */
const CELL: Record<string, [number, number, number]> = {
  c0: [0.2, -0.7, -0.7],
  c1: [0.2, 0.7, -0.7],
  c2: [0.2, -0.7, 0.7],
  c3: [0.2, 0.7, 0.7],
};

function sample(sessionId: string, ts: number, direction: [number, number, number]): AnyEvent {
  return {
    type: "camera_sample",
    projectId: PID,
    sessionId,
    ts,
    sdkVersion: "0.1.0",
    sceneId: "lobby",
    position: [0, 0, 0],
    direction,
  } as AnyEvent;
}

async function run(
  db: DuckdbClient,
  opts: Record<string, unknown>,
): Promise<Record<number, number>> {
  const rows = await runDuckdbQuery<ViewCoverageHistogramRow>(
    db,
    buildViewCoverageHistogram(PID, opts, duckdbDialect),
  );
  return Object.fromEntries(rows.map((r) => [Number(r.bucket), Number(r.sessions)]));
}

describe("buildViewCoverageHistogram", () => {
  let db: DuckdbClient;

  beforeEach(async () => {
    db = await createDuckdbClient(":memory:");
    await migrateDuckdb(db);
  });

  afterEach(async () => {
    await db.close();
  });

  it("buckets sessions by the fraction of the dome grid they visited", async () => {
    await insertEvents(db, [
      // full: all four cells -> 100% -> folded into the 75 (75–100%) bucket.
      sample("full", T0 + 1, CELL.c0),
      sample("full", T0 + 2, CELL.c1),
      sample("full", T0 + 3, CELL.c2),
      sample("full", T0 + 4, CELL.c3),
      // half: two distinct cells -> 50% -> bucket 50 (50–75%).
      sample("half", T0 + 1, CELL.c0),
      sample("half", T0 + 2, CELL.c3),
      // quarter: one cell (sampled twice) -> distinct = 1 -> 25% -> bucket 25.
      sample("quarter", T0 + 1, CELL.c0),
      sample("quarter", T0 + 2, CELL.c0),
    ]);

    const buckets = await run(db, { ...RANGE, bins: 2 });

    expect(buckets).toEqual({ 25: 1, 50: 1, 75: 1 });
    // A full-coverage session must not create a spurious fifth `100` bucket.
    expect(buckets[100]).toBeUndefined();
  });

  it("places a session that saw <25% of the grid in the bottom bucket", async () => {
    // With bins = 3 the grid has nine cells, so one visited cell is ~11% -> `0`.
    await insertEvents(db, [sample("sparse", T0 + 1, CELL.c3), sample("sparse", T0 + 2, CELL.c3)]);

    const buckets = await run(db, { ...RANGE, bins: 3 });

    expect(buckets).toEqual({ 0: 1 });
  });

  it("scopes to a single session when `session` is given", async () => {
    await insertEvents(db, [
      sample("full", T0 + 1, CELL.c0),
      sample("full", T0 + 2, CELL.c1),
      sample("full", T0 + 3, CELL.c2),
      sample("full", T0 + 4, CELL.c3),
      sample("quarter", T0 + 1, CELL.c0),
    ]);

    const buckets = await run(db, { ...RANGE, bins: 2, session: "quarter" });

    expect(buckets).toEqual({ 25: 1 });
  });

  it("returns no rows when no camera samples fall in range", async () => {
    await insertEvents(db, [sample("full", T0 + 1, CELL.c0)]);

    const buckets = await run(db, { since: T0 + 60_000, until: T0 + 120_000, bins: 2 });

    expect(buckets).toEqual({});
  });
});
