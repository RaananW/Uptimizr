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
  buildTrackingQuality,
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
  mssqlDialect,
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
  type TrackingQualityRow,
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
  createMssqlClient,
  ensureMssqlDatabase,
  migrateMssql,
  resolveMssqlConfig,
  runMssqlQuery,
  insertEvents as msInsertEvents,
  getSessionEvents as msGetSessionEvents,
  streamSessionEvents as msStreamSessionEvents,
  getSessionMeta as msGetSessionMeta,
  getProject as msGetProject,
  resolveApiKey as msResolveApiKey,
  upsertSceneProxy as msUpsertSceneProxy,
  getSceneRepresentation as msGetSceneRepresentation,
  listSceneRepresentations as msListSceneRepresentations,
  type MssqlClient,
} from "@uptimizr/db-mssql";
import type { CollectorStore } from "./store.js";

/**
 * Optional single-tenant Microsoft SQL Server store (ADR 0020, #85): the
 * relational, multi-writer path for self-hosters standardized on SQL Server /
 * Azure SQL who have outgrown DuckDB's single read-write process. It carries
 * the **full** analytics surface — no stubbed aggregates — by rendering the same
 * dialect-agnostic builders with {@link mssqlDialect} (vectors as JSON, ASOF
 * joins emulated via `CROSS`/`OUTER APPLY`, daily rollups recomputed at query
 * time) and executing them over a pooled `mssql` (tedious) connection. Events
 * live in the wide `events` table (plus the dedicated `node_samples`); metadata
 * (projects, API keys, scene registry) is re-homed into the same database.
 *
 * The database is created on first boot when the login may (`CREATE ANY
 * DATABASE`), and the schema is migrated on creation (migrations are
 * idempotent, forward-only and serialized behind an application lock, so
 * several collector instances can boot against one database). Connection
 * settings come from `readDbSettings().mssql` (`MSSQL_URL`, or `MSSQL_SERVER` /
 * `MSSQL_PORT` / `MSSQL_DATABASE` / `MSSQL_USER` / `MSSQL_PASSWORD` with
 * `MSSQL_ENCRYPT` / `MSSQL_TRUST_SERVER_CERTIFICATE`, plus `MSSQL_POOL_MAX`).
 */
export async function createMssqlStore(): Promise<CollectorStore> {
  const settings = readDbSettings().mssql;
  const database = resolveMssqlConfig(settings).database ?? settings.database;
  await ensureMssqlDatabase(settings, database);
  const msc: MssqlClient = createMssqlClient(settings);
  await migrateMssql(msc);

  const d = mssqlDialect;
  return {
    resolveApiKey: (key) => msResolveApiKey(msc, key),
    projectExists: async (projectId) => (await msGetProject(msc, projectId)) !== null,
    insertEvents: (events) => msInsertEvents(msc, [...events]),
    listSessions: (projectId, opts = {}) =>
      runMssqlQuery<SessionSummaryRow>(msc, buildListSessions(projectId, opts, d)),
    pointerHeatmap: (projectId, opts = {}) =>
      runMssqlQuery<HeatmapBinRow>(msc, buildPointerHeatmap(projectId, opts, d)),
    meshUvHeatmap: (projectId, opts = {}) =>
      runMssqlQuery<HeatmapBinRow>(msc, buildMeshUvHeatmap(projectId, opts, d)),
    worldHeatmap: (projectId, opts = {}) =>
      runMssqlQuery<WorldHeatmapBinRow>(msc, buildWorldHeatmap(projectId, opts, d)),
    worldHeatmapStats: async (projectId, opts = {}) => {
      const rows = await runMssqlQuery<SpatialStatsRow>(
        msc,
        buildWorldHeatmapStats(projectId, opts, d),
      );
      return rows[0] ?? { cells: 0, hits: 0 };
    },
    gazeHeatmap: (projectId, opts = {}) =>
      runMssqlQuery<WorldHeatmapBinRow>(msc, buildGazeHeatmap(projectId, opts, d)),
    gazeHeatmapStats: async (projectId, opts = {}) => {
      const rows = await runMssqlQuery<SpatialStatsRow>(
        msc,
        buildGazeHeatmapStats(projectId, opts, d),
      );
      return rows[0] ?? { cells: 0, hits: 0 };
    },
    cameraHeatmap: (projectId, opts = {}) =>
      runMssqlQuery<DirectionBinRow>(msc, buildCameraDirectionHeatmap(projectId, opts, d)),
    viewCoverageHistogram: (projectId, opts = {}) =>
      runMssqlQuery<ViewCoverageHistogramRow>(msc, buildViewCoverageHistogram(projectId, opts, d)),
    cameraPositionHeatmap: (projectId, opts = {}) =>
      runMssqlQuery<PositionBinRow>(msc, buildCameraPositionHeatmap(projectId, opts, d)),
    sessionTrajectory: (projectId, sessionId, opts = {}) =>
      runMssqlQuery<TrajectoryPointRow>(
        msc,
        buildSessionTrajectory(projectId, { ...opts, session: sessionId }, d),
      ),
    aggregateTrajectories: (projectId, opts = {}) =>
      runMssqlQuery<AggregateTrajectoryPointRow>(
        msc,
        buildAggregateTrajectories(projectId, opts, d),
      ),
    clickGazeRays: (projectId, opts = {}) =>
      runMssqlQuery<ClickGazeRayRow>(msc, buildClickGazeRay(projectId, opts, d)),
    flowHeatmap: (projectId, opts = {}) =>
      runMssqlQuery<FlowLinkRow>(msc, buildFlowHeatmap(projectId, opts, d)),
    topMeshes: (projectId, opts = {}) =>
      runMssqlQuery<MeshCountRow>(msc, buildTopMeshes(projectId, opts, d)),
    topMeshesBySource: (projectId, opts = {}) =>
      runMssqlQuery<MeshSourceCountRow>(msc, buildTopMeshesBySource(projectId, opts, d)),
    topMeshesTrend: (projectId, opts = {}) =>
      runMssqlQuery<MeshTrendPointRow>(msc, buildTopMeshesTrend(projectId, opts, d)),
    meshDwell: (projectId, opts = {}) =>
      runMssqlQuery<MeshDwellRow>(msc, buildMeshDwell(projectId, opts, d)),
    meshBlindSpots: (projectId, opts = {}) =>
      runMssqlQuery<MeshBlindSpotRow>(msc, buildMeshBlindSpots(projectId, opts, d)),
    meshInteractionKinds: (projectId, opts = {}) =>
      runMssqlQuery<MeshInteractionKindRow>(msc, buildMeshInteractionKinds(projectId, opts, d)),
    reachability: (projectId, opts = {}) =>
      runMssqlQuery<ReachabilityBinRow>(msc, buildReachability(projectId, opts, d)),
    deadClicks: (projectId, opts = {}) =>
      runMssqlQuery<DeadClickRow>(msc, buildDeadClicks(projectId, opts, d)),
    rageClicks: (projectId, opts = {}) =>
      runMssqlQuery<RageClickRow>(msc, buildRageClicks(projectId, opts, d)),
    hoverDwell: (projectId, opts = {}) =>
      runMssqlQuery<HoverDwellRow>(msc, buildHoverDwell(projectId, opts, d)),
    compileStalls: (projectId, opts = {}) =>
      runMssqlQuery<CompileStallRow>(msc, buildCompileStalls(projectId, opts, d)),
    arPlacementTimeToPlace: (projectId, opts = {}) =>
      runMssqlQuery<ArPlacementTimeToPlaceRow>(
        msc,
        buildArPlacementTimeToPlace(projectId, opts, d),
      ),
    arPlacementAttempts: (projectId, opts = {}) =>
      runMssqlQuery<ArPlacementAttemptsRow>(msc, buildArPlacementAttempts(projectId, opts, d)),
    arPlacementSurfaces: (projectId, opts = {}) =>
      runMssqlQuery<ArPlacementSurfaceRow>(msc, buildArPlacementSurfaces(projectId, opts, d)),
    resourceSummary: (projectId, opts = {}) =>
      runMssqlQuery<ResourceSummaryRow>(msc, buildResourceSummary(projectId, opts, d)),
    capabilityChanges: (projectId, opts = {}) =>
      runMssqlQuery<CapabilityChangeRow>(msc, buildCapabilityChanges(projectId, opts, d)),
    cameraGestures: (projectId, opts = {}) =>
      runMssqlQuery<CameraGestureRow>(msc, buildCameraGestures(projectId, opts, d)),
    perfSummary: (projectId, opts = {}) =>
      runMssqlQuery<PerfSummaryRow>(msc, buildPerfSummary(projectId, opts, d)),
    renderScaleTruth: (projectId, opts = {}) =>
      runMssqlQuery<RenderScaleTruthRow>(msc, buildRenderScaleTruth(projectId, opts, d)),
    perfDistribution: (projectId, opts = {}) =>
      runMssqlQuery<PerfDistributionRow>(msc, buildPerfDistribution(projectId, opts, d)),
    fpsHistogram: (projectId, opts = {}) =>
      runMssqlQuery<FpsHistogramRow>(msc, buildFpsHistogram(projectId, opts, d)),
    frameTimePercentiles: (projectId, opts = {}) =>
      runMssqlQuery<FrameTimePercentileRow>(msc, buildFrameTimePercentiles(projectId, opts, d)),
    jankRate: (projectId, opts = {}) =>
      runMssqlQuery<JankRateRow>(msc, buildJankRate(projectId, opts, d)),
    perfChurn: (projectId, opts = {}) =>
      runMssqlQuery<PerfChurnRow>(msc, buildPerfChurn(projectId, opts, d)),
    perfByDevice: (projectId, opts = {}) =>
      runMssqlQuery<PerfByDeviceRow>(msc, buildPerfByDevice(projectId, opts, d)),
    perfByScene: (projectId, opts = {}) =>
      runMssqlQuery<PerfBySceneRow>(msc, buildPerfByScene(projectId, opts, d)),
    resourcePercentiles: (projectId, opts = {}) =>
      runMssqlQuery<ResourcePercentileRow>(msc, buildResourcePercentiles(projectId, opts, d)),
    stabilityCounts: (projectId, opts = {}) =>
      runMssqlQuery<StabilityCountRow>(msc, buildStabilityCounts(projectId, opts, d)),
    graphicsDiagnosticCounts: (projectId, opts = {}) =>
      runMssqlQuery<GraphicsDiagnosticCountRow>(
        msc,
        buildGraphicsDiagnosticCounts(projectId, opts, d),
      ),
    errorHeatmap: (projectId, opts = {}) =>
      runMssqlQuery<WorldHeatmapBinRow>(msc, buildErrorHeatmap(projectId, opts, d)),
    boundaryHeatmap: (projectId, opts = {}) =>
      runMssqlQuery<WorldHeatmapBinRow>(msc, buildBoundaryHeatmap(projectId, opts, d)),
    boundaryHeatmapStats: async (projectId, opts = {}) => {
      const rows = await runMssqlQuery<SpatialStatsRow>(
        msc,
        buildBoundaryHeatmapStats(projectId, opts, d),
      );
      return rows[0] ?? { cells: 0, hits: 0 };
    },
    renderingTechnology: (projectId, opts = {}) =>
      runMssqlQuery<RenderingTechnologyRow>(msc, buildRenderingTechnology(projectId, opts, d)),
    sceneCoverage: (projectId, opts = {}) =>
      runMssqlQuery<CoverageVoxelRow>(msc, buildSceneCoverage(projectId, opts, d)),
    perfHeatmap: (projectId, opts = {}) =>
      runMssqlQuery<PerfHeatmapVoxelRow>(msc, buildPerfHeatmap(projectId, opts, d)),
    cameraDistance: (projectId, opts = {}) =>
      runMssqlQuery<CameraDistanceBucketRow>(msc, buildCameraDistance(projectId, opts, d)),
    navigationStats: (projectId, opts = {}) =>
      runMssqlQuery<NavigationStatsRow>(msc, buildNavigationStats(projectId, opts, d)),
    backtrackRatio: (projectId, opts = {}) =>
      runMssqlQuery<BacktrackRatioRow>(msc, buildBacktrackRatio(projectId, opts, d)),
    xrRotationRate: (projectId, opts = {}) =>
      runMssqlQuery<XrRotationRateRow>(msc, buildXrRotationRate(projectId, opts, d)),
    xrSourceUsage: (projectId, opts = {}) =>
      runMssqlQuery<XrSourceUsageRow>(msc, buildXrSourceUsage(projectId, opts, d)),
    xrAbandonment: (projectId, opts = {}) =>
      runMssqlQuery<XrAbandonmentRow>(msc, buildXrAbandonment(projectId, opts, d)),
    xrLocomotion: (projectId, opts = {}) =>
      runMssqlQuery<XrLocomotionRow>(msc, buildXrLocomotionComfort(projectId, opts, d)),
    boundaryContacts: (projectId, opts = {}) =>
      runMssqlQuery<BoundaryContactsRow>(msc, buildBoundaryContacts(projectId, opts, d)),
    trackingQuality: (projectId, opts = {}) =>
      runMssqlQuery<TrackingQualityRow>(msc, buildTrackingQuality(projectId, opts, d)),
    interactionsBySource: (projectId, opts = {}) =>
      runMssqlQuery<InteractionSourceRow>(msc, buildInteractionsBySource(projectId, opts, d)),
    topInputActions: (projectId, opts = {}) =>
      runMssqlQuery<InputActionCountRow>(msc, buildTopInputActions(projectId, opts, d)),
    scenes: (projectId, opts = {}) =>
      runMssqlQuery<SceneRow>(msc, buildDistinctScenes(projectId, opts, d)),
    timeseries: (projectId, opts = {}) =>
      runMssqlQuery<TimeseriesBucketRow>(msc, buildTimeseries(projectId, opts, d)),
    eventTypeCounts: (projectId, opts = {}) =>
      runMssqlQuery<EventTypeCountRow>(msc, buildEventTypeCounts(projectId, opts, d)),
    funnel: (projectId, opts) =>
      runMssqlQuery<FunnelStepResultRow>(msc, buildFunnel(projectId, opts, d)),
    sceneRetention: (projectId, opts) =>
      runMssqlQuery<SceneRetentionRow>(msc, buildSceneRetention(projectId, opts, d)),
    loadBounceFunnel: (projectId, opts = {}) =>
      runMssqlQuery<LoadBounceBandRow>(msc, buildLoadBounceFunnel(projectId, opts, d)),
    variantLeaderboard: (projectId, opts) =>
      runMssqlQuery<VariantLeaderboardRow>(msc, buildVariantLeaderboard(projectId, opts, d)),
    getSessionEvents: (projectId, sessionId) => msGetSessionEvents(msc, projectId, sessionId),
    streamSessionEvents: (projectId, sessionId) => msStreamSessionEvents(msc, projectId, sessionId),
    getSessionMeta: (projectId, sessionId) => msGetSessionMeta(msc, projectId, sessionId),
    putSceneProxy: (projectId, proxy, label) => msUpsertSceneProxy(msc, projectId, proxy, label),
    getSceneRepresentation: (projectId, sceneId) =>
      msGetSceneRepresentation(msc, projectId, sceneId),
    listSceneRepresentations: (projectId) => msListSceneRepresentations(msc, projectId),
    async close() {
      await msc.close();
    },
  };
}
