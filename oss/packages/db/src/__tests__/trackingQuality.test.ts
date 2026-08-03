import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AnyEvent } from "@uptimizr/schema";
import { buildTrackingQuality, clickhouseDialect, duckdbDialect } from "../index.js";
import type { TrackingQualityRow } from "../index.js";
import { createDuckdbClient, type DuckdbClient } from "../duckdb/client.js";
import { migrateDuckdb } from "../duckdb/migrations.js";
import { insertEvents } from "../duckdb/events.js";
import { runDuckdbQuery } from "../duckdb/queries.js";

/**
 * XR tracking-quality builder (#155, ADR 0048) — DuckDB tests for the
 * per-session degraded-time roll-up: the `capability_change { kind: "tracking" }`
 * gate, the hand vs. controller split (via `source`), and the reuse of the shared
 * `visible_ms` column for the degraded-episode `durationMs`.
 */

const PID = "tracking-quality-project";
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

/** A `capability_change { kind: "tracking" }` degraded episode. */
function tracking(
  sessionId: string,
  ts: number,
  source: string,
  durationMs: number,
  handedness?: string,
): AnyEvent {
  return ev(sessionId, "capability_change", ts, {
    kind: "tracking",
    from: source === "hand" ? "hand" : "6dof",
    to: "lost",
    source,
    durationMs,
    ...(handedness ? { handedness } : {}),
  });
}

async function run(db: DuckdbClient): Promise<TrackingQualityRow[]> {
  const rows = await runDuckdbQuery<TrackingQualityRow>(
    db,
    buildTrackingQuality(PID, RANGE, duckdbDialect),
  );
  return rows.map((r) => ({
    session_id: String(r.session_id),
    degraded_ms: Number(r.degraded_ms),
    hand_degraded_ms: Number(r.hand_degraded_ms),
    controller_degraded_ms: Number(r.controller_degraded_ms),
    degraded_episodes: Number(r.degraded_episodes),
    started_at: String(r.started_at),
    ended_at: String(r.ended_at),
  }));
}

describe("buildTrackingQuality (per XR-session tracking quality)", () => {
  let db: DuckdbClient;

  beforeEach(async () => {
    db = await createDuckdbClient(":memory:");
    await migrateDuckdb(db);
  });

  afterEach(async () => {
    await db.close();
  });

  it("sums degraded time per session and splits hand vs. controller", async () => {
    await insertEvents(db, [
      // Hand session: two hand episodes (1000 + 500 ms), plus non-tracking events
      // that bound the whole-session span.
      ev("hand-sess", "session_start", T0),
      tracking("hand-sess", T0 + 1_000, "hand", 1_000, "left"),
      tracking("hand-sess", T0 + 5_000, "hand", 500, "left"),
      ev("hand-sess", "pointer_move", T0 + 10_000, { source: "hand" }),
      // Controller session: one controller episode (2000 ms).
      ev("ctrl-sess", "session_start", T0 + 1_000),
      tracking("ctrl-sess", T0 + 2_000, "xr-controller", 2_000, "right"),
      // Clean session: no tracking transition → omitted entirely.
      ev("clean-sess", "session_start", T0 + 2_000),
      ev("clean-sess", "pointer_click", T0 + 3_000, { screen: [0.5, 0.5], button: 0 }),
    ]);

    const rows = await run(db);
    const by = new Map(rows.map((r) => [r.session_id, r]));

    expect(by.has("clean-sess")).toBe(false);
    expect(rows).toHaveLength(2);

    const hand = by.get("hand-sess")!;
    expect(hand.degraded_ms).toBe(1_500);
    expect(hand.hand_degraded_ms).toBe(1_500);
    expect(hand.controller_degraded_ms).toBe(0);
    expect(hand.degraded_episodes).toBe(2);

    const ctrl = by.get("ctrl-sess")!;
    expect(ctrl.degraded_ms).toBe(2_000);
    expect(ctrl.hand_degraded_ms).toBe(0);
    expect(ctrl.controller_degraded_ms).toBe(2_000);
    expect(ctrl.degraded_episodes).toBe(1);
  });

  it("bounds the whole session span, not just the tracking events", async () => {
    await insertEvents(db, [
      ev("span-sess", "session_start", T0),
      tracking("span-sess", T0 + 5_000, "xr-controller", 1_000),
      ev("span-sess", "pointer_move", T0 + 20_000, { source: "xr-controller" }),
    ]);

    const [row] = await run(db);
    // The span reaches the trailing pointer_move (T0+20s), not the tracking event
    // at T0+5s. Compare the span difference so the engine-local timestamp
    // formatting (no timezone suffix) cancels out.
    const started = new Date(row!.started_at).getTime();
    const ended = new Date(row!.ended_at).getTime();
    expect(ended - started).toBe(20_000);
  });

  it("renders on the ClickHouse dialect (dialect-agnostic)", () => {
    const spec = buildTrackingQuality(PID, RANGE, clickhouseDialect);
    expect(spec.query).toContain("capability_change");
    expect(spec.query).toContain("name = 'tracking'");
    expect(spec.query).toContain("source = 'hand'");
    expect(spec.query).toContain("source = 'xr-controller'");
    // No DuckDB-only helpers leak into the ClickHouse render.
    expect(spec.query).not.toContain("json_extract_string");
  });
});
