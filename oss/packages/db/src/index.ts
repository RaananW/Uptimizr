/**
 * `@uptimizr/db` — the OSS storage contracts and the single-file DuckDB store
 * (ADR 0020).
 *
 * Ships the dialect-agnostic query layer, engine-neutral event-row mapping and
 * metadata types, and a fully-functional DuckDB store (events + metadata in one
 * file). It carries no ClickHouse/Postgres dependency — an optional,
 * separately-licensed scale store composes these contracts.
 *
 * Server/Node only — no DOM imports. Aggregations are query-time in v1.
 */

export { readDbSettings } from "./env.js";
export type { DbSettings, DuckdbSettings } from "./env.js";

// --- Engine-neutral event-row mapping (ADR 0020) ---
export { toEventRow, formatUtcTimestamp } from "./events.js";
export type { EventRow, SessionMeta } from "./events.js";

// --- Scene-actor transform mapping (node_transform → node_samples, ADR 0027) ---
export { toNodeSampleRow, nodeSampleRowToEvent } from "./events.js";
export type { NodeSampleRow } from "./events.js";

// --- Engine-neutral metadata helpers and types (ADR 0020) ---
export { hashApiKey, apiKeyPrefix, generateApiKey } from "./metadata.js";
export type {
  Project,
  ApiKeyRecord,
  SceneRepresentation,
  SceneRepresentationKind,
  SceneRepresentationSummary,
} from "./metadata.js";

// --- Dialect-agnostic query layer (ADR 0020) ---
// The aggregation builders and dialects are shared across engines (and used by
// the cross-engine parity harness). Each builder renders a `QuerySpec` for the
// dialect it is given.
export type { Dialect, ParamType } from "./query/dialect.js";
export { duckdbDialect, toDuckdbTimestamp } from "./query/duckdbDialect.js";
export {
  buildListSessions,
  buildPointerHeatmap,
  buildWorldHeatmap,
  buildGazeHeatmap,
  buildCameraDirectionHeatmap,
  buildCameraPositionHeatmap,
  buildSessionTrajectory,
  buildClickGazeRay,
  buildFlowHeatmap,
  buildTopMeshes,
  buildMeshDwell,
  buildDeadClicks,
  buildRageClicks,
  buildHoverDwell,
  buildCompileStalls,
  buildResourceSummary,
  buildCapabilityChanges,
  buildCameraGestures,
  buildPerfSummary,
  buildPerfDistribution,
  buildFpsHistogram,
  buildFrameTimePercentiles,
  buildJankRate,
  buildPerfByDevice,
  buildPerfByScene,
  buildResourcePercentiles,
  buildStabilityCounts,
  buildPerfDaily,
  buildEventsDaily,
  buildDistinctScenes,
  buildTimeseries,
  buildEventTypeCounts,
  buildSceneCoverage,
  buildCameraDistance,
  buildNavigationStats,
  buildXrRotationRate,
  buildXrSourceUsage,
  buildXrAbandonment,
  buildInteractionsBySource,
} from "./query/aggregations.js";
export type {
  QuerySpec,
  RangeOptions,
  SceneOptions,
  SourceOptions,
  SessionOptions,
  CameraModeOptions,
  TimeseriesOptions,
  SessionSummaryRow,
  HeatmapBinRow,
  WorldHeatmapBinRow,
  PositionBinRow,
  TrajectoryPointRow,
  DirectionBinRow,
  ClickGazeRayRow,
  FlowLinkRow,
  MeshCountRow,
  MeshDwellRow,
  DeadClickRow,
  RageClickRow,
  HoverDwellRow,
  CompileStallRow,
  ResourceSummaryRow,
  CapabilityChangeRow,
  CameraGestureRow,
  PerfSummaryRow,
  PerfDistributionRow,
  FpsHistogramRow,
  FrameTimePercentileRow,
  JankRateRow,
  PerfByDeviceRow,
  PerfBySceneRow,
  ResourcePercentileRow,
  StabilityCountRow,
  PerfDailyRow,
  EventsDailyRow,
  SceneRow,
  TimeseriesBucketRow,
  EventTypeCountRow,
  CoverageVoxelRow,
  CameraDistanceBucketRow,
  NavigationStatsRow,
  XrRotationRateRow,
  XrSourceUsageRow,
  XrAbandonmentRow,
  InteractionSourceRow,
} from "./query/types.js";

// --- DuckDB (OSS single-file store, ADR 0020) ---
export { createDuckdbClient, convertValue } from "./duckdb/client.js";
export type { DuckdbClient, DuckdbRow } from "./duckdb/client.js";
export { DUCKDB_MIGRATIONS, migrateDuckdb } from "./duckdb/migrations.js";
export { runDuckdbQuery } from "./duckdb/queries.js";
export {
  insertEvents as duckdbInsertEvents,
  getSessionEvents as duckdbGetSessionEvents,
  streamSessionEvents as duckdbStreamSessionEvents,
  getSessionMeta as duckdbGetSessionMeta,
} from "./duckdb/events.js";
export {
  createProject as duckdbCreateProject,
  getProject as duckdbGetProject,
  createApiKey as duckdbCreateApiKey,
  resolveApiKey as duckdbResolveApiKey,
} from "./duckdb/projects.js";
export {
  upsertSceneProxy as duckdbUpsertSceneProxy,
  getSceneRepresentation as duckdbGetSceneRepresentation,
  listSceneRepresentations as duckdbListSceneRepresentations,
} from "./duckdb/sceneRegistry.js";

// --- Cross-engine parity harness (ADR 0020) ---
// Shared fixtures, golden expectations, and a tolerance-aware comparator. OSS
// runs DuckDB-vs-golden; the scale tier reuses these to run DuckDB-vs-ClickHouse.
export {
  PARITY_PROJECT_ID,
  PARITY_T0,
  PARITY_RANGE,
  PARITY_DAY_RANGE,
  PARITY_DAY,
  PARITY_EVENTS,
} from "./parity/fixtures.js";
export { PARITY_ABS_TOLERANCE, PARITY_REL_TOLERANCE, diffParity } from "./parity/compare.js";
export type { ParityRow, ParityCompareOptions } from "./parity/compare.js";
export { PARITY_CASES } from "./parity/cases.js";
export type { ParityCase } from "./parity/cases.js";
