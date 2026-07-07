import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AnyEvent } from "@uptimizr/schema";
import { buildSceneRetention, duckdbDialect } from "../index.js";
import type { SceneRetentionOptions, SceneRetentionRow } from "../index.js";
import { createDuckdbClient, type DuckdbClient } from "../duckdb/client.js";
import { migrateDuckdb } from "../duckdb/migrations.js";
import { insertEvents } from "../duckdb/events.js";
import { runDuckdbQuery } from "../duckdb/queries.js";

/**
 * Canned scene/level retention funnel (#147) — focused DuckDB tests for the
 * "consecutive `scene_change` targets → directed link, weighted by distinct
 * sessions" semantics, including the edge cases the cross-engine parity golden
 * can't exercise without perturbing shared fixtures: a single scene_change (no
 * link), a repeated hop across sessions, and a self-transition.
 */

const PID = "retention-project";
const T0 = Date.UTC(2024, 5, 16, 10, 0, 0);
const RANGE = { since: T0 - 60_000, until: T0 + 600_000 };

/** A `scene_change` marker for `session` entering `scene` at `T0 + offsetMs`. */
function sceneChange(session: string, scene: string, offsetMs: number): AnyEvent {
  return {
    type: "scene_change",
    projectId: PID,
    sessionId: session,
    ts: T0 + offsetMs,
    sdkVersion: "0.1.0",
    sceneId: scene,
  } as AnyEvent;
}

async function run(
  db: DuckdbClient,
  opts: SceneRetentionOptions = RANGE,
): Promise<SceneRetentionRow[]> {
  const rows = await runDuckdbQuery<SceneRetentionRow>(
    db,
    buildSceneRetention(PID, opts, duckdbDialect),
  );
  return rows.map((r) => ({
    from_scene: String(r.from_scene),
    to_scene: String(r.to_scene),
    sessions: Number(r.sessions),
  }));
}

describe("buildSceneRetention (canned scene funnel)", () => {
  let db: DuckdbClient;

  beforeEach(async () => {
    db = await createDuckdbClient(":memory:");
    await migrateDuckdb(db);
  });

  afterEach(async () => {
    await db.close();
  });

  it("links consecutive scene_change targets in observed order", async () => {
    await insertEvents(db, [
      // sA walks lobby → gallery → checkout.
      sceneChange("sA", "lobby", 0),
      sceneChange("sA", "gallery", 1_000),
      sceneChange("sA", "checkout", 2_000),
    ]);

    expect(await run(db)).toEqual([
      { from_scene: "gallery", to_scene: "checkout", sessions: 1 },
      { from_scene: "lobby", to_scene: "gallery", sessions: 1 },
    ]);
  });

  it("weights a link by distinct sessions and orders by that count", async () => {
    await insertEvents(db, [
      // Two sessions make lobby → gallery; only one continues to checkout.
      sceneChange("sA", "lobby", 0),
      sceneChange("sA", "gallery", 1_000),
      sceneChange("sA", "checkout", 2_000),
      sceneChange("sB", "lobby", 0),
      sceneChange("sB", "gallery", 1_000),
    ]);

    expect(await run(db)).toEqual([
      { from_scene: "lobby", to_scene: "gallery", sessions: 2 },
      { from_scene: "gallery", to_scene: "checkout", sessions: 1 },
    ]);
  });

  it("counts a session once per link even if it repeats the hop", async () => {
    await insertEvents(db, [
      // sA bounces lobby → gallery → lobby → gallery: the lobby→gallery hop
      // happens twice but the session is one distinct session for that link.
      sceneChange("sA", "lobby", 0),
      sceneChange("sA", "gallery", 1_000),
      sceneChange("sA", "lobby", 2_000),
      sceneChange("sA", "gallery", 3_000),
    ]);

    expect(await run(db)).toEqual([
      { from_scene: "gallery", to_scene: "lobby", sessions: 1 },
      { from_scene: "lobby", to_scene: "gallery", sessions: 1 },
    ]);
  });

  it("chains nearest-following markers across a deep multi-scene walk", async () => {
    await insertEvents(db, [
      // sA takes the full path lobby → gallery → arena → boss → checkout.
      sceneChange("sA", "lobby", 0),
      sceneChange("sA", "gallery", 1_000),
      sceneChange("sA", "arena", 2_000),
      sceneChange("sA", "boss", 3_000),
      sceneChange("sA", "checkout", 4_000),
      // sB drops out at the arena: lobby → gallery → arena.
      sceneChange("sB", "lobby", 500),
      sceneChange("sB", "gallery", 1_500),
      sceneChange("sB", "arena", 2_500),
      // A pointer_click interleaved between two markers must not become the
      // "next" node — only the nearest following scene_change counts.
      {
        type: "pointer_click",
        projectId: PID,
        sessionId: "sA",
        ts: T0 + 2_500,
        sdkVersion: "0.1.0",
        sceneId: "arena",
        screen: [0.5, 0.5],
      } as AnyEvent,
    ]);

    // Each marker links only to the very next marker in its own session; shared
    // early hops (lobby→gallery, gallery→arena) accrue two distinct sessions.
    expect(await run(db)).toEqual([
      { from_scene: "gallery", to_scene: "arena", sessions: 2 },
      { from_scene: "lobby", to_scene: "gallery", sessions: 2 },
      { from_scene: "arena", to_scene: "boss", sessions: 1 },
      { from_scene: "boss", to_scene: "checkout", sessions: 1 },
    ]);
  });

  it("produces no link for a session with a single scene_change", async () => {
    await insertEvents(db, [sceneChange("solo", "lobby", 0)]);
    expect(await run(db)).toEqual([]);
  });

  it("ignores non-scene_change events and out-of-range markers", async () => {
    await insertEvents(db, [
      sceneChange("sA", "lobby", 0),
      sceneChange("sA", "gallery", 1_000),
      // A pointer_click between the markers must not become a node.
      {
        type: "pointer_click",
        projectId: PID,
        sessionId: "sA",
        ts: T0 + 500,
        sdkVersion: "0.1.0",
        sceneId: "lobby",
        screen: [0.5, 0.5],
      } as AnyEvent,
      // An out-of-range marker is excluded by the range filter.
      sceneChange("sA", "checkout", 5_000_000),
    ]);

    expect(await run(db, RANGE)).toEqual([
      { from_scene: "lobby", to_scene: "gallery", sessions: 1 },
    ]);
  });

  it("respects the limit (busiest links first)", async () => {
    await insertEvents(db, [
      sceneChange("sA", "lobby", 0),
      sceneChange("sA", "gallery", 1_000),
      sceneChange("sB", "lobby", 0),
      sceneChange("sB", "gallery", 1_000),
      sceneChange("sC", "gallery", 0),
      sceneChange("sC", "checkout", 1_000),
    ]);

    expect(await run(db, { ...RANGE, limit: 1 })).toEqual([
      { from_scene: "lobby", to_scene: "gallery", sessions: 2 },
    ]);
  });
});
