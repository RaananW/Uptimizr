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
  buildTimeseries,
  buildTopMeshes,
  buildWorldHeatmap,
  buildGazeHeatmap,
  createDuckdbClient,
  duckdbDialect,
  duckdbGetSceneRepresentation,
  duckdbGetSessionEvents,
  duckdbGetSessionMeta,
  duckdbGetProject,
  duckdbInsertEvents,
  duckdbListSceneRepresentations,
  duckdbResolveApiKey,
  duckdbStreamSessionEvents,
  duckdbUpsertSceneProxy,
  migrateDuckdb,
  readDbSettings,
  runDuckdbQuery,
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
  type DuckdbClient,
  type EventTypeCountRow,
  type FlowLinkRow,
  type HeatmapBinRow,
  type MeshCountRow,
  type MeshDwellRow,
  type NavigationStatsRow,
  type XrRotationRateRow,
  type XrSourceUsageRow,
  type XrAbandonmentRow,
  type InteractionSourceRow,
  type PerfSummaryRow,
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
import type { CollectorStore } from "./store.js";

/**
 * OSS default store (ADR 0020): a single persisted DuckDB file holding both
 * events and metadata, with the **full** analytics surface — no stubbed
 * aggregates. In-process and zero-service, so a self-hosted collector needs no
 * external database. Every aggregation is the dialect-agnostic builder rendered
 * with {@link duckdbDialect}; metadata (projects, API keys, scene registry) is
 * re-homed into the same file.
 *
 * The schema is migrated on creation (migrations are idempotent), so the store
 * is usable out of the box. Pass `":memory:"` for an ephemeral store (tests).
 */
export async function createDuckdbStore(path?: string): Promise<CollectorStore> {
  const filePath = path ?? readDbSettings().duckdb.path;
  const db: DuckdbClient = await createDuckdbClient(filePath);
  await migrateDuckdb(db);

  return {
    resolveApiKey: (key) => duckdbResolveApiKey(db, key),
    projectExists: async (projectId) => (await duckdbGetProject(db, projectId)) !== null,
    insertEvents: (events) => duckdbInsertEvents(db, [...events]),
    listSessions: (projectId, opts = {}) =>
      runDuckdbQuery<SessionSummaryRow>(db, buildListSessions(projectId, opts, duckdbDialect)),
    pointerHeatmap: (projectId, opts = {}) =>
      runDuckdbQuery<HeatmapBinRow>(db, buildPointerHeatmap(projectId, opts, duckdbDialect)),
    worldHeatmap: (projectId, opts = {}) =>
      runDuckdbQuery<WorldHeatmapBinRow>(db, buildWorldHeatmap(projectId, opts, duckdbDialect)),
    gazeHeatmap: (projectId, opts = {}) =>
      runDuckdbQuery<WorldHeatmapBinRow>(db, buildGazeHeatmap(projectId, opts, duckdbDialect)),
    cameraHeatmap: (projectId, opts = {}) =>
      runDuckdbQuery<DirectionBinRow>(
        db,
        buildCameraDirectionHeatmap(projectId, opts, duckdbDialect),
      ),
    cameraPositionHeatmap: (projectId, opts = {}) =>
      runDuckdbQuery<PositionBinRow>(
        db,
        buildCameraPositionHeatmap(projectId, opts, duckdbDialect),
      ),
    sessionTrajectory: (projectId, sessionId, opts = {}) =>
      runDuckdbQuery<TrajectoryPointRow>(
        db,
        buildSessionTrajectory(projectId, { ...opts, session: sessionId }, duckdbDialect),
      ),
    clickGazeRays: (projectId, opts = {}) =>
      runDuckdbQuery<ClickGazeRayRow>(db, buildClickGazeRay(projectId, opts, duckdbDialect)),
    flowHeatmap: (projectId, opts = {}) =>
      runDuckdbQuery<FlowLinkRow>(db, buildFlowHeatmap(projectId, opts, duckdbDialect)),
    topMeshes: (projectId, opts = {}) =>
      runDuckdbQuery<MeshCountRow>(db, buildTopMeshes(projectId, opts, duckdbDialect)),
    meshDwell: (projectId, opts = {}) =>
      runDuckdbQuery<MeshDwellRow>(db, buildMeshDwell(projectId, opts, duckdbDialect)),
    deadClicks: (projectId, opts = {}) =>
      runDuckdbQuery<DeadClickRow>(db, buildDeadClicks(projectId, opts, duckdbDialect)),
    rageClicks: (projectId, opts = {}) =>
      runDuckdbQuery<RageClickRow>(db, buildRageClicks(projectId, opts, duckdbDialect)),
    hoverDwell: (projectId, opts = {}) =>
      runDuckdbQuery<HoverDwellRow>(db, buildHoverDwell(projectId, opts, duckdbDialect)),
    compileStalls: (projectId, opts = {}) =>
      runDuckdbQuery<CompileStallRow>(db, buildCompileStalls(projectId, opts, duckdbDialect)),
    resourceSummary: (projectId, opts = {}) =>
      runDuckdbQuery<ResourceSummaryRow>(db, buildResourceSummary(projectId, opts, duckdbDialect)),
    capabilityChanges: (projectId, opts = {}) =>
      runDuckdbQuery<CapabilityChangeRow>(
        db,
        buildCapabilityChanges(projectId, opts, duckdbDialect),
      ),
    cameraGestures: (projectId, opts = {}) =>
      runDuckdbQuery<CameraGestureRow>(db, buildCameraGestures(projectId, opts, duckdbDialect)),
    perfSummary: (projectId, opts = {}) =>
      runDuckdbQuery<PerfSummaryRow>(db, buildPerfSummary(projectId, opts, duckdbDialect)),
    perfDistribution: (projectId, opts = {}) =>
      runDuckdbQuery<PerfDistributionRow>(
        db,
        buildPerfDistribution(projectId, opts, duckdbDialect),
      ),
    fpsHistogram: (projectId, opts = {}) =>
      runDuckdbQuery<FpsHistogramRow>(db, buildFpsHistogram(projectId, opts, duckdbDialect)),
    frameTimePercentiles: (projectId, opts = {}) =>
      runDuckdbQuery<FrameTimePercentileRow>(
        db,
        buildFrameTimePercentiles(projectId, opts, duckdbDialect),
      ),
    jankRate: (projectId, opts = {}) =>
      runDuckdbQuery<JankRateRow>(db, buildJankRate(projectId, opts, duckdbDialect)),
    perfByDevice: (projectId, opts = {}) =>
      runDuckdbQuery<PerfByDeviceRow>(db, buildPerfByDevice(projectId, opts, duckdbDialect)),
    perfByScene: (projectId, opts = {}) =>
      runDuckdbQuery<PerfBySceneRow>(db, buildPerfByScene(projectId, opts, duckdbDialect)),
    resourcePercentiles: (projectId, opts = {}) =>
      runDuckdbQuery<ResourcePercentileRow>(
        db,
        buildResourcePercentiles(projectId, opts, duckdbDialect),
      ),
    stabilityCounts: (projectId, opts = {}) =>
      runDuckdbQuery<StabilityCountRow>(db, buildStabilityCounts(projectId, opts, duckdbDialect)),
    sceneCoverage: (projectId, opts = {}) =>
      runDuckdbQuery<CoverageVoxelRow>(db, buildSceneCoverage(projectId, opts, duckdbDialect)),
    cameraDistance: (projectId, opts = {}) =>
      runDuckdbQuery<CameraDistanceBucketRow>(
        db,
        buildCameraDistance(projectId, opts, duckdbDialect),
      ),
    navigationStats: (projectId, opts = {}) =>
      runDuckdbQuery<NavigationStatsRow>(db, buildNavigationStats(projectId, opts, duckdbDialect)),
    xrRotationRate: (projectId, opts = {}) =>
      runDuckdbQuery<XrRotationRateRow>(db, buildXrRotationRate(projectId, opts, duckdbDialect)),
    xrSourceUsage: (projectId, opts = {}) =>
      runDuckdbQuery<XrSourceUsageRow>(db, buildXrSourceUsage(projectId, opts, duckdbDialect)),
    xrAbandonment: (projectId, opts = {}) =>
      runDuckdbQuery<XrAbandonmentRow>(db, buildXrAbandonment(projectId, opts, duckdbDialect)),
    interactionsBySource: (projectId, opts = {}) =>
      runDuckdbQuery<InteractionSourceRow>(
        db,
        buildInteractionsBySource(projectId, opts, duckdbDialect),
      ),
    scenes: (projectId, opts = {}) =>
      runDuckdbQuery<SceneRow>(db, buildDistinctScenes(projectId, opts, duckdbDialect)),
    timeseries: (projectId, opts = {}) =>
      runDuckdbQuery<TimeseriesBucketRow>(db, buildTimeseries(projectId, opts, duckdbDialect)),
    eventTypeCounts: (projectId, opts = {}) =>
      runDuckdbQuery<EventTypeCountRow>(db, buildEventTypeCounts(projectId, opts, duckdbDialect)),
    getSessionEvents: (projectId, sessionId) => duckdbGetSessionEvents(db, projectId, sessionId),
    streamSessionEvents: (projectId, sessionId) =>
      duckdbStreamSessionEvents(db, projectId, sessionId),
    getSessionMeta: (projectId, sessionId) => duckdbGetSessionMeta(db, projectId, sessionId),
    putSceneProxy: (projectId, proxy, label) => duckdbUpsertSceneProxy(db, projectId, proxy, label),
    getSceneRepresentation: (projectId, sceneId) =>
      duckdbGetSceneRepresentation(db, projectId, sceneId),
    listSceneRepresentations: (projectId) => duckdbListSceneRepresentations(db, projectId),
    async close() {
      await db.close();
    },
  };
}
