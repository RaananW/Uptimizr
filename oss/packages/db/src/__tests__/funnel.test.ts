import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AnyEvent } from "@uptimizr/schema";
import { buildFunnel, duckdbDialect } from "../index.js";
import type { FunnelStepInput, FunnelStepResultRow } from "../index.js";
import { createDuckdbClient, type DuckdbClient } from "../duckdb/client.js";
import { migrateDuckdb } from "../duckdb/migrations.js";
import { insertEvents } from "../duckdb/events.js";
import { runDuckdbQuery } from "../duckdb/queries.js";

/**
 * Funnel aggregation (#78, ADR 0038) — focused DuckDB tests for the ordered,
 * first-touch, monotonic semantics the cross-engine parity golden can't fully
 * exercise without perturbing the shared fixtures: out-of-order events, re-doing
 * a step, and unreached steps.
 */

const PID = "funnel-project";
const T0 = Date.UTC(2024, 5, 16, 10, 0, 0);
const RANGE = { since: T0 - 60_000, until: T0 + 60_000 };

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
    sceneId: "lobby",
    ...extra,
  } as AnyEvent;
}

/** open → rotate (orbit gesture) → select (pick on a mesh). */
const STEPS: FunnelStepInput[] = [
  { type: "session_start" },
  { type: "camera_gesture", name: "orbit" },
  { type: "mesh_interaction", name: "pick" },
];

async function run(db: DuckdbClient, steps: FunnelStepInput[]): Promise<FunnelStepResultRow[]> {
  const rows = await runDuckdbQuery<FunnelStepResultRow>(
    db,
    buildFunnel(PID, { ...RANGE, steps }, duckdbDialect),
  );
  return rows.map((r) => ({ step: Number(r.step), sessions: Number(r.sessions) }));
}

describe("buildFunnel (ordered step-reach)", () => {
  let db: DuckdbClient;

  beforeEach(async () => {
    db = await createDuckdbClient(":memory:");
    await migrateDuckdb(db);
  });

  afterEach(async () => {
    await db.close();
  });

  it("counts sessions reaching each step in order, with drop-off", async () => {
    await insertEvents(db, [
      // sA: completes all three steps in order.
      ev("sA", "session_start", T0, {
        scene: { cameraType: "arc-rotate", cameraName: "c", meshCount: 1 },
      }),
      ev("sA", "camera_gesture", T0 + 1_000, { kind: "orbit", durationMs: 500 }),
      ev("sA", "mesh_interaction", T0 + 2_000, { mesh: "box", kind: "pick" }),
      // sB: opens and rotates but never selects — drops at step 2.
      ev("sB", "session_start", T0 + 10_000, {
        scene: { cameraType: "arc-rotate", cameraName: "c", meshCount: 1 },
      }),
      ev("sB", "camera_gesture", T0 + 11_000, { kind: "orbit", durationMs: 400 }),
      // sC: opens only — drops at step 1.
      ev("sC", "session_start", T0 + 20_000, {
        scene: { cameraType: "arc-rotate", cameraName: "c", meshCount: 1 },
      }),
    ]);

    expect(await run(db, STEPS)).toEqual([
      { step: 0, sessions: 3 },
      { step: 1, sessions: 2 },
      { step: 2, sessions: 1 },
    ]);
  });

  it("requires steps in order: a later step before its predecessor does not count", async () => {
    await insertEvents(db, [
      // The pick happens BEFORE the orbit gesture, so the funnel is not satisfied:
      // there is no pick at/after the first orbit.
      ev("sX", "session_start", T0, {
        scene: { cameraType: "arc-rotate", cameraName: "c", meshCount: 1 },
      }),
      ev("sX", "mesh_interaction", T0 + 1_000, { mesh: "box", kind: "pick" }),
      ev("sX", "camera_gesture", T0 + 2_000, { kind: "orbit", durationMs: 300 }),
    ]);

    expect(await run(db, STEPS)).toEqual([
      { step: 0, sessions: 1 },
      { step: 1, sessions: 1 },
      { step: 2, sessions: 0 },
    ]);
  });

  it("counts a later step when a qualifying occurrence follows the previous step", async () => {
    await insertEvents(db, [
      // An early stray pick (before orbit) must not disqualify the session when a
      // second pick lands after the orbit.
      ev("sY", "session_start", T0, {
        scene: { cameraType: "arc-rotate", cameraName: "c", meshCount: 1 },
      }),
      ev("sY", "mesh_interaction", T0 + 1_000, { mesh: "box", kind: "pick" }),
      ev("sY", "camera_gesture", T0 + 2_000, { kind: "orbit", durationMs: 300 }),
      ev("sY", "mesh_interaction", T0 + 3_000, { mesh: "box", kind: "pick" }),
    ]);

    expect(await run(db, STEPS)).toEqual([
      { step: 0, sessions: 1 },
      { step: 1, sessions: 1 },
      { step: 2, sessions: 1 },
    ]);
  });

  it("returns zero-reach steps once no session qualifies", async () => {
    await insertEvents(db, [
      ev("sZ", "session_start", T0, {
        scene: { cameraType: "arc-rotate", cameraName: "c", meshCount: 1 },
      }),
    ]);

    expect(await run(db, STEPS)).toEqual([
      { step: 0, sessions: 1 },
      { step: 1, sessions: 0 },
      { step: 2, sessions: 0 },
    ]);
  });
});
