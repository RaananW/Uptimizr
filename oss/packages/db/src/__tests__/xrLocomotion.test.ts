import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AnyEvent } from "@uptimizr/schema";
import { buildXrLocomotionComfort, duckdbDialect } from "../index.js";
import type { XrLocomotionRow } from "../index.js";
import { createDuckdbClient, type DuckdbClient } from "../duckdb/client.js";
import { migrateDuckdb } from "../duckdb/migrations.js";
import { insertEvents } from "../duckdb/events.js";
import { runDuckdbQuery } from "../duckdb/queries.js";

/**
 * XR locomotion & comfort builder (#148) — DuckDB tests for the XR-session gate,
 * the per-kind locomotion breakdown, and the teleport / smooth-fly split. A
 * teleport emits both a `camera_gesture { kind: "fly" }` and a
 * `mesh_interaction { kind: "teleport" }` (ADR 0025), so `fly_gestures` counts
 * both flavours while `teleports` isolates the discrete jumps.
 */

const PID = "xr-loco-project";
const T0 = Date.UTC(2024, 5, 16, 10, 0, 0);
const RANGE = { since: T0 - 60_000, until: T0 + 600_000 };

function ev(
  sessionId: string,
  type: string,
  ts: number,
  extra: Record<string, unknown> = {},
): AnyEvent {
  return {
    type,
    projectId: PID,
    sessionId,
    ts,
    sdkVersion: "0.1.0",
    sceneId: "arena",
    ...extra,
  } as AnyEvent;
}

/** `camera_gesture` with a `kind` + `durationMs` and an explicit input `source`. */
function gesture(
  sessionId: string,
  ts: number,
  kind: string,
  durationMs: number,
  source = "xr-controller",
): AnyEvent {
  return ev(sessionId, "camera_gesture", ts, { kind, durationMs, source });
}

/** `mesh_interaction` (teleport target pick / select) from an XR source. */
function meshHit(sessionId: string, ts: number, kind: string, source = "xr-controller"): AnyEvent {
  return ev(sessionId, "mesh_interaction", ts, { mesh: "floor", kind, source });
}

async function run(db: DuckdbClient): Promise<XrLocomotionRow[]> {
  return runDuckdbQuery<XrLocomotionRow>(db, buildXrLocomotionComfort(PID, RANGE, duckdbDialect));
}

describe("buildXrLocomotionComfort (per XR-session locomotion + comfort)", () => {
  let db: DuckdbClient;

  beforeEach(async () => {
    db = await createDuckdbClient(":memory:");
    await migrateDuckdb(db);
  });

  afterEach(async () => {
    await db.close();
  });

  it("breaks locomotion down per XR session and isolates teleports from smooth flies", async () => {
    await insertEvents(db, [
      // xr1: heavy smooth locomotion — 3 flies + 1 navigate, plus 2 teleports.
      gesture("xr1", T0 + 1_000, "fly", 100),
      gesture("xr1", T0 + 2_000, "fly", 200),
      gesture("xr1", T0 + 3_000, "fly", 300),
      gesture("xr1", T0 + 4_000, "navigate", 150),
      meshHit("xr1", T0 + 3_100, "teleport"),
      meshHit("xr1", T0 + 3_200, "teleport"),
      // xr2: teleport-dominant — a single teleport-driven fly + its target pick.
      gesture("xr2", T0 + 1_000, "fly", 500),
      meshHit("xr2", T0 + 1_100, "teleport"),
    ]);

    const rows = await run(db);
    const byId = Object.fromEntries(rows.map((r) => [r.session_id, r]));

    expect(Number(byId.xr1.fly_gestures)).toBe(3);
    expect(Number(byId.xr1.navigate_gestures)).toBe(1);
    expect(Number(byId.xr1.teleports)).toBe(2);
    expect(Number(byId.xr1.locomotion_ms)).toBe(750);

    expect(Number(byId.xr2.fly_gestures)).toBe(1);
    expect(Number(byId.xr2.navigate_gestures)).toBe(0);
    expect(Number(byId.xr2.teleports)).toBe(1);
    expect(Number(byId.xr2.locomotion_ms)).toBe(500);

    // Ordered by locomotion effort so the highest-risk sessions surface first.
    expect(rows.map((r) => r.session_id)).toEqual(["xr1", "xr2"]);
  });

  it("excludes sessions with no XR input source (flat-screen locomotion is not comfort-relevant)", async () => {
    await insertEvents(db, [
      // An XR session so the query returns at least one row.
      gesture("xr1", T0 + 1_000, "fly", 120),
      // A mouse-only session that also flew — must be omitted entirely.
      gesture("flat1", T0 + 1_000, "fly", 999, "mouse"),
      gesture("flat1", T0 + 2_000, "navigate", 999, "mouse"),
    ]);

    const rows = await run(db);
    expect(rows.map((r) => r.session_id)).toEqual(["xr1"]);
  });

  it("includes an XR session with no locomotion as an all-zero row", async () => {
    await insertEvents(db, [
      // Qualifies as XR via a hand select, but never moved the viewpoint.
      meshHit("xrIdle", T0 + 1_000, "select", "hand"),
    ]);

    const rows = await run(db);
    expect(rows).toHaveLength(1);
    expect(Number(rows[0].fly_gestures)).toBe(0);
    expect(Number(rows[0].navigate_gestures)).toBe(0);
    expect(Number(rows[0].teleports)).toBe(0);
    expect(Number(rows[0].locomotion_ms)).toBe(0);
  });

  it("returns no rows when the range excludes every event", async () => {
    await insertEvents(db, [gesture("xr1", T0 + 1_000, "fly", 100)]);
    const rows = await runDuckdbQuery<XrLocomotionRow>(
      db,
      buildXrLocomotionComfort(PID, { since: T0 + 100_000, until: T0 + 200_000 }, duckdbDialect),
    );
    expect(rows).toEqual([]);
  });
});
