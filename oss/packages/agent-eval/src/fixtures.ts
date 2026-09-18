/**
 * The dataset every eval question is asked about (ADR 0051 §8).
 *
 * The base is the **shared cross-engine parity fixture set** from `@uptimizr/db`
 * (`src/parity/fixtures.ts`) — the same deterministic events the DuckDB-vs-golden
 * suite asserts against, so the numbers an agent is scored on are numbers the
 * store layer already proves it computes correctly.
 *
 * The parity set is deliberately small: it exercises every *aggregation*, but it
 * only carries the capture channels the golden needs. Nine of the registry's
 * categories are in scope for the question bank, and without XR interactions, AR
 * placements, mesh interactions, hover, scene changes, custom events, asset
 * loads, resource samples or capability transitions, roughly a third of the
 * served metrics would return an empty result for every question — the bank would
 * only ever be able to ask "is there any data?".
 *
 * So the harness seeds the parity events **plus** {@link EVAL_SUPPLEMENT_EVENTS}:
 * two extra sessions in a third scene that light up exactly those channels.
 * The supplement is additive — it never edits the parity events — and it lives
 * here rather than in `@uptimizr/db` precisely so it cannot perturb the golden
 * parity suite. Nothing in the question bank is hand-computed from it: every
 * expected number in `cases/*.yaml` is derived by running the real aggregation
 * against this exact event set (see `scripts/derive-expectations.ts`).
 */

import type { AnyEvent, SceneProxy } from "@uptimizr/schema";
import { PARITY_EVENTS, PARITY_PROJECT_ID, PARITY_RANGE, PARITY_T0 } from "@uptimizr/db";

/** Project id every eval event belongs to (the parity project). */
export const EVAL_PROJECT_ID = PARITY_PROJECT_ID;

/** Base timestamp shared with the parity fixtures. */
export const EVAL_T0 = PARITY_T0;

/**
 * The range that covers every seeded event, parity and supplement alike. It is
 * the parity range verbatim (T0 − 60 s … T0 + 60 s) and the supplement is placed
 * inside it, so one `since`/`until` pair answers every question in the bank.
 */
export const EVAL_RANGE = PARITY_RANGE;

/** The scenes present in the seeded data. */
export const EVAL_SCENES = {
  /** Arc-rotate viewer scene (parity session `s1`, plus the desktop session `s4`). */
  lobby: "lobby",
  /** First-person scene (parity session `s2`). */
  arena: "arena",
  /** Immersive XR/AR scene added by the supplement (sessions `s3` and `s4`). */
  gallery: "gallery",
} as const;

function ev(
  type: string,
  ts: number,
  sessionId: string,
  sceneId: string,
  extra: Record<string, unknown> = {},
): AnyEvent {
  return {
    type,
    projectId: EVAL_PROJECT_ID,
    sessionId,
    ts,
    sdkVersion: "0.1.0",
    sceneId,
    ...extra,
  } as AnyEvent;
}

/** An immersive headset session in `gallery` (XR input, AR placement, jank). */
const XR_SESSION: AnyEvent[] = [
  ev("session_start", EVAL_T0 + 20_000, "s3", "gallery", {
    scene: { cameraType: "free", cameraName: "xr-cam", meshCount: 8 },
    user: { id: "anon-3" },
    device: {
      engine: "webgpu",
      renderer: "Quest 3",
      isMobile: true,
      browser: "Oculus Browser",
      os: "Android",
    },
    graphics: { api: "webgpu", backend: "vulkan", apiVersion: "1.1", shadingLanguage: "wgsl" },
  }),
  // Spatial tracking degraded twice — the tracking-quality timeline (ADR 0048).
  ev("capability_change", EVAL_T0 + 21_000, "s3", "gallery", {
    kind: "tracking",
    from: "tracked",
    to: "degraded",
    durationMs: 1_200,
    source: "hand",
  }),
  ev("capability_change", EVAL_T0 + 22_000, "s3", "gallery", {
    kind: "tracking",
    from: "tracked",
    to: "degraded",
    durationMs: 800,
    source: "xr-controller",
  }),
  // Continuous locomotion (fly + navigate) and one teleport.
  ev("camera_gesture", EVAL_T0 + 23_000, "s3", "gallery", {
    kind: "fly",
    durationMs: 2_000,
    source: "xr-controller",
  }),
  ev("camera_gesture", EVAL_T0 + 24_000, "s3", "gallery", {
    kind: "navigate",
    durationMs: 1_000,
    source: "xr-controller",
  }),
  ev("mesh_interaction", EVAL_T0 + 25_000, "s3", "gallery", {
    mesh: "portal",
    kind: "teleport",
    point: [6, 0, 2],
    source: "xr-controller",
  }),
  // Hand and gaze interactions on the same mesh — the XR input-source split.
  ev("mesh_interaction", EVAL_T0 + 26_000, "s3", "gallery", {
    mesh: "statue",
    kind: "select",
    point: [2, 1, 2],
    uv: [0.3, 0.6],
    source: "hand",
  }),
  ev("mesh_interaction", EVAL_T0 + 27_000, "s3", "gallery", {
    mesh: "statue",
    kind: "hover",
    point: [2, 1, 2],
    source: "gaze",
  }),
  ev("hover_dwell", EVAL_T0 + 28_000, "s3", "gallery", {
    mesh: "statue",
    dwellMs: 2_500,
    source: "gaze",
  }),
  ev("camera_sample", EVAL_T0 + 29_000, "s3", "gallery", {
    position: [2, 1.6, 6],
    direction: [0, 0, -1],
    hitPoint: [2, 1, 2],
    source: "gaze",
  }),
  ev("camera_sample", EVAL_T0 + 30_000, "s3", "gallery", {
    position: [4, 1.6, 4],
    direction: [-1, 0, -1],
    hitPoint: [2, 1, 2],
    source: "gaze",
  }),
  ev("xr_boundary_proximity", EVAL_T0 + 31_000, "s3", "gallery", {
    position: [7, 0, 7],
    durationMs: 900,
  }),
  // AR placement: two attempts before the object stuck, on a floor plane.
  ev("ar_placement", EVAL_T0 + 32_000, "s3", "gallery", {
    mesh: "sofa",
    position: [1, 0, 1],
    surface: "floor",
    attempts: 2,
    timeToPlaceMs: 4_200,
    scale: 1,
    final: true,
  }),
  ev("ar_placement", EVAL_T0 + 33_000, "s3", "gallery", {
    mesh: "lamp",
    position: [3, 0, 1],
    surface: "table",
    attempts: 1,
    timeToPlaceMs: 1_500,
    scale: 0.5,
    final: true,
  }),
  // A shader-compile stall and a janky frame — the stability/perf signals.
  ev("compile_stall", EVAL_T0 + 34_000, "s3", "gallery", { phase: "shader", durationMs: 250 }),
  ev("frame_perf", EVAL_T0 + 35_000, "s3", "gallery", {
    fps: 24,
    frameTimeMs: 41,
    frameTimeP95Ms: 55,
    longFrames: 20,
    dpr: 1,
    renderScale: 0.7,
    position: [2, 1.6, 6],
  }),
  ev("resource_sample", EVAL_T0 + 36_000, "s3", "gallery", {
    jsHeapBytes: 120_000_000,
    triangles: 900_000,
    vertices: 600_000,
    textureBytes: 40_000_000,
    geometryBytes: 12_000_000,
  }),
  ev("session_end", EVAL_T0 + 37_000, "s3", "gallery", { durationMs: 17_000, reason: "manual" }),
];

/** A mobile desktop-web session that walks `lobby` → `gallery` and converts. */
const CONVERSION_SESSION: AnyEvent[] = [
  ev("session_start", EVAL_T0 + 40_000, "s4", "lobby", {
    scene: { cameraType: "arc-rotate", cameraName: "cam", meshCount: 3 },
    user: { id: "anon-4" },
    device: {
      engine: "webgl2",
      renderer: "Apple GPU",
      isMobile: true,
      browser: "Safari",
      os: "iOS",
    },
    graphics: { api: "webgl2", backend: "metal", apiVersion: "3.0", shadingLanguage: "glsl-es" },
  }),
  // A slow first load — the load-time → bounce funnel band.
  // The scene the session opens in. Scene/level retention is built from
  // consecutive `scene_change` markers, so the opening marker is what gives the
  // later `gallery` marker a "from".
  ev("scene_change", EVAL_T0 + 40_500, "s4", "lobby", {}),
  ev("asset_load", EVAL_T0 + 41_000, "s4", "lobby", {
    name: "lobby.glb",
    bytes: 8_400_000,
    loadMs: 3_600,
    ttffMs: 400,
    ttiMs: 3_800,
  }),
  ev("custom", EVAL_T0 + 42_000, "s4", "lobby", {
    name: "variant_view",
    props: { variant: "hero-b" },
  }),
  ev("camera_sample", EVAL_T0 + 43_000, "s4", "lobby", {
    position: [0, 1.6, 0],
    direction: [0, 0, -1],
    hitPoint: [0.5, 0.5, 0.5],
  }),
  ev("camera_sample", EVAL_T0 + 44_000, "s4", "lobby", {
    position: [4, 1.6, 0],
    direction: [0, 0, -1],
    hitPoint: [4.5, 0.5, 0.5],
  }),
  // Back to the first cell — a revisit, which is what the backtrack ratio counts.
  ev("camera_sample", EVAL_T0 + 45_000, "s4", "lobby", {
    position: [0, 1.6, 0],
    direction: [0, 0, 1],
    hitPoint: [0.5, 0.5, 0.5],
  }),
  ev("input_action", EVAL_T0 + 46_000, "s4", "lobby", {
    action: "move-forward",
    code: "KeyW",
    pressed: true,
    source: "keyboard",
  }),
  ev("input_action", EVAL_T0 + 47_000, "s4", "lobby", {
    action: "move-forward",
    code: "KeyW",
    pressed: true,
    source: "keyboard",
  }),
  // Three clicks on the same unresponsive mesh inside one second — a rage cluster.
  ev("pointer_click", EVAL_T0 + 48_000, "s4", "lobby", {
    screen: [0.4, 0.4],
    hitPoint: [1, 1, 1],
    hitMesh: "door",
    uv: [0.4, 0.4],
    button: 0,
    source: "touch",
  }),
  ev("pointer_click", EVAL_T0 + 48_300, "s4", "lobby", {
    screen: [0.4, 0.4],
    hitPoint: [1, 1, 1],
    hitMesh: "door",
    uv: [0.4, 0.4],
    button: 0,
    source: "touch",
  }),
  ev("pointer_click", EVAL_T0 + 48_600, "s4", "lobby", {
    screen: [0.4, 0.4],
    hitPoint: [1, 1, 1],
    hitMesh: "door",
    uv: [0.4, 0.4],
    button: 0,
    source: "touch",
  }),
  // A click that hit nothing at all — a dead click.
  ev("pointer_click", EVAL_T0 + 49_000, "s4", "lobby", {
    screen: [0.05, 0.9],
    button: 0,
    source: "touch",
  }),
  // The scene transition the retention/funnel metrics read.
  ev("scene_change", EVAL_T0 + 50_000, "s4", "gallery", {}),
  ev("camera_sample", EVAL_T0 + 51_000, "s4", "gallery", {
    position: [1, 1.6, 1],
    direction: [0, 0, -1],
    hitPoint: [2, 1, 2],
  }),
  ev("mesh_visibility", EVAL_T0 + 52_000, "s4", "gallery", {
    mesh: "statue",
    visibleMs: 6_000,
    centeredMs: 3_000,
    maxScreenFraction: 0.62,
  }),
  // The conversion the variant leaderboard scores `hero-b` on.
  ev("mesh_interaction", EVAL_T0 + 53_000, "s4", "gallery", {
    mesh: "buy",
    kind: "click",
    point: [2, 1, 2],
    source: "touch",
  }),
  ev("custom", EVAL_T0 + 54_000, "s4", "gallery", {
    name: "purchase",
    props: { variant: "hero-b" },
  }),
  ev("graphics_diagnostic", EVAL_T0 + 55_000, "s4", "gallery", {
    severity: "warning",
    category: "validation",
    backend: "webgl2",
    position: [2, 0, 3],
  }),
  ev("frame_perf", EVAL_T0 + 56_000, "s4", "gallery", {
    fps: 52,
    frameTimeMs: 19,
    frameTimeP95Ms: 24,
    longFrames: 0,
    dpr: 3,
    renderScale: 1,
    position: [1, 1.6, 1],
  }),
  ev("resource_sample", EVAL_T0 + 57_000, "s4", "gallery", {
    jsHeapBytes: 70_000_000,
    triangles: 300_000,
    vertices: 200_000,
    textureBytes: 15_000_000,
    geometryBytes: 4_000_000,
  }),
  ev("session_end", EVAL_T0 + 58_000, "s4", "gallery", { durationMs: 18_000, reason: "unload" }),
];

/**
 * Events added on top of the parity fixtures so the capture channels the parity
 * golden does not need (XR input, AR placement, mesh interactions, hover, scene
 * changes, custom events, asset loads, resource samples, capability transitions,
 * keyboard input) carry real data for the question bank.
 */
export const EVAL_SUPPLEMENT_EVENTS: readonly AnyEvent[] = [...XR_SESSION, ...CONVERSION_SESSION];

/** Every event the harness seeds: the parity fixtures, then the supplement. */
export const EVAL_EVENTS: readonly AnyEvent[] = [...PARITY_EVENTS, ...EVAL_SUPPLEMENT_EVENTS];

/**
 * A registered scene proxy for `lobby` (ADR 0040). Without one the collector's
 * `scene_representation` resource has nothing to describe and the spatial
 * aggregations cannot derive a cell size from registered bounds — both of which
 * are part of the agent surface, so the harness seeds exactly one.
 */
export const EVAL_SCENE_PROXY: SceneProxy = {
  version: 1,
  sceneId: EVAL_SCENES.lobby,
  kind: "aabb",
  bounds: [-1, 0, -1, 11, 4, 6],
  upAxis: "y",
  handedness: "right",
  unitScale: 1,
  meshCount: 3,
  meshes: [
    { name: "box", aabb: [0, 0, 0, 1, 1, 1], triangles: 12 },
    { name: "sphere", aabb: [4, 4, 4, 6, 6, 6], triangles: 960 },
    { name: "door", aabb: [0.5, 0, 0.5, 1.5, 2, 0.7], triangles: 12 },
  ],
  contentHash: "agent-eval-lobby-v1",
  capturedAt: EVAL_T0,
  sdkVersion: "0.1.0",
};

/** The human label the seeded scene proxy is registered under. */
export const EVAL_SCENE_PROXY_LABEL = "Lobby";

/**
 * Named regions of the `lobby` scene (ADR 0051 §2, design sketch §B.2).
 *
 * `front-of-house` is deliberately drawn to contain the lobby's world-space
 * click hits, so a region-scoped question has a non-empty answer; `back-corner`
 * is empty on purpose, so a question about it must be answered "nothing happened
 * there" rather than by widening the box. Neither id is guessable — they exist
 * only in the project context, which is exactly the point.
 */
export const EVAL_SCENE_REGIONS = [
  {
    id: "front-of-house",
    label: "Front of house",
    bounds: [-1, -1, -1, 6, 6, 6] as [number, number, number, number, number, number],
    description: "The open area visitors arrive into.",
  },
  {
    id: "back-corner",
    label: "Back corner",
    bounds: [90, 90, 90, 100, 100, 100] as [number, number, number, number, number, number],
  },
];
