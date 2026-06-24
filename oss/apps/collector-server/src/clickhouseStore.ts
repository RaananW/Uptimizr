import {
  buildCameraDirectionHeatmap,
  buildCameraDistance,
  buildCameraPositionHeatmap,
  buildClickGazeRay,
  buildDeadClicks,
  buildRageClicks,
  buildHoverDwell,
  buildCompileStalls,
  buildResourceSummary,
  buildCapabilityChanges,
  buildCameraGestures,
  buildDistinctScenes,
  buildEventTypeCounts,
  buildFlowHeatmap,
  buildListSessions,
  buildNavigationStats,
  buildXrRotationRate,
  buildXrSourceUsage,
  buildXrAbandonment,
  buildInteractionsBySource,
  buildMeshDwell,
  buildMeshInteractionKinds,
  buildPerfSummary,
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
  buildRenderScaleTruth,
  buildTimeseries,
  buildTopMeshes,
  buildWorldHeatmap,
  buildGazeHeatmap,
  clickhouseDialect,
  readDbSettings,
  type CameraDistanceBucketRow,
  type ClickGazeRayRow,
  type CoverageVoxelRow,
  type DeadClickRow,
  type RageClickRow,
  type HoverDwellRow,
  type CompileStallRow,
  type ResourceSummaryRow,
  type CapabilityChangeRow,
  type CameraGestureRow,
  type DirectionBinRow,
  type EventTypeCountRow,
  type FlowLinkRow,
  type HeatmapBinRow,
  type MeshCountRow,
  type MeshDwellRow,
  type MeshInteractionKindRow,
  type NavigationStatsRow,
  type XrRotationRateRow,
  type XrSourceUsageRow,
  type XrAbandonmentRow,
  type InteractionSourceRow,
  type PerfSummaryRow,
  type RenderScaleTruthRow,
  type AggregateTrajectoryPointRow,
  type PerfDistributionRow,
  type FpsHistogramRow,
  type FrameTimePercentileRow,
  type JankRateRow,
  type PerfByDeviceRow,
  type PerfBySceneRow,
  type ResourcePercentileRow,
  type StabilityCountRow,
  type PositionBinRow,
  type SceneRow,
  type SessionSummaryRow,
  type TimeseriesBucketRow,
  type TrajectoryPointRow,
  type WorldHeatmapBinRow,
} from "@uptimizr/db";
import {
  createClickhouseClient,
  migrateClickhouse,
  runClickhouseQuery,
  insertEvents as chInsertEvents,
  getSessionEvents as chGetSessionEvents,
  streamSessionEvents as chStreamSessionEvents,
  getSessionMeta as chGetSessionMeta,
  getProject as chGetProject,
  resolveApiKey as chResolveApiKey,
  upsertSceneProxy as chUpsertSceneProxy,
  getSceneRepresentation as chGetSceneRepresentation,
  listSceneRepresentations as chListSceneRepresentations,
  type ClickhouseClient,
} from "@uptimizr/db-clickhouse";
import type { CollectorStore } from "./store.js";

/**
 * Optional single-tenant ClickHouse store (ADR 0020): the scale path for
 * self-hosters who outgrow DuckDB's single read-write process. It carries the
 * **full** analytics surface — no stubbed aggregates — by rendering the same
 * dialect-agnostic builders with {@link clickhouseDialect} and executing them
 * over a ClickHouse server. Events live in the wide `events` table (plus the
 * dedicated `node_samples`); metadata (projects, API keys, scene registry) is
 * re-homed into the same database.
 *
 * The schema is migrated on creation (migrations are idempotent and forward-only),
 * so the store is usable out of the box once a ClickHouse server is reachable.
 * Connection settings come from `readDbSettings().clickhouse` (the `CLICKHOUSE_*`
 * env vars).
 */
export async function createClickhouseStore(): Promise<CollectorStore> {
  const settings = readDbSettings().clickhouse;
  const ch: ClickhouseClient = createClickhouseClient(settings);
  await migrateClickhouse(ch, settings);

  const d = clickhouseDialect;
  return {
    resolveApiKey: (key) => chResolveApiKey(ch, key),
    projectExists: async (projectId) => (await chGetProject(ch, projectId)) !== null,
    insertEvents: (events) => chInsertEvents(ch, [...events]),
    listSessions: (projectId, opts = {}) =>
      runClickhouseQuery<SessionSummaryRow>(ch, buildListSessions(projectId, opts, d)),
    pointerHeatmap: (projectId, opts = {}) =>
      runClickhouseQuery<HeatmapBinRow>(ch, buildPointerHeatmap(projectId, opts, d)),
    worldHeatmap: (projectId, opts = {}) =>
      runClickhouseQuery<WorldHeatmapBinRow>(ch, buildWorldHeatmap(projectId, opts, d)),
    gazeHeatmap: (projectId, opts = {}) =>
      runClickhouseQuery<WorldHeatmapBinRow>(ch, buildGazeHeatmap(projectId, opts, d)),
    cameraHeatmap: (projectId, opts = {}) =>
      runClickhouseQuery<DirectionBinRow>(ch, buildCameraDirectionHeatmap(projectId, opts, d)),
    cameraPositionHeatmap: (projectId, opts = {}) =>
      runClickhouseQuery<PositionBinRow>(ch, buildCameraPositionHeatmap(projectId, opts, d)),
    sessionTrajectory: (projectId, sessionId, opts = {}) =>
      runClickhouseQuery<TrajectoryPointRow>(
        ch,
        buildSessionTrajectory(projectId, { ...opts, session: sessionId }, d),
      ),
    aggregateTrajectories: (projectId, opts = {}) =>
      runClickhouseQuery<AggregateTrajectoryPointRow>(
        ch,
        buildAggregateTrajectories(projectId, opts, d),
      ),
    clickGazeRays: (projectId, opts = {}) =>
      runClickhouseQuery<ClickGazeRayRow>(ch, buildClickGazeRay(projectId, opts, d)),
    flowHeatmap: (projectId, opts = {}) =>
      runClickhouseQuery<FlowLinkRow>(ch, buildFlowHeatmap(projectId, opts, d)),
    topMeshes: (projectId, opts = {}) =>
      runClickhouseQuery<MeshCountRow>(ch, buildTopMeshes(projectId, opts, d)),
    meshDwell: (projectId, opts = {}) =>
      runClickhouseQuery<MeshDwellRow>(ch, buildMeshDwell(projectId, opts, d)),
    meshInteractionKinds: (projectId, opts = {}) =>
      runClickhouseQuery<MeshInteractionKindRow>(ch, buildMeshInteractionKinds(projectId, opts, d)),
    deadClicks: (projectId, opts = {}) =>
      runClickhouseQuery<DeadClickRow>(ch, buildDeadClicks(projectId, opts, d)),
    rageClicks: (projectId, opts = {}) =>
      runClickhouseQuery<RageClickRow>(ch, buildRageClicks(projectId, opts, d)),
    hoverDwell: (projectId, opts = {}) =>
      runClickhouseQuery<HoverDwellRow>(ch, buildHoverDwell(projectId, opts, d)),
    compileStalls: (projectId, opts = {}) =>
      runClickhouseQuery<CompileStallRow>(ch, buildCompileStalls(projectId, opts, d)),
    resourceSummary: (projectId, opts = {}) =>
      runClickhouseQuery<ResourceSummaryRow>(ch, buildResourceSummary(projectId, opts, d)),
    capabilityChanges: (projectId, opts = {}) =>
      runClickhouseQuery<CapabilityChangeRow>(ch, buildCapabilityChanges(projectId, opts, d)),
    cameraGestures: (projectId, opts = {}) =>
      runClickhouseQuery<CameraGestureRow>(ch, buildCameraGestures(projectId, opts, d)),
    perfSummary: (projectId, opts = {}) =>
      runClickhouseQuery<PerfSummaryRow>(ch, buildPerfSummary(projectId, opts, d)),
    renderScaleTruth: (projectId, opts = {}) =>
      runClickhouseQuery<RenderScaleTruthRow>(ch, buildRenderScaleTruth(projectId, opts, d)),
    perfDistribution: (projectId, opts = {}) =>
      runClickhouseQuery<PerfDistributionRow>(ch, buildPerfDistribution(projectId, opts, d)),
    fpsHistogram: (projectId, opts = {}) =>
      runClickhouseQuery<FpsHistogramRow>(ch, buildFpsHistogram(projectId, opts, d)),
    frameTimePercentiles: (projectId, opts = {}) =>
      runClickhouseQuery<FrameTimePercentileRow>(ch, buildFrameTimePercentiles(projectId, opts, d)),
    jankRate: (projectId, opts = {}) =>
      runClickhouseQuery<JankRateRow>(ch, buildJankRate(projectId, opts, d)),
    perfByDevice: (projectId, opts = {}) =>
      runClickhouseQuery<PerfByDeviceRow>(ch, buildPerfByDevice(projectId, opts, d)),
    perfByScene: (projectId, opts = {}) =>
      runClickhouseQuery<PerfBySceneRow>(ch, buildPerfByScene(projectId, opts, d)),
    resourcePercentiles: (projectId, opts = {}) =>
      runClickhouseQuery<ResourcePercentileRow>(ch, buildResourcePercentiles(projectId, opts, d)),
    stabilityCounts: (projectId, opts = {}) =>
      runClickhouseQuery<StabilityCountRow>(ch, buildStabilityCounts(projectId, opts, d)),
    sceneCoverage: (projectId, opts = {}) =>
      runClickhouseQuery<CoverageVoxelRow>(ch, buildSceneCoverage(projectId, opts, d)),
    cameraDistance: (projectId, opts = {}) =>
      runClickhouseQuery<CameraDistanceBucketRow>(ch, buildCameraDistance(projectId, opts, d)),
    navigationStats: (projectId, opts = {}) =>
      runClickhouseQuery<NavigationStatsRow>(ch, buildNavigationStats(projectId, opts, d)),
    xrRotationRate: (projectId, opts = {}) =>
      runClickhouseQuery<XrRotationRateRow>(ch, buildXrRotationRate(projectId, opts, d)),
    xrSourceUsage: (projectId, opts = {}) =>
      runClickhouseQuery<XrSourceUsageRow>(ch, buildXrSourceUsage(projectId, opts, d)),
    xrAbandonment: (projectId, opts = {}) =>
      runClickhouseQuery<XrAbandonmentRow>(ch, buildXrAbandonment(projectId, opts, d)),
    interactionsBySource: (projectId, opts = {}) =>
      runClickhouseQuery<InteractionSourceRow>(ch, buildInteractionsBySource(projectId, opts, d)),
    scenes: (projectId, opts = {}) =>
      runClickhouseQuery<SceneRow>(ch, buildDistinctScenes(projectId, opts, d)),
    timeseries: (projectId, opts = {}) =>
      runClickhouseQuery<TimeseriesBucketRow>(ch, buildTimeseries(projectId, opts, d)),
    eventTypeCounts: (projectId, opts = {}) =>
      runClickhouseQuery<EventTypeCountRow>(ch, buildEventTypeCounts(projectId, opts, d)),
    getSessionEvents: (projectId, sessionId) => chGetSessionEvents(ch, projectId, sessionId),
    streamSessionEvents: (projectId, sessionId) => chStreamSessionEvents(ch, projectId, sessionId),
    getSessionMeta: (projectId, sessionId) => chGetSessionMeta(ch, projectId, sessionId),
    putSceneProxy: (projectId, proxy, label) => chUpsertSceneProxy(ch, projectId, proxy, label),
    getSceneRepresentation: (projectId, sceneId) =>
      chGetSceneRepresentation(ch, projectId, sceneId),
    listSceneRepresentations: (projectId) => chListSceneRepresentations(ch, projectId),
    async close() {
      await ch.close();
    },
  };
}
