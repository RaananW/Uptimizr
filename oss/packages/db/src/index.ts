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
export type {
  DbSettings,
  DuckdbSettings,
  ClickhouseSettings,
  PostgresSettings,
  MssqlSettings,
} from "./env.js";

// --- Engine-neutral event-row mapping (ADR 0020) ---
export { toEventRow, formatUtcTimestamp } from "./events.js";
export type { EventRow, SessionMeta } from "./events.js";

// --- Scene-actor transform mapping (node_transform → node_samples, ADR 0027) ---
export { toNodeSampleRow, nodeSampleRowToEvent } from "./events.js";
export type { NodeSampleRow } from "./events.js";

// --- Engine-neutral metadata helpers and types (ADR 0020) ---
export { hashApiKey, apiKeyPrefix, generateApiKey } from "./metadata.js";
// Agent-scoped key capabilities, per-key rate limits and the audit log
// (#309, ADR 0051 §7).
export {
  API_KEY_CAPABILITIES,
  AUDIT_PARAMS_MAX_LENGTH,
  AUDIT_TOOL_MAX_LENGTH,
  DEFAULT_API_KEY_CAPABILITIES,
  clampAuditTool,
  hasCapability,
  isApiKeyCapability,
  parseApiKeyCapabilities,
  parseCapabilityList,
  serializeApiKeyCapabilities,
  serializeAuditParams,
  toApiKeyColumns,
  toApiKeyRateLimit,
} from "./metadata.js";
export type {
  Project,
  AgentAuditEntry,
  AgentAuditInput,
  ApiKeyRecord,
  ApiKeyCapability,
  ApiKeyRateLimit,
  AuditQueryOptions,
  AuditSurface,
  CreateApiKeyOptions,
  ResolvedApiKey,
  SceneRepresentation,
  SceneRepresentationKind,
  SceneRepresentationSummary,
  SceneRegionRecord,
  SceneRegionSummary,
} from "./metadata.js";

// --- Dialect-agnostic query layer (ADR 0020) ---
// The aggregation builders and dialects are shared across engines (and used by
// the cross-engine parity harness). Each builder renders a `QuerySpec` for the
// dialect it is given.
export type { Dialect, ParamType, AsofJoinSpec } from "./query/dialect.js";
export { duckdbDialect, toDuckdbTimestamp } from "./query/duckdbDialect.js";
export { clickhouseDialect, toClickhouseTimestamp } from "./query/clickhouseDialect.js";
export {
  postgresDialect,
  toPostgresTimestamp,
  POSTGRES_NEAREST_ROW_JOIN,
} from "./query/postgresDialect.js";
export {
  mssqlDialect,
  toMssqlTimestamp,
  toTsql,
  mssqlVectorElement,
  MSSQL_NEAREST_ROW_JOIN,
  MSSQL_BIN_COLLATION,
  MSSQL_QUANTILE_FUNCTION,
} from "./query/mssqlDialect.js";
// Relational building blocks shared by the row-store dialects (Postgres and SQL
// Server — #84, #85): ASOF emulation and named→positional param rewriting.
export {
  renderNativeAsofJoin,
  renderNearestRowJoin,
  toPositionalParams,
} from "./query/relational.js";
export type { NearestRowJoinTokens, PositionalQuery } from "./query/relational.js";
export {
  buildListSessions,
  buildPointerHeatmap,
  buildMeshUvHeatmap,
  buildWorldHeatmap,
  buildWorldHeatmapStats,
  buildGazeHeatmap,
  buildGazeHeatmapStats,
  buildCameraDirectionHeatmap,
  buildViewCoverageHistogram,
  buildCameraPositionHeatmap,
  defaultCellSizeForBounds,
  buildSessionTrajectory,
  buildAggregateTrajectories,
  buildClickGazeRay,
  buildFlowHeatmap,
  buildTopMeshes,
  buildTopMeshesBySource,
  buildTopMeshesTrend,
  buildMeshDwell,
  buildMeshBlindSpots,
  buildMeshInteractionKinds,
  buildReachability,
  buildTopInputActions,
  buildDeadClicks,
  buildRageClicks,
  buildHoverDwell,
  buildCompileStalls,
  buildResourceSummary,
  buildCapabilityChanges,
  buildCameraGestures,
  buildPerfSummary,
  buildRenderScaleTruth,
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
  buildPerfDaily,
  buildEventsDaily,
  buildDistinctScenes,
  buildTimeseries,
  buildEventTypeCounts,
  buildSceneCoverage,
  buildPerfHeatmap,
  buildCameraDistance,
  buildNavigationStats,
  buildBacktrackRatio,
  buildXrRotationRate,
  buildXrSourceUsage,
  buildXrAbandonment,
  buildXrLocomotionComfort,
  buildTrackingQuality,
  buildInteractionsBySource,
  buildArPlacementTimeToPlace,
  buildArPlacementAttempts,
  buildArPlacementSurfaces,
  buildFunnel,
  buildSceneRetention,
  buildLoadBounceFunnel,
  buildVariantLeaderboard,
} from "./query/aggregations.js";
// --- Numeric coercion at the store edge (ADR 0051 §2) ---
// Applied by every store's query runner so the collector always emits numbers.
// Lives on the root barrel rather than the browser-safe `/query` subpath because
// it reads the metric registry, which ships as its own dependency-free package
// (`@uptimizr/metrics`) so a browser bundle opts into that data explicitly.
export { coerceRows, numericColumns, numericColumnsOfMetric } from "./query/coerce.js";
export type { CoerceRowsOptions } from "./query/coerce.js";

// --- Query DSL v1, delegated tier (ADR 0051 §3, design sketch §C.2) ---
// A validated `queryV1` document → the metric's existing aggregation builder →
// an ordinary `QuerySpec`. Also published on the browser-safe
// `@uptimizr/db/query` subpath, alongside the builders it delegates to.
export {
  builderFor,
  cameraTypeForMode,
  compileMetric,
  compileQuery,
  toBuilderOptions,
} from "./query/dsl/index.js";
export type { AggregationBuilder, MetricQueryOptions, QueryResolution } from "./query/dsl/index.js";

// --- Agent-shaped result envelopes (ADR 0051 §2, design sketch §B.1) ---
// `format=table | summary`: pure, registry-driven summarisation of a metric's
// rows. Re-exported here for the collector's convenience; also published on its
// own browser-safe `@uptimizr/db/summary` subpath, which — like `/registry` —
// carries no DuckDB driver and no `node:` import.
export * from "./query/summary/index.js";

export type {
  QuerySpec,
  RangeOptions,
  SceneOptions,
  SourceOptions,
  SessionOptions,
  MeshOptions,
  RegionOptions,
  ErrorHeatmapOptions,
  WorldAabb,
  CameraModeOptions,
  TimeseriesOptions,
  SessionSummaryRow,
  HeatmapBinRow,
  WorldHeatmapBinRow,
  SpatialStatsRow,
  PositionBinRow,
  TrajectoryPointRow,
  AggregateTrajectoryPointRow,
  DirectionBinRow,
  ViewCoverageHistogramRow,
  ClickGazeRayRow,
  FlowLinkRow,
  MeshCountRow,
  MeshDwellRow,
  MeshBlindSpotRow,
  MeshInteractionKindRow,
  ReachabilityBinRow,
  MeshSourceCountRow,
  MeshTrendPointRow,
  InputActionCountRow,
  DeadClickRow,
  RageClickRow,
  HoverDwellRow,
  CompileStallRow,
  ArPlacementTimeToPlaceRow,
  ArPlacementAttemptsRow,
  ArPlacementSurfaceRow,
  ResourceSummaryRow,
  CapabilityChangeRow,
  CameraGestureRow,
  PerfSummaryRow,
  RenderScaleTruthRow,
  PerfDistributionRow,
  FpsHistogramRow,
  FrameTimePercentileRow,
  JankRateRow,
  PerfChurnOptions,
  PerfChurnRow,
  PerfByDeviceRow,
  PerfBySceneRow,
  ResourcePercentileRow,
  StabilityCountRow,
  GraphicsDiagnosticCountRow,
  RenderingTechnologyRow,
  PerfDailyRow,
  EventsDailyRow,
  SceneRow,
  TimeseriesBucketRow,
  EventTypeCountRow,
  CoverageVoxelRow,
  PerfHeatmapVoxelRow,
  CameraDistanceBucketRow,
  NavigationStatsRow,
  BacktrackRatioRow,
  XrRotationRateRow,
  XrSourceUsageRow,
  XrAbandonmentRow,
  XrLocomotionRow,
  BoundaryContactsRow,
  TrackingQualityRow,
  InteractionSourceRow,
  FunnelStepInput,
  FunnelOptions,
  FunnelStepResultRow,
  SceneRetentionOptions,
  SceneRetentionRow,
  LoadBounceFunnelOptions,
  LoadBounceBandRow,
  VariantLeaderboardOptions,
  VariantLeaderboardRow,
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
  recordAudit as duckdbRecordAudit,
  listAudit as duckdbListAudit,
  pruneAudit as duckdbPruneAudit,
} from "./duckdb/audit.js";
export {
  upsertSceneProxy as duckdbUpsertSceneProxy,
  getSceneRepresentation as duckdbGetSceneRepresentation,
  listSceneRepresentations as duckdbListSceneRepresentations,
} from "./duckdb/sceneRegistry.js";
export {
  putSceneRegions as duckdbPutSceneRegions,
  getSceneRegions as duckdbGetSceneRegions,
  listSceneRegions as duckdbListSceneRegions,
} from "./duckdb/sceneRegions.js";

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
export {
  PARITY_ABS_TOLERANCE,
  PARITY_REL_TOLERANCE,
  diffParity,
  numericColumnsForSpec,
} from "./parity/compare.js";
export type { ParityRow, ParityCompareOptions } from "./parity/compare.js";
export { PARITY_CASES } from "./parity/cases.js";
export type { ParityCase } from "./parity/cases.js";
