import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AnyEvent } from "@uptimizr/schema";
import { buildMeshBlindSpots, duckdbDialect } from "../index.js";
import type { MeshBlindSpotRow } from "../index.js";
import { createDuckdbClient, type DuckdbClient } from "../duckdb/client.js";
import { migrateDuckdb } from "../duckdb/migrations.js";
import { insertEvents } from "../duckdb/events.js";
import { runDuckdbQuery } from "../duckdb/queries.js";

/**
 * Blind-spot / never-noticed mesh report (#143) — DuckDB tests for the
 * visibility-vs-engagement cross-reference: high `mesh_visibility` time paired
 * with `mesh_interaction` + `hover_dwell` counts, ranked so the most-seen but
 * least-touched meshes surface first.
 */

const PID = "blind-spot-project";
const T0 = Date.UTC(2024, 5, 16, 10, 0, 0);
const RANGE = { since: T0 - 60_000, until: T0 + 60_000 };

function ev(type: string, ts: number, extra: Record<string, unknown> = {}): AnyEvent {
  return {
    type,
    projectId: PID,
    sessionId: "s1",
    ts,
    sdkVersion: "0.1.0",
    sceneId: "lobby",
    ...extra,
  } as AnyEvent;
}

async function run(
  db: DuckdbClient,
  opts: Parameters<typeof buildMeshBlindSpots>[1],
): Promise<MeshBlindSpotRow[]> {
  const rows = await runDuckdbQuery<MeshBlindSpotRow>(
    db,
    buildMeshBlindSpots(PID, opts, duckdbDialect),
  );
  return rows.map((r) => ({
    mesh: r.mesh,
    visible_ms: Number(r.visible_ms),
    vis_samples: Number(r.vis_samples),
    interactions: Number(r.interactions),
    hover_ms: Number(r.hover_ms),
    hover_episodes: Number(r.hover_episodes),
  }));
}

describe("buildMeshBlindSpots (visibility vs. engagement)", () => {
  let db: DuckdbClient;

  beforeEach(async () => {
    db = await createDuckdbClient(":memory:");
    await migrateDuckdb(db);
  });

  afterEach(async () => {
    await db.close();
  });

  it("ranks the most-seen, least-engaged mesh first", async () => {
    await insertEvents(db, [
      // engraving: highly visible, never touched — the classic blind spot.
      ev("mesh_visibility", T0 + 1_000, { mesh: "engraving", visibleMs: 9000, centeredMs: 4000 }),
      ev("mesh_visibility", T0 + 2_000, { mesh: "engraving", visibleMs: 3000 }),
      // hero: visible AND engaged (clicked + hovered) — not a blind spot.
      ev("mesh_visibility", T0 + 3_000, { mesh: "hero", visibleMs: 8000 }),
      ev("mesh_interaction", T0 + 3_500, { mesh: "hero", kind: "pick" }),
      ev("hover_dwell", T0 + 3_800, { mesh: "hero", dwellMs: 700 }),
      // shelf: visible with a single hover episode, no interactions — mid-rank.
      ev("mesh_visibility", T0 + 4_000, { mesh: "shelf", visibleMs: 5000 }),
      ev("hover_dwell", T0 + 4_500, { mesh: "shelf", dwellMs: 1200 }),
    ]);

    expect(await run(db, RANGE)).toEqual([
      // 0 engagement → first, ordered by visibility among ties handled below.
      {
        mesh: "engraving",
        visible_ms: 12000,
        vis_samples: 2,
        interactions: 0,
        hover_ms: 0,
        hover_episodes: 0,
      },
      // 1 engagement event (hover episode).
      {
        mesh: "shelf",
        visible_ms: 5000,
        vis_samples: 1,
        interactions: 0,
        hover_ms: 1200,
        hover_episodes: 1,
      },
      // 2 engagement events (pick + hover).
      {
        mesh: "hero",
        visible_ms: 8000,
        vis_samples: 1,
        interactions: 1,
        hover_ms: 700,
        hover_episodes: 1,
      },
    ]);
  });

  it("breaks engagement ties by visibility descending", async () => {
    await insertEvents(db, [
      ev("mesh_visibility", T0 + 1_000, { mesh: "low-vis", visibleMs: 2000 }),
      ev("mesh_visibility", T0 + 2_000, { mesh: "high-vis", visibleMs: 7000 }),
    ]);

    const rows = await run(db, RANGE);
    expect(rows.map((r) => r.mesh)).toEqual(["high-vis", "low-vis"]);
  });

  it("excludes meshes that were engaged but never recorded as visible", async () => {
    await insertEvents(db, [
      // Only an interaction + hover, no mesh_visibility → not a blind spot.
      ev("mesh_interaction", T0 + 1_000, { mesh: "clicked-only", kind: "click" }),
      ev("hover_dwell", T0 + 1_500, { mesh: "clicked-only", dwellMs: 900 }),
      ev("mesh_visibility", T0 + 2_000, { mesh: "seen", visibleMs: 4000 }),
    ]);

    const rows = await run(db, RANGE);
    expect(rows.map((r) => r.mesh)).toEqual(["seen"]);
  });

  it("respects the scene filter", async () => {
    await insertEvents(db, [
      ev("mesh_visibility", T0 + 1_000, { mesh: "lobby-art", visibleMs: 6000, sceneId: "lobby" }),
      ev("mesh_visibility", T0 + 2_000, {
        mesh: "gallery-art",
        visibleMs: 6000,
        sceneId: "gallery",
      }),
    ]);

    const rows = await run(db, { ...RANGE, scene: "gallery" });
    expect(rows.map((r) => r.mesh)).toEqual(["gallery-art"]);
  });

  it("respects the session filter and the limit", async () => {
    await insertEvents(db, [
      {
        ...ev("mesh_visibility", T0 + 1_000, { mesh: "a", visibleMs: 5000 }),
        sessionId: "s1",
      } as AnyEvent,
      {
        ...ev("mesh_visibility", T0 + 2_000, { mesh: "b", visibleMs: 5000 }),
        sessionId: "s2",
      } as AnyEvent,
    ]);

    const sessionRows = await run(db, { ...RANGE, session: "s2" });
    expect(sessionRows.map((r) => r.mesh)).toEqual(["b"]);

    const limited = await run(db, { ...RANGE, limit: 1 });
    expect(limited).toHaveLength(1);
  });

  it("returns nothing for an empty range", async () => {
    await insertEvents(db, [ev("mesh_visibility", T0 + 1_000, { mesh: "a", visibleMs: 5000 })]);
    expect(await run(db, { since: T0 + 30_000, until: T0 + 60_000 })).toEqual([]);
  });
});
