/**
 * Shared cross-engine parity fixtures (Phase C, ADR 0020).
 *
 * A single deterministic event set that exercises every analytics aggregation —
 * 2D/3D heatmaps, the camera-direction (gaze) heatmap, the ASOF click↔gaze ray
 * and flow joins, quantile-based perf, the daily rollups, and the scene/session
 * dimensions. The same fixtures and golden outputs are reused by:
 *
 * - the OSS DuckDB-vs-golden suite (`src/__tests__/duckdbParity.test.ts`), and
 * - the DuckDB-vs-ClickHouse cross-engine suite (per ADR 0020, the
 *   cross-engine half lives in the separately-licensed scale tier).
 *
 * Values are chosen so each aggregation produces more than one group and the
 * arithmetic is hand-verifiable (see the golden in `cases.ts`).
 */

import type { AnyEvent } from "@uptimizr/schema";

/** Project all parity fixtures belong to. */
export const PARITY_PROJECT_ID = "parity-project";

/** Base timestamp: a whole-minute boundary so the 60 s time bucket is exact. */
export const PARITY_T0 = Date.UTC(2024, 5, 16, 10, 0, 0);

/** Tight window covering every fixture event (spans T0 .. T0 + 14 s). */
export const PARITY_RANGE = {
  since: PARITY_T0 - 60_000,
  until: PARITY_T0 + 60_000,
};

/**
 * Day-granular window for the daily rollups. The upper bound is exclusive at
 * date granularity in both engines, so span a full day on either side.
 */
export const PARITY_DAY_RANGE = {
  since: PARITY_T0 - 86_400_000,
  until: PARITY_T0 + 86_400_000,
};

/** The calendar day every fixture event lands on (UTC). */
export const PARITY_DAY = "2024-06-16";

function ev(type: string, ts: number, extra: Record<string, unknown> = {}): AnyEvent {
  return {
    type,
    projectId: PARITY_PROJECT_ID,
    sessionId: "s1",
    ts,
    sdkVersion: "0.1.0",
    sceneId: "lobby",
    ...extra,
  } as AnyEvent;
}

/**
 * Two sessions across two scenes.
 *
 * Session `s1` (scene `lobby`): two camera samples and two clicks that ASOF-join
 * to distinct preceding samples, plus two perf samples.
 * Session `s2` (scene `arena`): one camera sample, a move + click on the same
 * mesh, and one perf sample.
 */
export const PARITY_EVENTS: AnyEvent[] = [
  // --- session s1 / scene lobby ---
  ev("session_start", PARITY_T0, {
    scene: { cameraType: "arc-rotate", cameraName: "cam", meshCount: 3 },
    user: { id: "anon-1" },
    device: { engine: "webgpu" },
  }),
  ev("camera_sample", PARITY_T0 + 1_000, {
    position: [0, 0, 0],
    direction: [2, 1, 2],
    hitPoint: [0.2, 0.2, 0.2],
  }),
  ev("pointer_click", PARITY_T0 + 2_000, {
    screen: [0.15, 0.15],
    hitPoint: [0.2, 0.2, 0.2],
    hitMesh: "box",
    button: 0,
    source: "mouse",
  }),
  ev("camera_sample", PARITY_T0 + 3_000, {
    position: [10, 0, 0],
    direction: [1, 3, -2],
    hitPoint: [5, 5, 5],
  }),
  ev("pointer_click", PARITY_T0 + 4_000, {
    screen: [0.95, 0.95],
    hitPoint: [5, 5, 5],
    hitMesh: "sphere",
    button: 0,
    source: "mouse",
  }),
  ev("frame_perf", PARITY_T0 + 5_000, {
    fps: 60,
    frameTimeMs: 16,
    frameTimeP95Ms: 20,
    longFrames: 1,
    dpr: 2,
    renderScale: 1,
  }),
  ev("frame_perf", PARITY_T0 + 6_000, {
    fps: 30,
    frameTimeMs: 33,
    frameTimeP95Ms: 40,
    longFrames: 5,
    dpr: 2,
    renderScale: 0.8,
  }),
  // Two bucketed mesh_visibility summaries (#37): dwell on "box" and "sphere".
  ev("mesh_visibility", PARITY_T0 + 7_000, {
    mesh: "box",
    visibleMs: 4000,
    centeredMs: 1500,
    maxScreenFraction: 0.4,
  }),
  ev("mesh_visibility", PARITY_T0 + 8_000, {
    mesh: "sphere",
    visibleMs: 2000,
    centeredMs: 800,
    maxScreenFraction: 0.7,
  }),

  // --- session s2 / scene arena ---
  ev("session_start", PARITY_T0 + 10_000, {
    sessionId: "s2",
    sceneId: "arena",
    scene: { cameraType: "free", cameraName: "cam2", meshCount: 5 },
    user: { id: "anon-2" },
    device: { engine: "webgl2" },
  }),
  ev("camera_sample", PARITY_T0 + 11_000, {
    sessionId: "s2",
    sceneId: "arena",
    position: [0, 0, 0],
    direction: [-2, -1, 1],
    hitPoint: [1, 1, 1],
  }),
  ev("pointer_move", PARITY_T0 + 12_000, {
    sessionId: "s2",
    sceneId: "arena",
    screen: [0.55, 0.55],
    hitPoint: [1, 1, 1],
    hitMesh: "floor",
    source: "mouse",
  }),
  ev("pointer_click", PARITY_T0 + 13_000, {
    sessionId: "s2",
    sceneId: "arena",
    screen: [0.55, 0.55],
    hitPoint: [1, 1, 1],
    hitMesh: "floor",
    button: 2,
    source: "mouse",
  }),
  ev("frame_perf", PARITY_T0 + 14_000, {
    sessionId: "s2",
    sceneId: "arena",
    fps: 45,
    frameTimeMs: 22,
    frameTimeP95Ms: 28,
    longFrames: 2,
    dpr: 1,
    renderScale: 1,
  }),
];
