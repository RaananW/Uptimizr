/**
 * Shared, dialect-agnostic types for the analytics query layer (ADR 0020).
 *
 * These option and row shapes describe *what* an aggregation needs, independent
 * of any SQL dialect. Aggregations are authored once against these types in
 * `aggregations.ts` and rendered per engine via a {@link Dialect}; the OSS
 * default engine is DuckDB, with a single-tenant ClickHouse dialect available to
 * the optional scale tier.
 */

/** A parameterized query, ready to hand to a dialect-specific runner. */
export interface QuerySpec {
  query: string;
  query_params: Record<string, unknown>;
}

export interface RangeOptions {
  /** Inclusive lower bound (epoch ms). */
  since?: number;
  /** Exclusive upper bound (epoch ms). */
  until?: number;
}

/** Optional scene/area filter (ADR 0010). */
export interface SceneOptions {
  /** Restrict to a single developer-assigned scene id. Omit for all scenes. */
  scene?: string;
}

/** Optional input-source filter (ADR 0011). */
export interface SourceOptions {
  /** Restrict to a single input source (e.g. `"mouse"`, `"hand"`). Omit for all. */
  source?: string;
}

/** Optional single-session filter. */
export interface SessionOptions {
  /** Restrict the aggregate to one session id. Omit for all sessions. */
  session?: string;
}

/** Optional single-mesh filter (per-object aggregations, e.g. the UV heatmap, #149). */
export interface MeshOptions {
  /** Restrict the aggregate to one mesh/object name. Omit for all meshes. */
  mesh?: string;
}

/**
 * Optional filters for the spatial error heatmap (issue #154). All are additive
 * equality filters read from the event `payload`:
 * - `severity` / `category` scope to `graphics_diagnostic` rows (a `runtime_error`
 *   carries neither, so setting either excludes JS errors).
 * - `errorKind` scopes to `runtime_error` rows by their `kind`
 *   (`error` / `unhandledrejection`); a `graphics_diagnostic` carries no `kind`,
 *   so setting it excludes engine diagnostics.
 * Omit all three to bin every positioned error + diagnostic together.
 */
export interface ErrorHeatmapOptions {
  /** `graphics_diagnostic` severity (`info` / `warning` / `error` / `fatal`). */
  severity?: string;
  /** `graphics_diagnostic` category (`context-loss` / `validation` / `shader-compile` / …). */
  category?: string;
  /** `runtime_error` kind (`error` / `unhandledrejection`). */
  errorKind?: string;
}

/**
 * Axis-aligned bounding box in world space, encoded as
 * `[minX, minY, minZ, maxX, maxY, maxZ]` — structurally identical to the schema
 * `Aabb`, re-declared here so the query layer has no dependency on `@uptimizr/schema`.
 */
export type WorldAabb = readonly [number, number, number, number, number, number];

/**
 * Optional world-space region filter (ADR 0040 §4): restrict a spatial heatmap to
 * an axis-aligned box. Drives semantic-zoom drill-down — the viewer re-bins a
 * sub-region at finer resolution. Omit for the whole scene.
 */
export interface RegionOptions {
  /** `[minX, minY, minZ, maxX, maxY, maxZ]` in canonical world space. Omit for unbounded. */
  region?: WorldAabb;
}

/**
 * Optional camera/navigation-model filter (ADR 0026). Segments aggregates by the
 * `scene.cameraType` declared on each session's `session_start` — e.g.
 * `"arc-rotate"` (orbit viewer) vs. `"free"` (first-person walkthrough). Omit for
 * all camera types. Implemented as a `session_id IN (…)` sub-select over
 * `session_start`, so it composes with every other filter.
 */
export interface CameraModeOptions {
  /** Restrict to sessions whose `scene.cameraType` equals this value. */
  cameraType?: string;
}

/** Time-series bucketing options. */
export interface TimeseriesOptions {
  /** Bucket width in seconds (default 3600 = 1h). */
  interval?: number;
  /** Restrict the volume to a single event type. Omit to count all events. */
  type?: string;
}

export interface SessionSummaryRow {
  session_id: string;
  visitor_id: string;
  events: number;
  started_at: string;
  ended_at: string;
}

export interface HeatmapBinRow {
  gx: number;
  gy: number;
  count: number;
}

export interface WorldHeatmapBinRow {
  vx: number;
  vy: number;
  vz: number;
  count: number;
}

/**
 * Scene-wide totals for a spatial heatmap (ADR 0040 §3). Computed without a
 * `LIMIT`, so it reports the *true* occupied-cell and hit counts behind a
 * truncated top-N voxel list — letting the viewer say "showing top 1000 of N
 * cells" and reason about cold spots/coverage. Region-aware: when a
 * {@link RegionOptions.region} is set, the totals describe only that box.
 */
export interface SpatialStatsRow {
  /** Number of occupied (non-empty) cells across the whole scene/region. */
  cells: number;
  /** Total hits (sum of per-cell counts) across the whole scene/region. */
  hits: number;
}

/**
 * One bin of the top-down "floor plan" camera-position heatmap (ADR 0026): camera
 * positions binned on the X/Z ground plane into `cellSize`-sized cells, with the
 * cell-average Y for reference. Reveals where visitors stand/dwell in a walkable scene.
 */
export interface PositionBinRow {
  gx: number;
  gz: number;
  /** Mean Y (height) of camera samples in the cell. */
  avg_y: number;
  count: number;
}

/** One ordered point of a session's walked path (ADR 0026). */
export interface TrajectoryPointRow {
  ts: string;
  x: number;
  y: number;
  z: number;
}

/**
 * One ordered, ground-binned point of an aggregate desire line (#73, ADR 0037):
 * a `camera_sample` position binned onto the X/Z grid and keyed by `session_id`
 * so the consumer can draw one poly-line per session and let overlaps build density.
 */
export interface AggregateTrajectoryPointRow {
  session_id: string;
  ts: string;
  gx: number;
  gz: number;
}

/**
 * One (mesh, interaction-kind) tally (#72, ADR 0023): how many times each kind
 * of interaction (hover / pick / click / drag / …) landed on a given mesh.
 */
export interface MeshInteractionKindRow {
  mesh: string;
  kind: string;
  count: number;
}

/**
 * One (mesh, distance-band) tally for the reachability report (#151): how many
 * interactions with `mesh` landed `bucket * bucketSize` .. `(bucket+1) *
 * bucketSize` world units from the click-time camera standpoint, plus the mean
 * distance within that band. Far bands flag meshes/UI reached from an
 * uncomfortable range.
 */
export interface ReachabilityBinRow {
  mesh: string;
  bucket: number;
  count: number;
  avg_distance: number;
}

/**
 * One (mesh, source) tally (#74): the most-interacted-mesh count broken out by
 * the input `source` (mouse / touch / xr-controller / …). Summing a mesh's rows
 * reproduces its overall interaction total.
 */
export interface MeshSourceCountRow {
  mesh: string;
  source: string;
  count: number;
}

/**
 * One (mesh, bucket) tally (#74): a mesh's interaction count within a fixed
 * `interval`-second time window, for the leaderboard's per-mesh trend sparkline.
 * `bucket` is the window start as epoch milliseconds.
 */
export interface MeshTrendPointRow {
  mesh: string;
  bucket: number;
  count: number;
}

/**
 * One (action, source) tally (#75, ADR 0023): how many times each app-level
 * `input_action` label (a keyboard chord / gamepad button mapped to an action)
 * fired, split by input `source`. The most-used-shortcuts leaderboard.
 */
export interface InputActionCountRow {
  action: string;
  source: string;
  count: number;
}

/**
 * Render-scale truth (#71, ADR 0021): the FPS headline paired with the
 * resolution the engine actually rendered at. `downscaled_samples / scale_samples`
 * gives the share of reported frames that rendered below native resolution.
 */
export interface RenderScaleTruthRow {
  samples: number;
  avg_fps: number;
  p50_fps: number;
  /** Mean of reported (`render_scale` > 0) values; null when nothing reported. */
  avg_render_scale: number | null;
  p50_render_scale: number | null;
  /** Reported samples rendered below native resolution (0 < render_scale < 1). */
  downscaled_samples: number;
  /** Reported samples with a non-sentinel render scale (render_scale > 0). */
  scale_samples: number;
}

export interface DirectionBinRow {
  azimuth_bin: number;
  elevation_bin: number;
  count: number;
}

/**
 * One bucket of the 360° view-coverage histogram (#146): `bucket` is the
 * inclusive lower bound (percent) of a 25-wide coverage band (`0`, `25`, `50`,
 * `75`), and `sessions` is how many sessions fell in it. Coverage is the fraction
 * of the view-direction dome grid a session's `camera_sample` directions visited.
 */
export interface ViewCoverageHistogramRow {
  bucket: number;
  sessions: number;
}

export interface ClickGazeRayRow {
  cam_vx: number;
  cam_vy: number;
  cam_vz: number;
  origin_x: number;
  origin_y: number;
  origin_z: number;
  hit_vx: number;
  hit_vy: number;
  hit_vz: number;
  hit_x: number;
  hit_y: number;
  hit_z: number;
  mesh: string;
  count: number;
}

export interface FlowLinkRow {
  azimuth_bin: number;
  elevation_bin: number;
  mesh: string;
  count: number;
  /**
   * Standpoint voxel indices — the click-time camera-position cell (design §7.8).
   * Present only in the position-aware mode (`groupByOrigin`/`originVoxel`);
   * omitted by the default direction-only §7.5 flow.
   */
  origin_vx?: number;
  origin_vy?: number;
  origin_vz?: number;
  /** Averaged standpoint world point for the voxel (position-aware mode, §7.8). */
  origin_x?: number;
  origin_y?: number;
  origin_z?: number;
}

export interface MeshCountRow {
  mesh: string;
  count: number;
}

/** Per-object attention summary from `mesh_visibility` events (#37). */
export interface MeshDwellRow {
  mesh: string;
  /** Total on-screen time across the range, in ms. */
  visible_ms: number;
  /** Total time the object was near the view centre (gaze proxy), in ms. */
  centered_ms: number;
  /** Largest screen fraction the object reached (prominence proxy), 0..1. */
  max_screen_fraction: number;
  /** Number of bucketed summary events contributing to the totals. */
  samples: number;
}

/**
 * Blind-spot / never-noticed mesh summary (#143): visibility vs. engagement per
 * mesh. High `visible_ms` with low `interactions + hover_episodes` is a blind
 * spot — rendered but never noticed.
 */
export interface MeshBlindSpotRow {
  mesh: string;
  /** Total on-screen time from `mesh_visibility` summaries, in ms (> 0). */
  visible_ms: number;
  /** Number of `mesh_visibility` summaries contributing to `visible_ms`. */
  vis_samples: number;
  /** Number of `mesh_interaction` events on the mesh (active engagement). */
  interactions: number;
  /** Total hover-without-action time from `hover_dwell` summaries, in ms. */
  hover_ms: number;
  /** Number of `hover_dwell` hesitation episodes on the mesh. */
  hover_episodes: number;
}

/** Dead-click rate summary from `pointer_click` events (#46). */
export interface DeadClickRow {
  /** Total clicks in range. */
  total_clicks: number;
  /** Clicks that hit no mesh (empty space) — the dead clicks. */
  dead_clicks: number;
}

/** A rage-click cluster: rapid repeats on one mesh in a time window (#47). */
export interface RageClickRow {
  session_id: string;
  mesh: string;
  /** Window start as epoch milliseconds. */
  bucket: number;
  /** Number of clicks on the mesh within the window (>= minRepeats). */
  clicks: number;
}

/** Per-object hover-hesitation summary from `hover_dwell` events (#48). */
export interface HoverDwellRow {
  mesh: string;
  /** Total time visitors hovered the object without clicking it, in ms. */
  dwell_ms: number;
  /** Longest single hover episode on the object, in ms. */
  max_dwell_ms: number;
  /** Number of hover episodes contributing to the totals. */
  episodes: number;
}

/** Per-phase shader/pipeline compile-stall summary from `compile_stall` events (#42). */
export interface CompileStallRow {
  /** Coarse compile phase (`shader` / `pipeline` / `material` / `other`); `""` if unattributed. */
  phase: string;
  /** Number of compile stalls in the phase. */
  stalls: number;
  /** Total main-thread time spent compiling, in ms. */
  total_ms: number;
  /** Average compile-stall duration, in ms. */
  avg_ms: number;
  /** Worst single compile-stall duration, in ms. */
  max_ms: number;
}

/** GPU / memory footprint summary from `resource_sample` samples (#44). */
export interface ResourceSummaryRow {
  /** Number of footprint samples in the range. */
  samples: number;
  /** Average used JS heap in bytes (unreported samples excluded). */
  avg_js_heap_bytes: number;
  /** Peak used JS heap in bytes. */
  max_js_heap_bytes: number;
  /** Average triangles submitted per sampled frame. */
  avg_triangles: number;
  /** Peak triangles submitted in a sampled frame. */
  max_triangles: number;
  /** Average vertices submitted per sampled frame. */
  avg_vertices: number;
  /** Peak vertices submitted in a sampled frame. */
  max_vertices: number;
  /** Average resident texture memory in bytes. */
  avg_texture_bytes: number;
  /** Peak resident texture memory in bytes. */
  max_texture_bytes: number;
  /** Average resident geometry memory in bytes. */
  avg_geometry_bytes: number;
  /** Peak resident geometry memory in bytes. */
  max_geometry_bytes: number;
}

/** Per-transition capability fallback/recovery summary from `capability_change` events (#49). */
export interface CapabilityChangeRow {
  /** Capability class (`graphics-backend` / `quality` / `device-recovery` / `feature` / `other`). */
  kind: string;
  /** Previous capability token (e.g. `webgpu`); `""` if unreported. */
  from: string;
  /** New capability token (e.g. `webgl2`); `""` if unreported. */
  to: string;
  /** Number of times this transition was reported. */
  changes: number;
}

/** Per-kind camera-navigation gesture summary from `camera_gesture` events (ADR 0025). */
export interface CameraGestureRow {
  /** Gesture class (`orbit` / `pan` / `dolly` / `zoom` / `roll` / `fly` / `navigate`). */
  kind: string;
  /** Number of gestures of this kind. */
  gestures: number;
  /** Total time spent in this gesture kind, in ms. */
  total_ms: number;
  /** Average gesture duration, in ms. */
  avg_ms: number;
  /** Longest single gesture, in ms. */
  max_ms: number;
}

export interface PerfSummaryRow {
  samples: number;
  avg_fps: number;
  min_fps: number;
  p50_fps: number;
}

/** Per-session-then-aggregate FPS percentiles (ADR 0028 §1). */
export interface PerfDistributionRow {
  sessions: number;
  samples: number;
  p05_fps: number;
  p50_fps: number;
  p95_fps: number;
}

/**
 * Options for {@link "./aggregations".buildPerfChurn} (#144): the standard
 * range / scene / session scope plus the correlation thresholds. All three
 * thresholds have defaults so the panel can call with just a scope.
 */
export interface PerfChurnOptions extends RangeOptions, SceneOptions, SessionOptions {
  /**
   * How long before a session's end a perf dip still counts as correlated, in
   * milliseconds (default 30000). A larger window attributes more distant dips
   * to the churn; a smaller one demands the dip be the last thing the user saw.
   */
  windowMs?: number;
  /** A `frame_perf` sample counts as an FPS dip when `fps` is below this (default 30). */
  fpsThreshold?: number;
  /** A `compile_stall` counts when its main-thread duration (ms) is at least this (default 100). */
  stallMs?: number;
}

/**
 * Perf-correlated churn (#144): a single-row correlation between perf dips and
 * early session end. Of the sessions that ended in range (`sessions`),
 * `churn_sessions` ended within the configured window after an FPS dip or a
 * `compile_stall`. `fps_churn_sessions` / `stall_churn_sessions` attribute the
 * cause; a session that hit both is counted in each cause column but only once
 * in `churn_sessions`, so the cause columns can sum to more than the total.
 */
export interface PerfChurnRow {
  /** Distinct sessions with a `session_end` in the range/scene/session scope. */
  sessions: number;
  /** Ended sessions with ≥1 qualifying dip in `[end - windowMs, end]`. */
  churn_sessions: number;
  /** Churned sessions whose window contained a low-FPS `frame_perf` sample. */
  fps_churn_sessions: number;
  /** Churned sessions whose window contained a `compile_stall`. */
  stall_churn_sessions: number;
}

/** One bin of the per-session-median FPS histogram (ADR 0028 §1). */
export interface FpsHistogramRow {
  /** Inclusive lower bound (FPS) of the bin. */
  bucket: number;
  sessions: number;
}

/** Per-session-then-aggregate frame-time percentiles, in ms (ADR 0028 §1). */
export interface FrameTimePercentileRow {
  sessions: number;
  samples: number;
  p50_ms: number;
  p95_ms: number;
}

/** Per-session-then-aggregate jank rate (ADR 0028 §1). */
export interface JankRateRow {
  sessions: number;
  total_long_frames: number;
  /** Median per-session long-frames-per-window rate. */
  median_rate: number;
  /** Worst-decile (p90) per-session rate. */
  worst_decile_rate: number;
}

/** FPS segmented by device class from `session_start.device` (ADR 0028 §2). */
export interface PerfByDeviceRow {
  engine: string;
  is_mobile: string;
  renderer: string;
  /** Coarse browser family derived from the User-Agent at ingestion (ADR 0041). */
  browser: string;
  /** Coarse OS family derived from the User-Agent at ingestion (ADR 0041). */
  os: string;
  sessions: number;
  samples: number;
  p50_fps: number;
}

/** FPS segmented by scene, per-session-then-aggregate (ADR 0028 §1). */
export interface PerfBySceneRow {
  scene_id: string;
  sessions: number;
  samples: number;
  p50_fps: number;
}

/** Per-session-then-aggregate GPU/memory footprint percentiles (ADR 0028 §1). */
export interface ResourcePercentileRow {
  sessions: number;
  samples: number;
  p50_js_heap_bytes: number;
  p95_js_heap_bytes: number;
  p50_texture_bytes: number;
  p95_texture_bytes: number;
  p50_triangles: number;
  p95_triangles: number;
}

/** Stability-incident counts (context losses, compile stalls). */
export interface StabilityCountRow {
  context_losses: number;
  compile_stalls: number;
  incidents: number;
}

/**
 * Opt-in engine-diagnostic counts (ADR 0021 part 2): the crossed
 * `(severity, category, backend)` group with the rollup-aware incident total.
 * `backend` is `''` when the connector omitted it.
 */
export interface GraphicsDiagnosticCountRow {
  severity: string;
  category: string;
  backend: string;
  incidents: number;
}

/**
 * Always-on rendering-technology mix (ADR 0021 part 1): the crossed
 * `(api, backend, api_version, shading_language)` group with one session count per
 * cell, so the dashboard can derive the by-api, by-backend, by-version, and
 * by-shading-language breakdowns from a single query by summing. Each field is
 * `''` ("unknown") when the connector omitted it.
 */
export interface RenderingTechnologyRow {
  api: string;
  backend: string;
  api_version: string;
  shading_language: string;
  sessions: number;
}

export interface PerfDailyRow {
  day: string;
  samples: number;
  avg_fps: number;
  min_fps: number;
  p50_fps: number;
}

export interface EventsDailyRow {
  day: string;
  event_type: string;
  events: number;
}

export interface SceneRow {
  scene_id: string;
  events: number;
  last_seen: string;
}

export interface TimeseriesBucketRow {
  /** Start of the bucket as epoch milliseconds. */
  bucket: number;
  events: number;
  avg_fps: number;
}

export interface EventTypeCountRow {
  event_type: string;
  count: number;
}

/** One occupied camera-position voxel for scene coverage / dead-zone analysis. */
export interface CoverageVoxelRow {
  vx: number;
  vy: number;
  vz: number;
  count: number;
}

/**
 * One voxel of the spatial FPS heatmap (#145): `frame_perf` samples voxel-binned by
 * their captured camera `position` into `cellSize`-sized cubes. `samples` is the
 * `frame_perf` sample count in the cell, `avg_fps` its mean FPS, and `min_fps` its
 * worst single sample — so the viewer can paint "where FPS is bad" in world space.
 */
export interface PerfHeatmapVoxelRow {
  vx: number;
  vy: number;
  vz: number;
  samples: number;
  avg_fps: number;
  min_fps: number;
}

/** One distance-histogram bucket: `bucket * bucketSize` world units from center. */
export interface CameraDistanceBucketRow {
  bucket: number;
  count: number;
}

/** Per-session navigation-effort summary (travel distance, active vs idle). */
export interface NavigationStatsRow {
  session_id: string;
  segments: number;
  total_distance: number;
  active_segments: number;
  active_distance: number;
}

/**
 * One row of the path-retrace / backtracking leaderboard (#153): a scene/area
 * with its pooled backtrack ratio and the raw counts behind it.
 */
export interface BacktrackRatioRow {
  /** Developer-assigned scene id the counts are pooled over (may be empty). */
  scene: string;
  /** Distinct sessions that entered any cell in this scene. */
  sessions: number;
  /** Total coarse-grid cell entries (consecutive dwell samples collapsed). */
  entries: number;
  /** Entries into an already-visited cell — the re-walked-area signal. */
  revisits: number;
  /** `revisits / entries` in [0, 1); higher = more confusion / re-walking. */
  backtrack_ratio: number;
}

/** Per-session XR motion-sickness proxy: view-rotation rate over the pose stream. */
export interface XrRotationRateRow {
  session_id: string;
  samples: number;
  avg_turn_rad: number;
  max_turn_rad: number;
  total_turn_rad: number;
  rapid_segments: number;
}

/** One XR input source (`hand`, `xr-controller`, …) with its usage counts. */
export interface XrSourceUsageRow {
  source: string;
  interactions: number;
  sessions: number;
}

/**
 * One `(event_type, source)` pairing from the input-source breakdown (ADR 0011):
 * how many interactions of that type came from that input source, and across how
 * many distinct sessions.
 */
export interface InteractionSourceRow {
  /** The interaction event type (e.g. `mesh_interaction`, `pointer_click`). */
  event_type: string;
  /** The input source that triggered it (e.g. `mouse`, `xr-controller`, `hand`). */
  source: string;
  /** Number of events of this `(event_type, source)` pairing. */
  count: number;
  /** Number of distinct sessions that produced this pairing. */
  sessions: number;
}

/** Per-XR-session abandonment row: time bounds and event/interaction counts. */
export interface XrAbandonmentRow {
  session_id: string;
  events: number;
  xr_interactions: number;
  started_at: string;
  ended_at: string;
}

/**
 * Per-XR-session locomotion + comfort row (#148): the locomotion-style breakdown
 * for one session that used an XR input source, plus its wall-clock span so the
 * consumer can correlate heavy locomotion with early exits (a discomfort proxy).
 *
 * A teleport emits **both** a `camera_gesture { kind: "fly" }` (the resulting
 * viewpoint jump) and a `mesh_interaction { kind: "teleport" }` (the target pick)
 * per ADR 0025, so `fly_gestures` counts all thumbstick + teleport flies while
 * `teleports` isolates the discrete jumps — the consumer derives smooth
 * locomotion as `fly_gestures - teleports`.
 */
export interface XrLocomotionRow {
  session_id: string;
  /** `camera_gesture { kind: "fly" }` count — smooth thumbstick + teleport flies. */
  fly_gestures: number;
  /** `camera_gesture { kind: "navigate" }` count — untyped user-bracketed moves. */
  navigate_gestures: number;
  /** `mesh_interaction { kind: "teleport" }` count — discrete viewpoint jumps. */
  teleports: number;
  /** Total time spent in fly + navigate gestures, in ms (from `visible_ms`). */
  locomotion_ms: number;
  /** First event timestamp for the session (engine-formatted; excluded from parity). */
  started_at: string;
  /** Last event timestamp for the session (engine-formatted; excluded from parity). */
  ended_at: string;
}

/**
 * One funnel step predicate (ADR 0038): the structural subset of a
 * `@uptimizr/schema` `FunnelStep` the aggregation compiles to SQL. Each field
 * maps to a promoted column — `type`→`event_type`, `name`→the `name` column
 * (gesture/interaction kind or custom name), `mesh`→`mesh` — so the predicate is
 * pure equality and dialect-agnostic. `label` is presentation-only and ignored
 * by the query.
 */
export interface FunnelStepInput {
  type: string;
  name?: string;
  mesh?: string;
  label?: string;
}

/**
 * Options for {@link "./aggregations".buildFunnel}: the ordered `steps` plus the
 * standard range / scene / camera-mode scope applied to every step.
 */
export interface FunnelOptions extends RangeOptions, SceneOptions, CameraModeOptions {
  /** Ordered step predicates; array order is the funnel order (min 2). */
  steps: readonly FunnelStepInput[];
}

/**
 * One funnel row (ADR 0038): how many sessions reached step `step` (0-based) in
 * order. `sessions[k] / sessions[k-1]` is the conversion into step k; the
 * consumer attaches labels from the input steps and computes the rates.
 */
export interface FunnelStepResultRow {
  step: number;
  sessions: number;
}

/**
 * Options for {@link "./aggregations".buildSceneRetention} (#147): the standard
 * time range plus an optional cap on the number of returned links. There is no
 * scene filter — the preset's whole point is the *cross-scene* flow, so scoping
 * to a single scene would defeat it.
 */
export interface SceneRetentionOptions extends RangeOptions {
  /** Max links returned (busiest first). Defaults applied by the caller. */
  limit?: number;
}

/**
 * One directed scene-to-scene retention link (#147): how many distinct sessions
 * made the consecutive transition `from_scene → to_scene`, derived purely from
 * the observed order of `scene_change` events. This is the canned "level funnel"
 * preset — a zero-config complement to the caller-authored funnel (ADR 0038).
 */
export interface SceneRetentionRow {
  from_scene: string;
  to_scene: string;
  sessions: number;
}

/**
 * Options for {@link "./aggregations".buildLoadBounceFunnel} (#152): the standard
 * range / scene scope plus the ascending load-time band boundaries (ms). Each
 * value is the exclusive upper bound of a band; `bands.length + 1` bands result
 * (the final, open-ended band catches everything `>=` the last boundary).
 * Defaults to `[1000, 3000, 5000]` when omitted. Labels are the caller's concern
 * (kept out of the query, mirroring the funnel step labels).
 */
export interface LoadBounceFunnelOptions extends RangeOptions, SceneOptions {
  /** Ascending band boundaries in milliseconds; `undefined` uses the default. */
  bands?: readonly number[];
}

/**
 * One load-time band of the load→bounce funnel (#152): how many sessions loaded
 * within band `band` (0-based, ordered by ascending load time) and, of those,
 * how many **bounced** — produced no interaction event (`pointer_*` /
 * `mesh_interaction` / `camera_gesture`) at or after their initial `asset_load`.
 * The consumer derives the bounce rate as `bounced / sessions` and attaches the
 * band labels from its own boundaries.
 */
export interface LoadBounceBandRow {
  band: number;
  sessions: number;
  bounced: number;
}

/**
 * Options for {@link "./aggregations".buildVariantLeaderboard} (#150) — the
 * variant → conversion leaderboard for product configurators.
 *
 * A **variant** is a `custom` event grouped by its promoted `name` column (color
 * / material / SKU swaps are emitted as custom events; `props`/payload are not
 * portably queryable, so `name` is the discriminator — see ADR 0038 §"Step
 * predicate"). `variant` scopes *which* events are variants (defaults to every
 * `custom` event); `conversion` is the optional "success" event predicate. Both
 * reuse the funnel-step predicate shape so matching is pure, promoted-column
 * equality — dialect-agnostic and injection-safe. `label` is ignored by SQL.
 */
export interface VariantLeaderboardOptions extends RangeOptions, SceneOptions, CameraModeOptions {
  /** Predicate selecting the variant events; defaults to `{ type: "custom" }`. */
  variant?: FunnelStepInput;
  /**
   * Optional "success" event predicate. When supplied, the leaderboard reports
   * per-variant conversions (sessions that fired it at/after their first view of
   * the variant) and counts it as a dwell boundary; when omitted, only views and
   * switch-boundary dwell are reported.
   */
  conversion?: FunnelStepInput;
  /** Max ranked variants returned (by view count). */
  limit?: number;
}

/**
 * One leaderboard row (#150): a single variant (`name`) with how many times it
 * was viewed, over how many distinct sessions, how many of those sessions
 * converted, and the mean dwell before the next boundary (a switch to a
 * different variant or the conversion event). `conversions` is `0` when no
 * `conversion` predicate was supplied; the consumer derives the rate as
 * `conversions / sessions`.
 */
export interface VariantLeaderboardRow {
  variant: string;
  views: number;
  sessions: number;
  conversions: number;
  avg_dwell_ms: number;
}
