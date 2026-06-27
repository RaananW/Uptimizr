/**
 * Cross-engine parity cases (Phase C, ADR 0020).
 *
 * Each case pairs one dialect-agnostic aggregation builder with the
 * engine-independent golden output it must produce for {@link PARITY_EVENTS}.
 * The golden is authored as truth (hand-verified from the fixtures) so that any
 * engine — DuckDB in OSS, ClickHouse in the scale tier — can be checked against
 * the same expectations. Two engines that both match the golden are, by
 * transitivity, in parity with each other.
 *
 * Comparison uses the tolerance rules in {@link diffParity}: order-insensitive,
 * float-tolerant on continuous columns, integer-exact on bin indices, and
 * temporal projection columns excluded.
 */

import {
  buildCameraDirectionHeatmap,
  buildCameraDistance,
  buildCameraPositionHeatmap,
  buildClickGazeRay,
  buildDistinctScenes,
  buildEventTypeCounts,
  buildEventsDaily,
  buildFlowHeatmap,
  buildListSessions,
  buildMeshDwell,
  buildMeshInteractionKinds,
  buildTopInputActions,
  buildDeadClicks,
  buildRageClicks,
  buildHoverDwell,
  buildCompileStalls,
  buildResourceSummary,
  buildCapabilityChanges,
  buildCameraGestures,
  buildNavigationStats,
  buildXrRotationRate,
  buildXrSourceUsage,
  buildXrAbandonment,
  buildInteractionsBySource,
  buildFunnel,
  buildPerfDaily,
  buildPerfSummary,
  buildRenderScaleTruth,
  buildPerfDistribution,
  buildFpsHistogram,
  buildFrameTimePercentiles,
  buildJankRate,
  buildPerfByDevice,
  buildPerfByScene,
  buildResourcePercentiles,
  buildStabilityCounts,
  buildPointerHeatmap,
  buildSceneCoverage,
  buildSessionTrajectory,
  buildAggregateTrajectories,
  buildTimeseries,
  buildTopMeshes,
  buildTopMeshesBySource,
  buildTopMeshesTrend,
  buildWorldHeatmap,
  buildWorldHeatmapStats,
  buildGazeHeatmap,
  buildGazeHeatmapStats,
} from "../query/aggregations.js";
import type { Dialect } from "../query/dialect.js";
import type { QuerySpec } from "../query/types.js";
import type { ParityRow } from "./compare.js";
import {
  PARITY_DAY,
  PARITY_DAY_RANGE,
  PARITY_PROJECT_ID,
  PARITY_RANGE,
  PARITY_T0,
} from "./fixtures.js";

export interface ParityCase {
  /** Stable identifier (also the test name). */
  readonly name: string;
  /** Render the aggregation for a given engine dialect. */
  build(dialect: Dialect): QuerySpec;
  /** Columns that together order a row for multiset comparison. */
  readonly sortKeys: readonly string[];
  /** Engine-specific temporal columns excluded from comparison. */
  readonly ignoreColumns?: readonly string[];
  /** Engine-independent expected output. */
  readonly golden: readonly ParityRow[];
}

const PID = PARITY_PROJECT_ID;

export const PARITY_CASES: readonly ParityCase[] = [
  {
    name: "listSessions",
    build: (d) => buildListSessions(PID, PARITY_RANGE, d),
    sortKeys: ["session_id"],
    ignoreColumns: ["started_at", "ended_at"],
    golden: [
      { session_id: "s1", visitor_id: "", events: 9 },
      { session_id: "s2", visitor_id: "", events: 5 },
    ],
  },
  {
    name: "pointerHeatmap",
    build: (d) => buildPointerHeatmap(PID, { ...PARITY_RANGE, bins: 10 }, d),
    sortKeys: ["gx", "gy"],
    golden: [
      { gx: 1, gy: 1, count: 1 },
      { gx: 5, gy: 5, count: 2 },
      { gx: 9, gy: 9, count: 1 },
    ],
  },
  {
    name: "worldHeatmap",
    build: (d) => buildWorldHeatmap(PID, { ...PARITY_RANGE, cellSize: 1 }, d),
    sortKeys: ["vx", "vy", "vz"],
    golden: [
      { vx: 0, vy: 0, vz: 0, count: 1 },
      { vx: 1, vy: 1, vz: 1, count: 2 },
      { vx: 5, vy: 5, vz: 5, count: 1 },
    ],
  },
  {
    // World heatmap totals (ADR 0040 §3): three occupied voxels above hold 4 hits
    // (1 + 2 + 1). Computed with no LIMIT, so cells/hits are the true scene totals.
    name: "worldHeatmapStats",
    build: (d) => buildWorldHeatmapStats(PID, { ...PARITY_RANGE, cellSize: 1 }, d),
    sortKeys: ["cells"],
    golden: [{ cells: 3, hits: 4 }],
  },
  {
    // Region drill-down (ADR 0040 §4): the AABB [0.5,0.5,0.5 .. 6,6,6] keeps the
    // [1,1,1] (x2) and [5,5,5] world hits but excludes [0.2,0.2,0.2].
    name: "worldHeatmapRegion",
    build: (d) =>
      buildWorldHeatmap(PID, { ...PARITY_RANGE, cellSize: 1, region: [0.5, 0.5, 0.5, 6, 6, 6] }, d),
    sortKeys: ["vx", "vy", "vz"],
    golden: [
      { vx: 1, vy: 1, vz: 1, count: 2 },
      { vx: 5, vy: 5, vz: 5, count: 1 },
    ],
  },
  {
    // Gaze heatmap (ADR 0030): voxel-binned `camera_sample.hitPoint`. Three camera
    // samples carry a gaze hit ([0.2,0.2,0.2], [1,1,1], [5,5,5]); at cellSize 1
    // they fall in three distinct voxels. Hand-verified from the fixtures.
    name: "gazeHeatmap",
    build: (d) => buildGazeHeatmap(PID, { ...PARITY_RANGE, cellSize: 1 }, d),
    sortKeys: ["vx", "vy", "vz"],
    golden: [
      { vx: 0, vy: 0, vz: 0, count: 1 },
      { vx: 1, vy: 1, vz: 1, count: 1 },
      { vx: 5, vy: 5, vz: 5, count: 1 },
    ],
  },
  {
    // Gaze totals (ADR 0040 §3): three occupied gaze voxels, one hit each → 3 hits.
    name: "gazeHeatmapStats",
    build: (d) => buildGazeHeatmapStats(PID, { ...PARITY_RANGE, cellSize: 1 }, d),
    sortKeys: ["cells"],
    golden: [{ cells: 3, hits: 3 }],
  },
  {
    name: "cameraDirectionHeatmap",
    build: (d) => buildCameraDirectionHeatmap(PID, { ...PARITY_RANGE, bins: 8 }, d),
    sortKeys: ["azimuth_bin", "elevation_bin"],
    // Hand-verified from the three camera directions ([2,1,2], [1,3,-2],
    // [-2,-1,1]) via azimuth=atan2(z,x), elevation=asin(y/|v|) into 8 bins.
    golden: [
      { azimuth_bin: 2, elevation_bin: 6, count: 1 },
      { azimuth_bin: 5, elevation_bin: 4, count: 1 },
      { azimuth_bin: 7, elevation_bin: 2, count: 1 },
    ],
  },
  {
    name: "cameraPositionHeatmap",
    build: (d) => buildCameraPositionHeatmap(PID, { ...PARITY_RANGE, cellSize: 1 }, d),
    sortKeys: ["gx", "gz"],
    // The three camera positions [0,0,0], [10,0,0], [0,0,0] binned on X/Z at
    // cellSize 1: two samples share cell (0,0), one lands in (10,0).
    golden: [
      { gx: 0, gz: 0, avg_y: 0, count: 2 },
      { gx: 10, gz: 0, avg_y: 0, count: 1 },
    ],
  },
  {
    name: "sessionTrajectory",
    build: (d) => buildSessionTrajectory(PID, { ...PARITY_RANGE, session: "s1" }, d),
    sortKeys: ["x", "z"],
    ignoreColumns: ["ts"],
    // Session s1's two camera samples in order: [0,0,0] then [10,0,0].
    golden: [
      { x: 0, y: 0, z: 0 },
      { x: 10, y: 0, z: 0 },
    ],
  },
  {
    name: "aggregateTrajectories",
    build: (d) => buildAggregateTrajectories(PID, { ...PARITY_RANGE, cellSize: 1 }, d),
    sortKeys: ["session_id", "gx", "gz"],
    ignoreColumns: ["ts"],
    // All three camera samples binned on X/Z at cellSize 1, keyed by session:
    // s1 walks [0,0,0]->(0,0) then [10,0,0]->(10,0); s2 stands at [0,0,0]->(0,0).
    golden: [
      { session_id: "s1", gx: 0, gz: 0 },
      { session_id: "s1", gx: 10, gz: 0 },
      { session_id: "s2", gx: 0, gz: 0 },
    ],
  },
  {
    name: "clickGazeRay",
    build: (d) => buildClickGazeRay(PID, { ...PARITY_RANGE, cellSize: 1 }, d),
    sortKeys: ["mesh"],
    golden: [
      {
        cam_vx: 0,
        cam_vy: 0,
        cam_vz: 0,
        origin_x: 0,
        origin_y: 0,
        origin_z: 0,
        hit_vx: 0,
        hit_vy: 0,
        hit_vz: 0,
        hit_x: 0.2,
        hit_y: 0.2,
        hit_z: 0.2,
        mesh: "box",
        count: 1,
      },
      {
        cam_vx: 0,
        cam_vy: 0,
        cam_vz: 0,
        origin_x: 0,
        origin_y: 0,
        origin_z: 0,
        hit_vx: 1,
        hit_vy: 1,
        hit_vz: 1,
        hit_x: 1,
        hit_y: 1,
        hit_z: 1,
        mesh: "floor",
        count: 1,
      },
      {
        cam_vx: 10,
        cam_vy: 0,
        cam_vz: 0,
        origin_x: 10,
        origin_y: 0,
        origin_z: 0,
        hit_vx: 5,
        hit_vy: 5,
        hit_vz: 5,
        hit_x: 5,
        hit_y: 5,
        hit_z: 5,
        mesh: "sphere",
        count: 1,
      },
    ],
  },
  {
    name: "flowHeatmap",
    build: (d) => buildFlowHeatmap(PID, { ...PARITY_RANGE, bins: 24 }, d),
    sortKeys: ["mesh"],
    // One link per (clicked mesh, ASOF-preceding gaze direction), binned into 24
    // azimuth/elevation buckets. Hand-verified from the fixtures.
    golden: [
      { azimuth_bin: 15, elevation_bin: 14, mesh: "box", count: 1 },
      { azimuth_bin: 22, elevation_bin: 8, mesh: "floor", count: 1 },
      { azimuth_bin: 7, elevation_bin: 19, mesh: "sphere", count: 1 },
    ],
  },
  {
    // Position-aware flow (§7.8): same three links, now also carrying the
    // ASOF-preceding camera *position* as a standpoint voxel. At cellSize 1 the
    // standpoints are box→(0,0,0), sphere→(10,0,0), floor→(0,0,0). The direction
    // bins are unchanged from `flowHeatmap`. Hand-verified from the fixtures.
    name: "flowHeatmapByStandpoint",
    build: (d) =>
      buildFlowHeatmap(PID, { ...PARITY_RANGE, bins: 24, cellSize: 1, groupByOrigin: true }, d),
    sortKeys: ["mesh"],
    golden: [
      {
        azimuth_bin: 15,
        elevation_bin: 14,
        origin_vx: 0,
        origin_vy: 0,
        origin_vz: 0,
        origin_x: 0,
        origin_y: 0,
        origin_z: 0,
        mesh: "box",
        count: 1,
      },
      {
        azimuth_bin: 22,
        elevation_bin: 8,
        origin_vx: 0,
        origin_vy: 0,
        origin_vz: 0,
        origin_x: 0,
        origin_y: 0,
        origin_z: 0,
        mesh: "floor",
        count: 1,
      },
      {
        azimuth_bin: 7,
        elevation_bin: 19,
        origin_vx: 10,
        origin_vy: 0,
        origin_vz: 0,
        origin_x: 10,
        origin_y: 0,
        origin_z: 0,
        mesh: "sphere",
        count: 1,
      },
    ],
  },
  {
    name: "topMeshes",
    build: (d) => buildTopMeshes(PID, PARITY_RANGE, d),
    sortKeys: ["mesh"],
    // Counts any event carrying a mesh (interactions plus mesh_visibility):
    // box has 1 click + 1 visibility, floor 2 hits, sphere 1 click + 1 visibility.
    golden: [
      { mesh: "box", count: 2 },
      { mesh: "floor", count: 2 },
      { mesh: "sphere", count: 2 },
    ],
  },
  {
    name: "meshDwell",
    build: (d) => buildMeshDwell(PID, PARITY_RANGE, d),
    sortKeys: ["mesh"],
    // Per-object dwell from the two mesh_visibility summaries, ranked by total
    // on-screen time (box 4000 > sphere 2000).
    golden: [
      { mesh: "box", visible_ms: 4000, centered_ms: 1500, max_screen_fraction: 0.4, samples: 1 },
      { mesh: "sphere", visible_ms: 2000, centered_ms: 800, max_screen_fraction: 0.7, samples: 1 },
    ],
  },
  {
    name: "topMeshesBySource",
    build: (d) => buildTopMeshesBySource(PID, PARITY_RANGE, d),
    sortKeys: ["mesh", "source"],
    // Scoped to active interactions (#74): only `pointer_click` fixtures qualify
    // (no `mesh_interaction` in the parity set; gaze `camera_sample` and dwell
    // `mesh_visibility` are excluded). Each mesh has exactly one mouse click, so
    // every mesh is a single `mouse` row with count 1.
    golden: [
      { mesh: "box", source: "mouse", count: 1 },
      { mesh: "floor", source: "mouse", count: 1 },
      { mesh: "sphere", source: "mouse", count: 1 },
    ],
  },
  {
    name: "topMeshesTrend",
    build: (d) => buildTopMeshesTrend(PID, PARITY_RANGE, d),
    sortKeys: ["mesh"],
    // Active-interaction tally (#74), same `pointer_click`-only scope as
    // topMeshesBySource. All fixtures fall in a single hourly bucket, so there is
    // one row per mesh with count 1. The bucket epoch is engine-formatted, so it
    // is ignored here; per-bucket grouping is covered by the DuckDB suite.
    ignoreColumns: ["bucket"],
    golden: [
      { mesh: "box", count: 1 },
      { mesh: "floor", count: 1 },
      { mesh: "sphere", count: 1 },
    ],
  },
  {
    name: "meshInteractionKinds",
    build: (d) => buildMeshInteractionKinds(PID, PARITY_RANGE, d),
    sortKeys: ["mesh", "kind"],
    // No `mesh_interaction` fixtures in the parity set, so the per-(mesh,kind)
    // breakdown is empty. Validates the GROUP/ORDER renders identically (empty)
    // on both engines (#72); real grouping is covered by the DuckDB unit suite.
    golden: [],
  },
  {
    name: "topInputActions",
    build: (d) => buildTopInputActions(PID, PARITY_RANGE, d),
    sortKeys: ["action", "source"],
    // No `input_action` fixtures in the parity set, so the shortcut leaderboard
    // is empty. Validates the GROUP/ORDER renders identically (empty) on both
    // engines (#75); real grouping is covered by the DuckDB unit suite.
    golden: [],
  },
  {
    name: "perfSummary",
    build: (d) => buildPerfSummary(PID, PARITY_RANGE, d),
    sortKeys: ["samples"],
    golden: [{ samples: 3, avg_fps: 45, min_fps: 30, p50_fps: 45 }],
  },
  {
    name: "renderScaleTruth",
    build: (d) => buildRenderScaleTruth(PID, PARITY_RANGE, d),
    sortKeys: ["samples"],
    // Three frame_perf samples: fps (60,30,45), renderScale (1,0.8,1). avg_fps=45,
    // p50_fps=45; render scale avg=2.8/3, p50(0.8,1,1)=1; one sample is downscaled
    // (0.8<1) and all three report a scale.
    golden: [
      {
        samples: 3,
        avg_fps: 45,
        p50_fps: 45,
        avg_render_scale: 2.8 / 3,
        p50_render_scale: 1,
        downscaled_samples: 1,
        scale_samples: 3,
      },
    ],
  },
  {
    name: "perfDistribution",
    build: (d) => buildPerfDistribution(PID, PARITY_RANGE, d),
    sortKeys: ["sessions"],
    // Per session: s1 fps [30,60] -> p05 31.5 / p50 45 / p95 58.5; s2 fps [45] ->
    // 45 across the board. Median across the two sessions of each percentile.
    golden: [{ sessions: 2, samples: 3, p05_fps: 38.25, p50_fps: 45, p95_fps: 51.75 }],
  },
  {
    name: "fpsHistogram",
    build: (d) => buildFpsHistogram(PID, PARITY_RANGE, d),
    sortKeys: ["bucket"],
    // Session medians: s1 -> 45, s2 -> 45. Both land in the [40,50) bin (width 10).
    golden: [{ bucket: 40, sessions: 2 }],
  },
  {
    name: "frameTimePercentiles",
    build: (d) => buildFrameTimePercentiles(PID, PARITY_RANGE, d),
    sortKeys: ["sessions"],
    // Per session: s1 median frame_time_ms = median(16,33) = 24.5, worst p95 =
    // max(20,40) = 40; s2 = 22 / 28. Median across sessions of each.
    golden: [{ sessions: 2, samples: 3, p50_ms: 23.25, p95_ms: 34 }],
  },
  {
    name: "jankRate",
    build: (d) => buildJankRate(PID, PARITY_RANGE, d),
    sortKeys: ["sessions"],
    // Per session long-frames-per-window: s1 = (1+5)/2 = 3, s2 = 2/1 = 2.
    // median(3,2) = 2.5; p90 of [2,3] = 2.9; total long frames = 8.
    golden: [{ sessions: 2, total_long_frames: 8, median_rate: 2.5, worst_decile_rate: 2.9 }],
  },
  {
    name: "perfByDevice",
    build: (d) => buildPerfByDevice(PID, PARITY_RANGE, d),
    sortKeys: ["engine"],
    // s1 -> webgpu (2 samples), s2 -> webgl2 (1 sample); both sessions have a
    // single median FPS of 45. isMobile/renderer/browser/os were never reported
    // -> ''.
    golden: [
      {
        engine: "webgl2",
        is_mobile: "",
        renderer: "",
        browser: "",
        os: "",
        sessions: 1,
        samples: 1,
        p50_fps: 45,
      },
      {
        engine: "webgpu",
        is_mobile: "",
        renderer: "",
        browser: "",
        os: "",
        sessions: 1,
        samples: 2,
        p50_fps: 45,
      },
    ],
  },
  {
    name: "perfByScene",
    build: (d) => buildPerfByScene(PID, PARITY_RANGE, d),
    sortKeys: ["scene_id"],
    // s1 renders lobby (2 samples), s2 renders arena (1 sample); each session's
    // median FPS is 45.
    golden: [
      { scene_id: "arena", sessions: 1, samples: 1, p50_fps: 45 },
      { scene_id: "lobby", sessions: 1, samples: 2, p50_fps: 45 },
    ],
  },
  {
    name: "resourcePercentiles",
    build: (d) => buildResourcePercentiles(PID, PARITY_RANGE, d),
    sortKeys: ["sessions"],
    // No resource_sample fixtures: no sessions contribute, so every percentile is
    // NULL and the sample total is NULL. Validates the nested per-session
    // aggregation renders identically on both engines.
    golden: [
      {
        sessions: 0,
        samples: null,
        p50_js_heap_bytes: null,
        p95_js_heap_bytes: null,
        p50_texture_bytes: null,
        p95_texture_bytes: null,
        p50_triangles: null,
        p95_triangles: null,
      },
    ],
  },
  {
    name: "stabilityCounts",
    build: (d) => buildStabilityCounts(PID, PARITY_RANGE, d),
    sortKeys: ["incidents"],
    // No context_lost / compile_stall fixtures: all counts coalesce to 0.
    golden: [{ context_losses: 0, compile_stalls: 0, incidents: 0 }],
  },
  {
    name: "deadClicks",
    build: (d) => buildDeadClicks(PID, PARITY_RANGE, d),
    sortKeys: ["total_clicks"],
    // All three pointer_click fixtures hit a mesh, so none are dead. Validates
    // the empty-mesh count renders identically on both engines (#46).
    golden: [{ total_clicks: 3, dead_clicks: 0 }],
  },
  {
    name: "rageClicks",
    build: (d) => buildRageClicks(PID, PARITY_RANGE, d),
    sortKeys: ["session_id", "mesh", "bucket"],
    // The three clicks are on distinct meshes spread across time, so no burst
    // reaches the default threshold. Validates the GROUP/HAVING renders the same
    // (empty) result on both engines (#47).
    golden: [],
  },
  {
    name: "hoverDwell",
    build: (d) => buildHoverDwell(PID, PARITY_RANGE, d),
    sortKeys: ["mesh"],
    // No hover_dwell fixtures in the parity set, so the per-mesh hesitation roll-up
    // is empty. Validates the GROUP/ORDER renders identically on both engines (#48).
    golden: [],
  },
  {
    name: "compileStalls",
    build: (d) => buildCompileStalls(PID, PARITY_RANGE, d),
    sortKeys: ["phase"],
    // No compile_stall fixtures in the parity set, so the per-phase compile-stall
    // roll-up is empty. Validates the GROUP/ORDER renders identically on both
    // engines (#42).
    golden: [],
  },
  {
    name: "resourceSummary",
    build: (d) => buildResourceSummary(PID, PARITY_RANGE, d),
    sortKeys: ["samples"],
    // No resource_sample fixtures in the parity set: count is 0 and every
    // avg/max is NULL. Validates the aggregate (incl. NULLIF) renders identically
    // on both engines (#44).
    golden: [
      {
        samples: 0,
        avg_js_heap_bytes: null,
        max_js_heap_bytes: null,
        avg_triangles: null,
        max_triangles: null,
        avg_vertices: null,
        max_vertices: null,
        avg_texture_bytes: null,
        max_texture_bytes: null,
        avg_geometry_bytes: null,
        max_geometry_bytes: null,
      },
    ],
  },
  {
    name: "capabilityChanges",
    build: (d) => buildCapabilityChanges(PID, PARITY_RANGE, d),
    sortKeys: ["kind", "from", "to"],
    // No capability_change fixtures in the parity set, so the per-transition
    // roll-up is empty. Validates the GROUP/ORDER (with reserved-word aliases)
    // renders identically on both engines (#49).
    golden: [],
  },
  {
    name: "cameraGestures",
    build: (d) => buildCameraGestures(PID, PARITY_RANGE, d),
    sortKeys: ["kind"],
    // No camera_gesture fixtures in the parity set, so the per-kind navigation
    // roll-up is empty. Validates the GROUP/ORDER renders identically on both
    // engines (ADR 0025).
    golden: [],
  },
  {
    name: "perfDaily",
    build: (d) => buildPerfDaily(PID, PARITY_DAY_RANGE, d),
    sortKeys: ["day"],
    golden: [{ day: PARITY_DAY, samples: 3, avg_fps: 45, min_fps: 30, p50_fps: 45 }],
  },
  {
    name: "eventsDaily",
    build: (d) => buildEventsDaily(PID, PARITY_DAY_RANGE, d),
    sortKeys: ["event_type"],
    golden: [
      { day: PARITY_DAY, event_type: "camera_sample", events: 3 },
      { day: PARITY_DAY, event_type: "frame_perf", events: 3 },
      { day: PARITY_DAY, event_type: "mesh_visibility", events: 2 },
      { day: PARITY_DAY, event_type: "pointer_click", events: 3 },
      { day: PARITY_DAY, event_type: "pointer_move", events: 1 },
      { day: PARITY_DAY, event_type: "session_start", events: 2 },
    ],
  },
  {
    name: "distinctScenes",
    build: (d) => buildDistinctScenes(PID, PARITY_RANGE, d),
    sortKeys: ["scene_id"],
    ignoreColumns: ["last_seen"],
    golden: [
      { scene_id: "arena", events: 5 },
      { scene_id: "lobby", events: 9 },
    ],
  },
  {
    name: "timeseries",
    build: (d) => buildTimeseries(PID, { ...PARITY_RANGE, interval: 60 }, d),
    sortKeys: ["bucket"],
    golden: [{ bucket: PARITY_T0, events: 14, avg_fps: 45 }],
  },
  {
    name: "eventTypeCounts",
    build: (d) => buildEventTypeCounts(PID, PARITY_RANGE, d),
    sortKeys: ["event_type"],
    golden: [
      { event_type: "camera_sample", count: 3 },
      { event_type: "frame_perf", count: 3 },
      { event_type: "mesh_visibility", count: 2 },
      { event_type: "pointer_click", count: 3 },
      { event_type: "pointer_move", count: 1 },
      { event_type: "session_start", count: 2 },
    ],
  },
  {
    name: "sceneCoverage",
    build: (d) => buildSceneCoverage(PID, { ...PARITY_RANGE, cellSize: 1 }, d),
    sortKeys: ["vx", "vy", "vz"],
    // Camera positions [0,0,0] (s1 + s2) and [10,0,0] (s1) voxel-binned at size 1.
    golden: [
      { vx: 0, vy: 0, vz: 0, count: 2 },
      { vx: 10, vy: 0, vz: 0, count: 1 },
    ],
  },
  {
    name: "cameraDistance",
    build: (d) =>
      buildCameraDistance(PID, { ...PARITY_RANGE, center: [0, 0, 0], bucketSize: 1 }, d),
    sortKeys: ["bucket"],
    // Distances from origin: 0 (s1 + s2) and 10 (s1), bucketed by 1.
    golden: [
      { bucket: 0, count: 2 },
      { bucket: 10, count: 1 },
    ],
  },
  {
    name: "navigationStats",
    build: (d) => buildNavigationStats(PID, PARITY_RANGE, d),
    sortKeys: ["session_id"],
    // s1 travels [0,0,0] -> [10,0,0] = 10 units (one active segment); s2 has a
    // single sample, so it yields no segment and drops out of the inner join.
    golden: [
      {
        session_id: "s1",
        segments: 1,
        total_distance: 10,
        active_segments: 1,
        active_distance: 10,
      },
    ],
  },
  {
    name: "xrRotationRate",
    build: (d) => buildXrRotationRate(PID, PARITY_RANGE, d),
    sortKeys: ["session_id"],
    // s1's two view directions ([2,1,2] -> [1,3,-2]) subtend
    // acos(1 / (3*sqrt(14))) = 1.4815909832 rad — one segment, above the 0.5 rad
    // rapid threshold. s2 has a single sample, so no segment.
    golden: [
      {
        session_id: "s1",
        samples: 1,
        avg_turn_rad: 1.4815909832473548,
        max_turn_rad: 1.4815909832473548,
        total_turn_rad: 1.4815909832473548,
        rapid_segments: 1,
      },
    ],
  },
  {
    name: "xrSourceUsage",
    build: (d) => buildXrSourceUsage(PID, PARITY_RANGE, d),
    sortKeys: ["source"],
    // The fixtures use only `mouse`, so no immersive input source is present.
    golden: [],
  },
  {
    name: "xrAbandonment",
    build: (d) => buildXrAbandonment(PID, PARITY_RANGE, d),
    sortKeys: ["session_id"],
    ignoreColumns: ["started_at", "ended_at"],
    // No session used an XR input source in the fixtures, so none qualifies.
    golden: [],
  },
  {
    name: "interactionsBySource",
    build: (d) => buildInteractionsBySource(PID, PARITY_RANGE, d),
    sortKeys: ["event_type", "source"],
    // The fixtures hold three mouse clicks (two in s1, one in s2) and one mouse
    // move (s2). Validates the per-(event_type, source) GROUP and the
    // DISTINCT-session count render identically on both engines (ADR 0011).
    golden: [
      { event_type: "pointer_click", source: "mouse", count: 3, sessions: 2 },
      { event_type: "pointer_move", source: "mouse", count: 1, sessions: 1 },
    ],
  },
  {
    // Funnel (#78, ADR 0038): an ordered camera_sample → click-on-"sphere"
    // funnel. Step 0 (camera_sample) is reached by both sessions: s1 at T0+1s,
    // s2 at T0+11s. Step 1 (pointer_click with mesh "sphere") is reached only by
    // s1 (its T0+4s click hits "sphere", at/after the T0+1s camera_sample); s2's
    // only click hits "floor", so it drops. Exercises the sequential CTE chain,
    // the mesh predicate, and the per-step session count. Hand-verified.
    name: "funnel",
    build: (d) =>
      buildFunnel(
        PID,
        {
          ...PARITY_RANGE,
          steps: [{ type: "camera_sample" }, { type: "pointer_click", mesh: "sphere" }],
        },
        d,
      ),
    sortKeys: ["step"],
    golden: [
      { step: 0, sessions: 2 },
      { step: 1, sessions: 1 },
    ],
  },
];
