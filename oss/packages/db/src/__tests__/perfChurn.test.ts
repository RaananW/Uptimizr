import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AnyEvent } from "@uptimizr/schema";
import { buildPerfChurn, duckdbDialect } from "../index.js";
import type { PerfChurnRow } from "../index.js";
import { createDuckdbClient, type DuckdbClient } from "../duckdb/client.js";
import { migrateDuckdb } from "../duckdb/migrations.js";
import { insertEvents } from "../duckdb/events.js";
import { runDuckdbQuery } from "../duckdb/queries.js";

/**
 * Perf-correlated churn (#144) — DuckDB tests for the window join semantics: a
 * dip only counts when it precedes the session's end within the window, the FPS
 * and compile-stall causes are attributed independently, and the thresholds /
 * scene / session filters bound the population.
 */

const PID = "perf-churn-project";
const T0 = Date.UTC(2024, 5, 16, 10, 0, 0);
const RANGE = { since: T0 - 3_600_000, until: T0 + 3_600_000 };

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

async function run(
  db: DuckdbClient,
  opts: Parameters<typeof buildPerfChurn>[1] = {},
): Promise<PerfChurnRow> {
  const rows = await runDuckdbQuery<Record<string, unknown>>(
    db,
    buildPerfChurn(PID, { ...RANGE, ...opts }, duckdbDialect),
  );
  const r = rows[0] ?? {};
  return {
    sessions: Number(r.sessions ?? 0),
    churn_sessions: Number(r.churn_sessions ?? 0),
    fps_churn_sessions: Number(r.fps_churn_sessions ?? 0),
    stall_churn_sessions: Number(r.stall_churn_sessions ?? 0),
  };
}

describe("buildPerfChurn (perf-correlated churn)", () => {
  let db: DuckdbClient;

  beforeEach(async () => {
    db = await createDuckdbClient(":memory:");
    await migrateDuckdb(db);
  });

  afterEach(async () => {
    await db.close();
  });

  it("attributes churn to an FPS dip within the window, ignores dips outside it", async () => {
    await insertEvents(db, [
      // sChurn: 12 FPS dip 10s before end → perf-correlated (fps cause).
      ev("sChurn", "frame_perf", T0 - 10_000, { fps: 12 }),
      ev("sChurn", "session_end", T0),
      // sFar: 12 FPS dip 90s before end → outside the 30s window → not churn.
      ev("sFar", "frame_perf", T0 - 90_000, { fps: 12 }),
      ev("sFar", "session_end", T0),
      // sSmooth: ended but only ever ran at 60 FPS → not churn.
      ev("sSmooth", "frame_perf", T0 - 5_000, { fps: 60 }),
      ev("sSmooth", "session_end", T0),
    ]);

    expect(await run(db)).toEqual({
      sessions: 3,
      churn_sessions: 1,
      fps_churn_sessions: 1,
      stall_churn_sessions: 0,
    });
  });

  it("attributes churn to a compile_stall and counts a both-cause session once", async () => {
    await insertEvents(db, [
      // sStall: a 250ms shader compile stall just before end.
      ev("sStall", "compile_stall", T0 - 2_000, { durationMs: 250, phase: "shader" }),
      ev("sStall", "session_end", T0),
      // sBoth: both an FPS dip and a stall inside the window → one churn, both causes.
      ev("sBoth", "frame_perf", T0 - 3_000, { fps: 10 }),
      ev("sBoth", "compile_stall", T0 - 1_000, { durationMs: 400 }),
      ev("sBoth", "session_end", T0),
    ]);

    expect(await run(db)).toEqual({
      sessions: 2,
      churn_sessions: 2,
      fps_churn_sessions: 1,
      stall_churn_sessions: 2,
    });
  });

  it("honors the fps and stall thresholds (fps is strict <, stall is >=)", async () => {
    await insertEvents(db, [
      // fps exactly at threshold (30) is NOT a dip (strict <); stall exactly at
      // stallMs (100) IS a stall (>=). Neither should churn on fps; only the stall.
      ev("sEdge", "frame_perf", T0 - 5_000, { fps: 30 }),
      ev("sEdge", "compile_stall", T0 - 5_000, { durationMs: 100 }),
      ev("sEdge", "session_end", T0),
    ]);

    expect(await run(db, { fpsThreshold: 30, stallMs: 100 })).toEqual({
      sessions: 1,
      churn_sessions: 1,
      fps_churn_sessions: 0,
      stall_churn_sessions: 1,
    });
  });

  it("excludes dips that occur after the session ended", async () => {
    await insertEvents(db, [
      // A late dip (5s after end) must not be attributed as churn.
      ev("sLate", "session_end", T0),
      ev("sLate", "frame_perf", T0 + 5_000, { fps: 8 }),
    ]);

    expect(await run(db)).toEqual({
      sessions: 1,
      churn_sessions: 0,
      fps_churn_sessions: 0,
      stall_churn_sessions: 0,
    });
  });

  it("scopes the population by scene", async () => {
    await insertEvents(db, [
      ev("sLobby", "frame_perf", T0 - 5_000, { fps: 10, sceneId: "lobby" }),
      ev("sLobby", "session_end", T0, { sceneId: "lobby" }),
      ev("sArena", "frame_perf", T0 - 5_000, { fps: 10, sceneId: "arena" }),
      ev("sArena", "session_end", T0, { sceneId: "arena" }),
    ]);

    expect(await run(db, { scene: "arena" })).toEqual({
      sessions: 1,
      churn_sessions: 1,
      fps_churn_sessions: 1,
      stall_churn_sessions: 0,
    });
  });

  it("returns zeros (no NULLs) when no session ended after a dip", async () => {
    await insertEvents(db, [ev("sOnlyDip", "frame_perf", T0 - 5_000, { fps: 5 })]);

    expect(await run(db)).toEqual({
      sessions: 0,
      churn_sessions: 0,
      fps_churn_sessions: 0,
      stall_churn_sessions: 0,
    });
  });
});
