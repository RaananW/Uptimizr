import type { AnyEvent, SceneProxy } from "@uptimizr/schema";
import type {
  CameraDistanceBucketRow,
  CameraModeOptions,
  ClickGazeRayRow,
  CoverageVoxelRow,
  DeadClickRow,
  DirectionBinRow,
  EventTypeCountRow,
  FlowLinkRow,
  HeatmapBinRow,
  HoverDwellRow,
  CompileStallRow,
  ResourceSummaryRow,
  CapabilityChangeRow,
  CameraGestureRow,
  MeshCountRow,
  MeshDwellRow,
  PositionBinRow,
  RageClickRow,
  NavigationStatsRow,
  XrRotationRateRow,
  XrSourceUsageRow,
  XrAbandonmentRow,
  InteractionSourceRow,
  PerfSummaryRow,
  PerfDistributionRow,
  FpsHistogramRow,
  FrameTimePercentileRow,
  JankRateRow,
  PerfByDeviceRow,
  PerfBySceneRow,
  ResourcePercentileRow,
  StabilityCountRow,
  RangeOptions,
  SceneOptions,
  SceneRepresentation,
  SceneRepresentationSummary,
  SceneRow,
  SourceOptions,
  SessionOptions,
  SessionMeta,
  SessionSummaryRow,
  TimeseriesBucketRow,
  TimeseriesOptions,
  TrajectoryPointRow,
  WorldHeatmapBinRow,
} from "@uptimizr/db";

/**
 * The data-access surface the routes depend on. Abstracting it behind an
 * interface keeps handlers thin and lets tests inject a fake store without a
 * live ClickHouse/Postgres (the framework and the DB stay swappable — ADR 0005).
 */
export interface CollectorStore {
  /** Resolve a plaintext API key to its project id, or `null` if invalid/revoked. */
  resolveApiKey(key: string): Promise<string | null>;
  /**
   * Whether a project with this id exists. The ingest route uses it to reject
   * events for unknown projects — the public `projectId` is the ingest credential,
   * so a non-existent project must never have data written under it.
   */
  projectExists(projectId: string): Promise<boolean>;
  /** Batched insert of enriched, validated events. */
  insertEvents(events: readonly AnyEvent[]): Promise<void>;
  listSessions(
    projectId: string,
    opts?: RangeOptions & CameraModeOptions & { limit?: number },
  ): Promise<SessionSummaryRow[]>;
  pointerHeatmap(
    projectId: string,
    opts?: RangeOptions &
      SceneOptions &
      SourceOptions &
      SessionOptions &
      CameraModeOptions & { bins?: number },
  ): Promise<HeatmapBinRow[]>;
  /** World-space (3D) pointer heatmap: voxel-binned raycast hit points. */
  worldHeatmap(
    projectId: string,
    opts?: RangeOptions &
      SceneOptions &
      SourceOptions &
      CameraModeOptions & { cellSize?: number; limit?: number },
  ): Promise<WorldHeatmapBinRow[]>;
  /**
   * World-space (3D) gaze heatmap (ADR 0030): voxel-binned camera-pose gaze
   * surface hits (`camera_sample.hitPoint`). The "what did people actually look
   * at" map — distinct from the click-driven world heatmap. Optional `session`
   * scopes it to one visit (ADR 0010 §1a).
   */
  gazeHeatmap(
    projectId: string,
    opts?: RangeOptions &
      SceneOptions &
      SessionOptions &
      CameraModeOptions & { cellSize?: number; limit?: number },
  ): Promise<WorldHeatmapBinRow[]>;
  cameraHeatmap(
    projectId: string,
    opts?: RangeOptions & SceneOptions & SessionOptions & CameraModeOptions & { bins?: number },
  ): Promise<DirectionBinRow[]>;
  /**
   * Top-down "floor plan" camera-position heatmap (ADR 0026): `camera_sample`
   * world positions binned on the X/Z ground plane. The first-person analog of
   * the 2D pointer heatmap.
   */
  cameraPositionHeatmap(
    projectId: string,
    opts?: RangeOptions &
      SceneOptions &
      SessionOptions &
      CameraModeOptions & { cellSize?: number; limit?: number },
  ): Promise<PositionBinRow[]>;
  /** One session's ordered walked path (ADR 0026): camera positions, oldest first. */
  sessionTrajectory(
    projectId: string,
    sessionId: string,
    opts?: RangeOptions & SceneOptions & { limit?: number },
  ): Promise<TrajectoryPointRow[]>;
  /**
   * View-gated click rays (design §7.2/§7.3): each `pointer_click` correlated to
   * the nearest preceding `camera_sample`, aggregated into camera-origin → hit
   * rays grouped by voxel and clicked mesh.
   */
  clickGazeRays(
    projectId: string,
    opts?: RangeOptions &
      SceneOptions &
      SourceOptions &
      SessionOptions & { cellSize?: number; limit?: number },
  ): Promise<ClickGazeRayRow[]>;
  /**
   * Aggregate gaze→mesh flow links (design §7.5): click-time camera direction
   * bins joined to clicked meshes. In position-aware mode (§7.8) the click-time
   * camera position is restored as a standpoint voxel dimension.
   */
  flowHeatmap(
    projectId: string,
    opts?: RangeOptions &
      SceneOptions &
      SessionOptions &
      CameraModeOptions & {
        bins?: number;
        limit?: number;
        cellSize?: number;
        groupByOrigin?: boolean;
        originVoxel?: readonly [number, number, number];
      },
  ): Promise<FlowLinkRow[]>;
  topMeshes(
    projectId: string,
    opts?: RangeOptions & SessionOptions & { limit?: number },
  ): Promise<MeshCountRow[]>;
  /**
   * Object dwell ranking (#37): per-mesh attention from `mesh_visibility`
   * summaries — total visible/centered time and peak screen fraction.
   */
  meshDwell(
    projectId: string,
    opts?: RangeOptions & SceneOptions & SessionOptions & { limit?: number },
  ): Promise<MeshDwellRow[]>;
  /**
   * Dead-click rate (#46): total clicks vs. clicks that hit empty space, from
   * `pointer_click` events. The consumer derives the rate.
   */
  deadClicks(
    projectId: string,
    opts?: RangeOptions & SceneOptions & SourceOptions & SessionOptions,
  ): Promise<DeadClickRow[]>;
  /**
   * Rage clicks (#47): rapid repeated clicks on the same mesh, bucketed into
   * fixed time windows; a frustration signal derived from the click stream.
   */
  rageClicks(
    projectId: string,
    opts?: RangeOptions &
      SceneOptions &
      SourceOptions &
      SessionOptions & { interval?: number; minRepeats?: number; limit?: number },
  ): Promise<RageClickRow[]>;
  /**
   * Hover hesitation (#48): per-mesh dwell time spent hovering an object without
   * clicking it, from `hover_dwell` summaries. Surfaces objects that look
   * interactive but aren't (or aren't obviously clickable).
   */
  hoverDwell(
    projectId: string,
    opts?: RangeOptions & SceneOptions & SourceOptions & SessionOptions & { limit?: number },
  ): Promise<HoverDwellRow[]>;
  /**
   * Compile stalls (#42): per-phase shader/pipeline compilation hitches from
   * `compile_stall` events — the felt first-interaction jank `frame_perf`
   * averages away.
   */
  compileStalls(
    projectId: string,
    opts?: RangeOptions & SceneOptions & SessionOptions & { limit?: number },
  ): Promise<CompileStallRow[]>;
  /**
   * Resource footprint (#44): GPU / memory cost summary from `resource_sample`
   * events — average and peak texture/geometry bytes, triangles/vertices, and JS
   * heap the scene asked of the device (vs. the device caps in `session_start`).
   */
  resourceSummary(
    projectId: string,
    opts?: RangeOptions & SessionOptions,
  ): Promise<ResourceSummaryRow[]>;
  /**
   * Capability changes (#49): per-transition fallback/recovery counts from
   * `capability_change` events (e.g. how many sessions fell back WebGPU→WebGL2)
   * — explains perf / visual-fidelity variance across the user base.
   */
  capabilityChanges(
    projectId: string,
    opts?: RangeOptions & SceneOptions & SessionOptions & { limit?: number },
  ): Promise<CapabilityChangeRow[]>;
  /**
   * Camera gestures (ADR 0025): per-kind navigation breakdown from
   * `camera_gesture` events (orbit / pan / dolly / zoom / roll / fly) — how an
   * audience moves the viewpoint, separated from object selection.
   */
  cameraGestures(
    projectId: string,
    opts?: RangeOptions & SceneOptions & SourceOptions & SessionOptions & { limit?: number },
  ): Promise<CameraGestureRow[]>;
  perfSummary(projectId: string, opts?: RangeOptions & SessionOptions): Promise<PerfSummaryRow[]>;
  /**
   * FPS distribution (ADR 0028 §1): per-session p05/p50/p95 FPS summarized across
   * sessions (median-of-medians), so neither long sessions nor fast devices skew
   * the headline. The distribution-honest replacement for the volume-chart mean.
   */
  perfDistribution(
    projectId: string,
    opts?: RangeOptions & SceneOptions & SessionOptions,
  ): Promise<PerfDistributionRow[]>;
  /** Histogram of per-session median FPS in `bucket`-wide bins (ADR 0028 §1). */
  fpsHistogram(
    projectId: string,
    opts?: RangeOptions & SceneOptions & SessionOptions & { bucket?: number },
  ): Promise<FpsHistogramRow[]>;
  /**
   * Frame-time percentiles in ms (ADR 0028 §1): per-session median frame time and
   * worst-window p95, summarized across sessions.
   */
  frameTimePercentiles(
    projectId: string,
    opts?: RangeOptions & SceneOptions & SessionOptions,
  ): Promise<FrameTimePercentileRow[]>;
  /**
   * Jank rate (ADR 0028 §1): per-session long-frames-per-window rate, reported as
   * the median and worst-decile session.
   */
  jankRate(
    projectId: string,
    opts?: RangeOptions & SceneOptions & SessionOptions,
  ): Promise<JankRateRow[]>;
  /**
   * FPS by device class (ADR 0028 §2): per-session median FPS attributed to the
   * `session_start.device` block (graphics backend, mobile flag, GPU renderer) —
   * data already on the wire, no SDK change.
   */
  perfByDevice(
    projectId: string,
    opts?: RangeOptions & SceneOptions & SessionOptions,
  ): Promise<PerfByDeviceRow[]>;
  /** FPS by scene (ADR 0028 §1): per-session median FPS grouped by scene. */
  perfByScene(
    projectId: string,
    opts?: RangeOptions & SceneOptions & SessionOptions,
  ): Promise<PerfBySceneRow[]>;
  /**
   * Resource-footprint percentiles (ADR 0028 §1): per-session p50/p95 of JS heap,
   * texture bytes, and triangle count summarized across sessions.
   */
  resourcePercentiles(
    projectId: string,
    opts?: RangeOptions & SceneOptions & SessionOptions,
  ): Promise<ResourcePercentileRow[]>;
  /** Stability incidents: context-loss and compile-stall counts over the range. */
  stabilityCounts(
    projectId: string,
    opts?: RangeOptions & SceneOptions & SessionOptions,
  ): Promise<StabilityCountRow[]>;
  /**
   * Scene coverage / dead zones (derived, scene-metrics §B): occupied
   * camera-position voxels. Coverage % is computed by the consumer against the
   * scene AABB.
   */
  sceneCoverage(
    projectId: string,
    opts?: RangeOptions & SceneOptions & SessionOptions & { cellSize?: number; limit?: number },
  ): Promise<CoverageVoxelRow[]>;
  /**
   * Camera distance / zoom distribution (derived, scene-metrics §B): histogram of
   * camera-to-`center` distance, bucketed by `bucketSize` world units.
   */
  cameraDistance(
    projectId: string,
    opts?: RangeOptions &
      SceneOptions &
      SessionOptions & {
        center?: readonly [number, number, number];
        bucketSize?: number;
        limit?: number;
      },
  ): Promise<CameraDistanceBucketRow[]>;
  /**
   * Navigation effort / friction (derived, scene-metrics §B): per-session travel
   * distance with active-vs-idle segmentation.
   */
  navigationStats(
    projectId: string,
    opts?: RangeOptions &
      SceneOptions &
      SessionOptions & { moveThreshold?: number; limit?: number },
  ): Promise<NavigationStatsRow[]>;
  /**
   * XR motion-sickness proxy (#50, scene-metrics §F): per-session head/view
   * rotation rate over the `camera_sample` pose stream — rapid view rotation is
   * the comfort/discomfort signal.
   */
  xrRotationRate(
    projectId: string,
    opts?: RangeOptions & SceneOptions & SessionOptions & { rapidTurn?: number; limit?: number },
  ): Promise<XrRotationRateRow[]>;
  /**
   * XR input-source usage (#50, scene-metrics §F): hand vs. controller (vs. gaze)
   * split read from `source` on the interaction events.
   */
  xrSourceUsage(
    projectId: string,
    opts?: RangeOptions & SceneOptions & SessionOptions & { limit?: number },
  ): Promise<XrSourceUsageRow[]>;
  /**
   * XR session abandonment (#50, scene-metrics §F): per XR session, its time
   * bounds and event/interaction counts — a short span signals headset drop-off.
   */
  xrAbandonment(
    projectId: string,
    opts?: RangeOptions & SceneOptions & SessionOptions & { limit?: number },
  ): Promise<XrAbandonmentRow[]>;
  /**
   * Input-source breakdown (ADR 0011): per `(event_type, source)`, how many
   * interactions came from each input source (mouse / touch / xr-controller /
   * hand / …) and across how many sessions — turns `source` into an insight.
   */
  interactionsBySource(
    projectId: string,
    opts?: RangeOptions & SceneOptions & SourceOptions & SessionOptions & { limit?: number },
  ): Promise<InteractionSourceRow[]>;
  /** Distinct scenes (+counts, last-seen) for the project; time-range aware (ADR 0010). */
  scenes(projectId: string, opts?: RangeOptions & { limit?: number }): Promise<SceneRow[]>;
  /** Event-volume time-series bucketed by interval (the 4th dimension). */
  timeseries(
    projectId: string,
    opts?: RangeOptions & SceneOptions & TimeseriesOptions,
  ): Promise<TimeseriesBucketRow[]>;
  /** Per-event-type counts over the range (powers the scene health panel). */
  eventTypeCounts(
    projectId: string,
    opts?: RangeOptions & SceneOptions,
  ): Promise<EventTypeCountRow[]>;
  /** Ordered session timeline for replay (gated by raw-session retention). */
  getSessionEvents(projectId: string, sessionId: string): Promise<AnyEvent[]>;
  /**
   * Streaming counterpart to {@link getSessionEvents}: yields events in `ts`
   * order without materializing the whole session, powering the NDJSON replay
   * response (ADR 0015). Gated by raw-session retention like the array form.
   */
  streamSessionEvents(projectId: string, sessionId: string): AsyncIterable<AnyEvent>;
  /** Coarse per-session descriptor (device/scene/user) from `session_start`. */
  getSessionMeta(projectId: string, sessionId: string): Promise<SessionMeta | null>;
  /** Register/replace a scene's proxy geometry in the spatial registry (ADR 0010/0014). */
  putSceneProxy(projectId: string, proxy: SceneProxy, label?: string): Promise<SceneRepresentation>;
  /** Fetch one scene representation (including the proxy blob), or `null`. */
  getSceneRepresentation(projectId: string, sceneId: string): Promise<SceneRepresentation | null>;
  /** List a project's scene representations (summaries, no proxy blobs). */
  listSceneRepresentations(projectId: string): Promise<SceneRepresentationSummary[]>;
  /** Release underlying connections. */
  close(): Promise<void>;
}
