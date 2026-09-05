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
  postgresDialect,
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
  createPostgresClient,
  migratePostgres,
  runPostgresQuery,
  insertEvents as pgInsertEvents,
  getSessionEvents as pgGetSessionEvents,
  streamSessionEvents as pgStreamSessionEvents,
  getSessionMeta as pgGetSessionMeta,
  getProject as pgGetProject,
  resolveApiKey as pgResolveApiKey,
  upsertSceneProxy as pgUpsertSceneProxy,
  getSceneRepresentation as pgGetSceneRepresentation,
  listSceneRepresentations as pgListSceneRepresentations,
  type PostgresClient,
} from "@uptimizr/db-postgres";
import type { CollectorStore } from "./store.js";

/**
 * Optional single-tenant Postgres store (ADR 0020, #84): the relational,
 * multi-writer path for self-hosters who already run Postgres and have
 * outgrown DuckDB's single read-write process. It carries the **full** analytics
 * surface — no stubbed aggregates — by rendering the same dialect-agnostic
 * builders with {@link postgresDialect} (ASOF joins emulated via `LATERAL`,
 * daily rollups recomputed at query time) and executing them over a pooled
 * `pg` connection. Events live in the wide `events` table (plus the dedicated
 * `node_samples`); metadata (projects, API keys, scene registry) is re-homed
 * into the same database.
 *
 * The schema is migrated on creation (migrations are idempotent, forward-only
 * and serialized behind an advisory lock, so several collector instances can
 * boot against one database). Connection settings come from
 * `readDbSettings().postgres` (`POSTGRES_URL` / `DATABASE_URL`, `POSTGRES_SCHEMA`,
 * `POSTGRES_POOL_MAX`).
 */
export async function createPostgresStore(): Promise<CollectorStore> {
  const settings = readDbSettings().postgres;
  const pgc: PostgresClient = createPostgresClient(settings);
  await migratePostgres(pgc, settings);

  const d = postgresDialect;
  return {
    resolveApiKey: (key) => pgResolveApiKey(pgc, key),
    projectExists: async (projectId) => (await pgGetProject(pgc, projectId)) !== null,
    insertEvents: (events) => pgInsertEvents(pgc, [...events]),
    listSessions: (projectId, opts = {}) =>
      runPostgresQuery<SessionSummaryRow>(pgc, buildListSessions(projectId, opts, d)),
    pointerHeatmap: (projectId, opts = {}) =>
      runPostgresQuery<HeatmapBinRow>(pgc, buildPointerHeatmap(projectId, opts, d)),
    meshUvHeatmap: (projectId, opts = {}) =>
      runPostgresQuery<HeatmapBinRow>(pgc, buildMeshUvHeatmap(projectId, opts, d)),
    worldHeatmap: (projectId, opts = {}) =>
      runPostgresQuery<WorldHeatmapBinRow>(pgc, buildWorldHeatmap(projectId, opts, d)),
    worldHeatmapStats: async (projectId, opts = {}) => {
      const rows = await runPostgresQuery<SpatialStatsRow>(
        pgc,
        buildWorldHeatmapStats(projectId, opts, d),
      );
      return rows[0] ?? { cells: 0, hits: 0 };
    },
    gazeHeatmap: (projectId, opts = {}) =>
      runPostgresQuery<WorldHeatmapBinRow>(pgc, buildGazeHeatmap(projectId, opts, d)),
    gazeHeatmapStats: async (projectId, opts = {}) => {
      const rows = await runPostgresQuery<SpatialStatsRow>(
        pgc,
        buildGazeHeatmapStats(projectId, opts, d),
      );
      return rows[0] ?? { cells: 0, hits: 0 };
    },
    cameraHeatmap: (projectId, opts = {}) =>
      runPostgresQuery<DirectionBinRow>(pgc, buildCameraDirectionHeatmap(projectId, opts, d)),
    viewCoverageHistogram: (projectId, opts = {}) =>
      runPostgresQuery<ViewCoverageHistogramRow>(
        pgc,
        buildViewCoverageHistogram(projectId, opts, d),
      ),
    cameraPositionHeatmap: (projectId, opts = {}) =>
      runPostgresQuery<PositionBinRow>(pgc, buildCameraPositionHeatmap(projectId, opts, d)),
    sessionTrajectory: (projectId, sessionId, opts = {}) =>
      runPostgresQuery<TrajectoryPointRow>(
        pgc,
        buildSessionTrajectory(projectId, { ...opts, session: sessionId }, d),
      ),
    aggregateTrajectories: (projectId, opts = {}) =>
      runPostgresQuery<AggregateTrajectoryPointRow>(
        pgc,
        buildAggregateTrajectories(projectId, opts, d),
      ),
    clickGazeRays: (projectId, opts = {}) =>
      runPostgresQuery<ClickGazeRayRow>(pgc, buildClickGazeRay(projectId, opts, d)),
    flowHeatmap: (projectId, opts = {}) =>
      runPostgresQuery<FlowLinkRow>(pgc, buildFlowHeatmap(projectId, opts, d)),
    topMeshes: (projectId, opts = {}) =>
      runPostgresQuery<MeshCountRow>(pgc, buildTopMeshes(projectId, opts, d)),
    topMeshesBySource: (projectId, opts = {}) =>
      runPostgresQuery<MeshSourceCountRow>(pgc, buildTopMeshesBySource(projectId, opts, d)),
    topMeshesTrend: (projectId, opts = {}) =>
      runPostgresQuery<MeshTrendPointRow>(pgc, buildTopMeshesTrend(projectId, opts, d)),
    meshDwell: (projectId, opts = {}) =>
      runPostgresQuery<MeshDwellRow>(pgc, buildMeshDwell(projectId, opts, d)),
    meshBlindSpots: (projectId, opts = {}) =>
      runPostgresQuery<MeshBlindSpotRow>(pgc, buildMeshBlindSpots(projectId, opts, d)),
    meshInteractionKinds: (projectId, opts = {}) =>
      runPostgresQuery<MeshInteractionKindRow>(pgc, buildMeshInteractionKinds(projectId, opts, d)),
    reachability: (projectId, opts = {}) =>
      runPostgresQuery<ReachabilityBinRow>(pgc, buildReachability(projectId, opts, d)),
    deadClicks: (projectId, opts = {}) =>
      runPostgresQuery<DeadClickRow>(pgc, buildDeadClicks(projectId, opts, d)),
    rageClicks: (projectId, opts = {}) =>
      runPostgresQuery<RageClickRow>(pgc, buildRageClicks(projectId, opts, d)),
    hoverDwell: (projectId, opts = {}) =>
      runPostgresQuery<HoverDwellRow>(pgc, buildHoverDwell(projectId, opts, d)),
    compileStalls: (projectId, opts = {}) =>
      runPostgresQuery<CompileStallRow>(pgc, buildCompileStalls(projectId, opts, d)),
    arPlacementTimeToPlace: (projectId, opts = {}) =>
      runPostgresQuery<ArPlacementTimeToPlaceRow>(
        pgc,
        buildArPlacementTimeToPlace(projectId, opts, d),
      ),
    arPlacementAttempts: (projectId, opts = {}) =>
      runPostgresQuery<ArPlacementAttemptsRow>(pgc, buildArPlacementAttempts(projectId, opts, d)),
    arPlacementSurfaces: (projectId, opts = {}) =>
      runPostgresQuery<ArPlacementSurfaceRow>(pgc, buildArPlacementSurfaces(projectId, opts, d)),
    resourceSummary: (projectId, opts = {}) =>
      runPostgresQuery<ResourceSummaryRow>(pgc, buildResourceSummary(projectId, opts, d)),
    capabilityChanges: (projectId, opts = {}) =>
      runPostgresQuery<CapabilityChangeRow>(pgc, buildCapabilityChanges(projectId, opts, d)),
    cameraGestures: (projectId, opts = {}) =>
      runPostgresQuery<CameraGestureRow>(pgc, buildCameraGestures(projectId, opts, d)),
    perfSummary: (projectId, opts = {}) =>
      runPostgresQuery<PerfSummaryRow>(pgc, buildPerfSummary(projectId, opts, d)),
    renderScaleTruth: (projectId, opts = {}) =>
      runPostgresQuery<RenderScaleTruthRow>(pgc, buildRenderScaleTruth(projectId, opts, d)),
    perfDistribution: (projectId, opts = {}) =>
      runPostgresQuery<PerfDistributionRow>(pgc, buildPerfDistribution(projectId, opts, d)),
    fpsHistogram: (projectId, opts = {}) =>
      runPostgresQuery<FpsHistogramRow>(pgc, buildFpsHistogram(projectId, opts, d)),
    frameTimePercentiles: (projectId, opts = {}) =>
      runPostgresQuery<FrameTimePercentileRow>(pgc, buildFrameTimePercentiles(projectId, opts, d)),
    jankRate: (projectId, opts = {}) =>
      runPostgresQuery<JankRateRow>(pgc, buildJankRate(projectId, opts, d)),
    perfChurn: (projectId, opts = {}) =>
      runPostgresQuery<PerfChurnRow>(pgc, buildPerfChurn(projectId, opts, d)),
    perfByDevice: (projectId, opts = {}) =>
      runPostgresQuery<PerfByDeviceRow>(pgc, buildPerfByDevice(projectId, opts, d)),
    perfByScene: (projectId, opts = {}) =>
      runPostgresQuery<PerfBySceneRow>(pgc, buildPerfByScene(projectId, opts, d)),
    resourcePercentiles: (projectId, opts = {}) =>
      runPostgresQuery<ResourcePercentileRow>(pgc, buildResourcePercentiles(projectId, opts, d)),
    stabilityCounts: (projectId, opts = {}) =>
      runPostgresQuery<StabilityCountRow>(pgc, buildStabilityCounts(projectId, opts, d)),
    graphicsDiagnosticCounts: (projectId, opts = {}) =>
      runPostgresQuery<GraphicsDiagnosticCountRow>(
        pgc,
        buildGraphicsDiagnosticCounts(projectId, opts, d),
      ),
    errorHeatmap: (projectId, opts = {}) =>
      runPostgresQuery<WorldHeatmapBinRow>(pgc, buildErrorHeatmap(projectId, opts, d)),
    boundaryHeatmap: (projectId, opts = {}) =>
      runPostgresQuery<WorldHeatmapBinRow>(pgc, buildBoundaryHeatmap(projectId, opts, d)),
    boundaryHeatmapStats: async (projectId, opts = {}) => {
      const rows = await runPostgresQuery<SpatialStatsRow>(
        pgc,
        buildBoundaryHeatmapStats(projectId, opts, d),
      );
      return rows[0] ?? { cells: 0, hits: 0 };
    },
    renderingTechnology: (projectId, opts = {}) =>
      runPostgresQuery<RenderingTechnologyRow>(pgc, buildRenderingTechnology(projectId, opts, d)),
    sceneCoverage: (projectId, opts = {}) =>
      runPostgresQuery<CoverageVoxelRow>(pgc, buildSceneCoverage(projectId, opts, d)),
    perfHeatmap: (projectId, opts = {}) =>
      runPostgresQuery<PerfHeatmapVoxelRow>(pgc, buildPerfHeatmap(projectId, opts, d)),
    cameraDistance: (projectId, opts = {}) =>
      runPostgresQuery<CameraDistanceBucketRow>(pgc, buildCameraDistance(projectId, opts, d)),
    navigationStats: (projectId, opts = {}) =>
      runPostgresQuery<NavigationStatsRow>(pgc, buildNavigationStats(projectId, opts, d)),
    backtrackRatio: (projectId, opts = {}) =>
      runPostgresQuery<BacktrackRatioRow>(pgc, buildBacktrackRatio(projectId, opts, d)),
    xrRotationRate: (projectId, opts = {}) =>
      runPostgresQuery<XrRotationRateRow>(pgc, buildXrRotationRate(projectId, opts, d)),
    xrSourceUsage: (projectId, opts = {}) =>
      runPostgresQuery<XrSourceUsageRow>(pgc, buildXrSourceUsage(projectId, opts, d)),
    xrAbandonment: (projectId, opts = {}) =>
      runPostgresQuery<XrAbandonmentRow>(pgc, buildXrAbandonment(projectId, opts, d)),
    xrLocomotion: (projectId, opts = {}) =>
      runPostgresQuery<XrLocomotionRow>(pgc, buildXrLocomotionComfort(projectId, opts, d)),
    boundaryContacts: (projectId, opts = {}) =>
      runPostgresQuery<BoundaryContactsRow>(pgc, buildBoundaryContacts(projectId, opts, d)),
    trackingQuality: (projectId, opts = {}) =>
      runPostgresQuery<TrackingQualityRow>(pgc, buildTrackingQuality(projectId, opts, d)),
    interactionsBySource: (projectId, opts = {}) =>
      runPostgresQuery<InteractionSourceRow>(pgc, buildInteractionsBySource(projectId, opts, d)),
    topInputActions: (projectId, opts = {}) =>
      runPostgresQuery<InputActionCountRow>(pgc, buildTopInputActions(projectId, opts, d)),
    scenes: (projectId, opts = {}) =>
      runPostgresQuery<SceneRow>(pgc, buildDistinctScenes(projectId, opts, d)),
    timeseries: (projectId, opts = {}) =>
      runPostgresQuery<TimeseriesBucketRow>(pgc, buildTimeseries(projectId, opts, d)),
    eventTypeCounts: (projectId, opts = {}) =>
      runPostgresQuery<EventTypeCountRow>(pgc, buildEventTypeCounts(projectId, opts, d)),
    funnel: (projectId, opts) =>
      runPostgresQuery<FunnelStepResultRow>(pgc, buildFunnel(projectId, opts, d)),
    sceneRetention: (projectId, opts) =>
      runPostgresQuery<SceneRetentionRow>(pgc, buildSceneRetention(projectId, opts, d)),
    loadBounceFunnel: (projectId, opts = {}) =>
      runPostgresQuery<LoadBounceBandRow>(pgc, buildLoadBounceFunnel(projectId, opts, d)),
    variantLeaderboard: (projectId, opts) =>
      runPostgresQuery<VariantLeaderboardRow>(pgc, buildVariantLeaderboard(projectId, opts, d)),
    getSessionEvents: (projectId, sessionId) => pgGetSessionEvents(pgc, projectId, sessionId),
    streamSessionEvents: (projectId, sessionId) => pgStreamSessionEvents(pgc, projectId, sessionId),
    getSessionMeta: (projectId, sessionId) => pgGetSessionMeta(pgc, projectId, sessionId),
    putSceneProxy: (projectId, proxy, label) => pgUpsertSceneProxy(pgc, projectId, proxy, label),
    getSceneRepresentation: (projectId, sceneId) =>
      pgGetSceneRepresentation(pgc, projectId, sceneId),
    listSceneRepresentations: (projectId) => pgListSceneRepresentations(pgc, projectId),
    async close() {
      await pgc.close();
    },
  };
}
