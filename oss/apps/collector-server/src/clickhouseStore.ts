import {
  buildCameraDirectionHeatmap,
  buildViewCoverageHistogram,
  buildCameraDistance,
  buildCameraPositionHeatmap,
  buildClickGazeRay,
  buildDeadClicks,
  buildRageClicks,
  buildHoverDwell,
  buildCompileStalls,
  buildArPlacementTimeToPlace,
  buildArPlacementAttempts,
  buildArPlacementSurfaces,
  buildResourceSummary,
  buildCapabilityChanges,
  buildCameraGestures,
  buildDistinctScenes,
  buildEventTypeCounts,
  buildFlowHeatmap,
  buildFunnel,
  buildSceneRetention,
  buildLoadBounceFunnel,
  buildVariantLeaderboard,
  buildListSessions,
  buildNavigationStats,
  buildBacktrackRatio,
  buildXrRotationRate,
  buildXrSourceUsage,
  buildXrAbandonment,
  buildXrLocomotionComfort,
  buildInteractionsBySource,
  buildMeshDwell,
  buildMeshBlindSpots,
  buildMeshInteractionKinds,
  buildReachability,
  buildPerfSummary,
  buildPerfDistribution,
  buildFpsHistogram,
  buildFrameTimePercentiles,
  buildJankRate,
  buildPerfChurn,
  buildPerfByDevice,
  buildPerfByScene,
  buildResourcePercentiles,
  buildStabilityCounts,
  buildGraphicsDiagnosticCounts,
  buildErrorHeatmap,
  buildBoundaryHeatmap,
  buildBoundaryHeatmapStats,
  buildBoundaryContacts,
  buildRenderingTechnology,
  buildPointerHeatmap,
  buildMeshUvHeatmap,
  buildSceneCoverage,
  buildPerfHeatmap,
  buildSessionTrajectory,
  buildAggregateTrajectories,
  buildRenderScaleTruth,
  buildTimeseries,
  buildTopMeshes,
  buildTopMeshesBySource,
  buildTopMeshesTrend,
  buildTopInputActions,
  buildWorldHeatmap,
  buildWorldHeatmapStats,
  buildGazeHeatmap,
  buildGazeHeatmapStats,
  clickhouseDialect,
  readDbSettings,
  type CameraDistanceBucketRow,
  type ClickGazeRayRow,
  type CoverageVoxelRow,
  type PerfHeatmapVoxelRow,
  type DeadClickRow,
  type RageClickRow,
  type HoverDwellRow,
  type CompileStallRow,
  type ArPlacementTimeToPlaceRow,
  type ArPlacementAttemptsRow,
  type ArPlacementSurfaceRow,
  type ResourceSummaryRow,
  type CapabilityChangeRow,
  type CameraGestureRow,
  type DirectionBinRow,
  type ViewCoverageHistogramRow,
  type EventTypeCountRow,
  type FlowLinkRow,
  type FunnelStepResultRow,
  type SceneRetentionRow,
  type LoadBounceBandRow,
  type VariantLeaderboardRow,
  type HeatmapBinRow,
  type MeshCountRow,
  type MeshDwellRow,
  type MeshBlindSpotRow,
  type MeshInteractionKindRow,
  type ReachabilityBinRow,
  type MeshSourceCountRow,
  type MeshTrendPointRow,
  type InputActionCountRow,
  type NavigationStatsRow,
  type BacktrackRatioRow,
  type XrRotationRateRow,
  type XrSourceUsageRow,
  type XrAbandonmentRow,
  type XrLocomotionRow,
  type BoundaryContactsRow,
  type InteractionSourceRow,
  type PerfSummaryRow,
  type RenderScaleTruthRow,
  type AggregateTrajectoryPointRow,
  type PerfDistributionRow,
  type FpsHistogramRow,
  type FrameTimePercentileRow,
  type JankRateRow,
  type PerfChurnRow,
  type PerfByDeviceRow,
  type PerfBySceneRow,
  type ResourcePercentileRow,
  type StabilityCountRow,
  type GraphicsDiagnosticCountRow,
  type RenderingTechnologyRow,
  type PositionBinRow,
  type SceneRow,
  type SessionSummaryRow,
  type SpatialStatsRow,
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
    meshUvHeatmap: (projectId, opts = {}) =>
      runClickhouseQuery<HeatmapBinRow>(ch, buildMeshUvHeatmap(projectId, opts, d)),
    worldHeatmap: (projectId, opts = {}) =>
      runClickhouseQuery<WorldHeatmapBinRow>(ch, buildWorldHeatmap(projectId, opts, d)),
    worldHeatmapStats: async (projectId, opts = {}) => {
      const rows = await runClickhouseQuery<SpatialStatsRow>(
        ch,
        buildWorldHeatmapStats(projectId, opts, d),
      );
      return rows[0] ?? { cells: 0, hits: 0 };
    },
    gazeHeatmap: (projectId, opts = {}) =>
      runClickhouseQuery<WorldHeatmapBinRow>(ch, buildGazeHeatmap(projectId, opts, d)),
    gazeHeatmapStats: async (projectId, opts = {}) => {
      const rows = await runClickhouseQuery<SpatialStatsRow>(
        ch,
        buildGazeHeatmapStats(projectId, opts, d),
      );
      return rows[0] ?? { cells: 0, hits: 0 };
    },
    cameraHeatmap: (projectId, opts = {}) =>
      runClickhouseQuery<DirectionBinRow>(ch, buildCameraDirectionHeatmap(projectId, opts, d)),
    viewCoverageHistogram: (projectId, opts = {}) =>
      runClickhouseQuery<ViewCoverageHistogramRow>(
        ch,
        buildViewCoverageHistogram(projectId, opts, d),
      ),
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
    topMeshesBySource: (projectId, opts = {}) =>
      runClickhouseQuery<MeshSourceCountRow>(ch, buildTopMeshesBySource(projectId, opts, d)),
    topMeshesTrend: (projectId, opts = {}) =>
      runClickhouseQuery<MeshTrendPointRow>(ch, buildTopMeshesTrend(projectId, opts, d)),
    meshDwell: (projectId, opts = {}) =>
      runClickhouseQuery<MeshDwellRow>(ch, buildMeshDwell(projectId, opts, d)),
    meshBlindSpots: (projectId, opts = {}) =>
      runClickhouseQuery<MeshBlindSpotRow>(ch, buildMeshBlindSpots(projectId, opts, d)),
    meshInteractionKinds: (projectId, opts = {}) =>
      runClickhouseQuery<MeshInteractionKindRow>(ch, buildMeshInteractionKinds(projectId, opts, d)),
    reachability: (projectId, opts = {}) =>
      runClickhouseQuery<ReachabilityBinRow>(ch, buildReachability(projectId, opts, d)),
    deadClicks: (projectId, opts = {}) =>
      runClickhouseQuery<DeadClickRow>(ch, buildDeadClicks(projectId, opts, d)),
    rageClicks: (projectId, opts = {}) =>
      runClickhouseQuery<RageClickRow>(ch, buildRageClicks(projectId, opts, d)),
    hoverDwell: (projectId, opts = {}) =>
      runClickhouseQuery<HoverDwellRow>(ch, buildHoverDwell(projectId, opts, d)),
    compileStalls: (projectId, opts = {}) =>
      runClickhouseQuery<CompileStallRow>(ch, buildCompileStalls(projectId, opts, d)),
    arPlacementTimeToPlace: (projectId, opts = {}) =>
      runClickhouseQuery<ArPlacementTimeToPlaceRow>(
        ch,
        buildArPlacementTimeToPlace(projectId, opts, d),
      ),
    arPlacementAttempts: (projectId, opts = {}) =>
      runClickhouseQuery<ArPlacementAttemptsRow>(ch, buildArPlacementAttempts(projectId, opts, d)),
    arPlacementSurfaces: (projectId, opts = {}) =>
      runClickhouseQuery<ArPlacementSurfaceRow>(ch, buildArPlacementSurfaces(projectId, opts, d)),
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
    perfChurn: (projectId, opts = {}) =>
      runClickhouseQuery<PerfChurnRow>(ch, buildPerfChurn(projectId, opts, d)),
    perfByDevice: (projectId, opts = {}) =>
      runClickhouseQuery<PerfByDeviceRow>(ch, buildPerfByDevice(projectId, opts, d)),
    perfByScene: (projectId, opts = {}) =>
      runClickhouseQuery<PerfBySceneRow>(ch, buildPerfByScene(projectId, opts, d)),
    resourcePercentiles: (projectId, opts = {}) =>
      runClickhouseQuery<ResourcePercentileRow>(ch, buildResourcePercentiles(projectId, opts, d)),
    stabilityCounts: (projectId, opts = {}) =>
      runClickhouseQuery<StabilityCountRow>(ch, buildStabilityCounts(projectId, opts, d)),
    graphicsDiagnosticCounts: (projectId, opts = {}) =>
      runClickhouseQuery<GraphicsDiagnosticCountRow>(
        ch,
        buildGraphicsDiagnosticCounts(projectId, opts, d),
      ),
    errorHeatmap: (projectId, opts = {}) =>
      runClickhouseQuery<WorldHeatmapBinRow>(ch, buildErrorHeatmap(projectId, opts, d)),
    boundaryHeatmap: (projectId, opts = {}) =>
      runClickhouseQuery<WorldHeatmapBinRow>(ch, buildBoundaryHeatmap(projectId, opts, d)),
    boundaryHeatmapStats: async (projectId, opts = {}) => {
      const rows = await runClickhouseQuery<SpatialStatsRow>(
        ch,
        buildBoundaryHeatmapStats(projectId, opts, d),
      );
      return rows[0] ?? { cells: 0, hits: 0 };
    },
    renderingTechnology: (projectId, opts = {}) =>
      runClickhouseQuery<RenderingTechnologyRow>(ch, buildRenderingTechnology(projectId, opts, d)),
    sceneCoverage: (projectId, opts = {}) =>
      runClickhouseQuery<CoverageVoxelRow>(ch, buildSceneCoverage(projectId, opts, d)),
    perfHeatmap: (projectId, opts = {}) =>
      runClickhouseQuery<PerfHeatmapVoxelRow>(ch, buildPerfHeatmap(projectId, opts, d)),
    cameraDistance: (projectId, opts = {}) =>
      runClickhouseQuery<CameraDistanceBucketRow>(ch, buildCameraDistance(projectId, opts, d)),
    navigationStats: (projectId, opts = {}) =>
      runClickhouseQuery<NavigationStatsRow>(ch, buildNavigationStats(projectId, opts, d)),
    backtrackRatio: (projectId, opts = {}) =>
      runClickhouseQuery<BacktrackRatioRow>(ch, buildBacktrackRatio(projectId, opts, d)),
    xrRotationRate: (projectId, opts = {}) =>
      runClickhouseQuery<XrRotationRateRow>(ch, buildXrRotationRate(projectId, opts, d)),
    xrSourceUsage: (projectId, opts = {}) =>
      runClickhouseQuery<XrSourceUsageRow>(ch, buildXrSourceUsage(projectId, opts, d)),
    xrAbandonment: (projectId, opts = {}) =>
      runClickhouseQuery<XrAbandonmentRow>(ch, buildXrAbandonment(projectId, opts, d)),
    xrLocomotion: (projectId, opts = {}) =>
      runClickhouseQuery<XrLocomotionRow>(ch, buildXrLocomotionComfort(projectId, opts, d)),
    boundaryContacts: (projectId, opts = {}) =>
      runClickhouseQuery<BoundaryContactsRow>(ch, buildBoundaryContacts(projectId, opts, d)),
    interactionsBySource: (projectId, opts = {}) =>
      runClickhouseQuery<InteractionSourceRow>(ch, buildInteractionsBySource(projectId, opts, d)),
    topInputActions: (projectId, opts = {}) =>
      runClickhouseQuery<InputActionCountRow>(ch, buildTopInputActions(projectId, opts, d)),
    scenes: (projectId, opts = {}) =>
      runClickhouseQuery<SceneRow>(ch, buildDistinctScenes(projectId, opts, d)),
    timeseries: (projectId, opts = {}) =>
      runClickhouseQuery<TimeseriesBucketRow>(ch, buildTimeseries(projectId, opts, d)),
    eventTypeCounts: (projectId, opts = {}) =>
      runClickhouseQuery<EventTypeCountRow>(ch, buildEventTypeCounts(projectId, opts, d)),
    funnel: (projectId, opts) =>
      runClickhouseQuery<FunnelStepResultRow>(ch, buildFunnel(projectId, opts, d)),
    sceneRetention: (projectId, opts) =>
      runClickhouseQuery<SceneRetentionRow>(ch, buildSceneRetention(projectId, opts, d)),
    loadBounceFunnel: (projectId, opts = {}) =>
      runClickhouseQuery<LoadBounceBandRow>(ch, buildLoadBounceFunnel(projectId, opts, d)),
    variantLeaderboard: (projectId, opts) =>
      runClickhouseQuery<VariantLeaderboardRow>(ch, buildVariantLeaderboard(projectId, opts, d)),
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
