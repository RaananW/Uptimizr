/**
 * The semantic **metric registry** (ADR 0051 §1, design sketch §A).
 *
 * One {@link MetricDefinition} per `build*` aggregation in `@uptimizr/db`'s
 * `query/aggregations.ts`, declaring what the metric measures, what one row *is*,
 * the unit and semantics of every column, the filters it accepts, the collector
 * endpoint it is served on, the capture channels that must be enabled for it to
 * have data, and how to read the result. Downstream consumers (the agent tool
 * catalog, OpenAPI, the MCP capabilities resource, the docs tables) are meant to
 * be **derived** from this file rather than hand-maintained, so coverage cannot
 * drift.
 *
 * **This module is pure data.** It imports `zod` and a *type-only* declaration
 * from `@uptimizr/schema`; it performs no I/O, touches no `node:` built-in and
 * holds no reference to a store, a dialect or a database driver. That is the
 * whole reason this package exists: `@uptimizr/db` depends on `@duckdb/node-api`
 * (a ~37 MB native binding), and the browser/CLI consumers of the registry
 * (`@uptimizr/agent-core`, `@uptimizr/mcp`, `@uptimizr/react`) can never use a
 * DuckDB driver — so the registry lives here, in a package whose only runtime
 * dependencies are `zod` and `@uptimizr/schema`.
 *
 * **Numbers are numbers.** Every numeric column is a strict `z.number()`, so a
 * `row` schema describes exactly what the collector emits. The engines that
 * string-encode 64-bit integers or decimals (ClickHouse over HTTP) are
 * normalised by `coerceRows` in every store's query runner, at the one point
 * rows leave the driver (ADR 0051 §2, `query/coerce.ts`) — the schema is the
 * contract, the store edge is what upholds it.
 *
 * The invariant this file exists to enforce: **a new aggregation is not done
 * until it has a registry entry.** This package's `src/__tests__/registry.test.ts`
 * fails the build when a name in {@link AGGREGATION_BUILDER_NAMES} has no entry;
 * `@uptimizr/db`'s own `src/__tests__/registry.test.ts` fails when that list and
 * the `build*` exports of `aggregations.ts` disagree; and the collector's
 * `registryRoutes.test.ts` fails when an entry's endpoint or filters drift from
 * the Zod querystring that actually serves it.
 */

import { z } from "zod";
import type { EventType } from "@uptimizr/schema";

/**
 * Every exported `build*` aggregation name in `@uptimizr/db`'s
 * `query/aggregations.ts`. The registry must cover them all.
 *
 * Declared here as literal data rather than derived with
 * `keyof typeof aggregations`, because deriving it would make this package
 * depend on `@uptimizr/db` — exactly the edge (and the ~37 MB native DuckDB
 * binding behind it) that this package exists to break. The link is not lost,
 * only moved from the compiler to CI: `@uptimizr/db`'s `registry.test.ts`
 * asserts at runtime that the set of its `build*` exports is exactly this list,
 * so adding, renaming or deleting an aggregation without updating this list
 * fails the build and names the offender.
 */
export const AGGREGATION_BUILDER_NAMES = [
  "buildAggregateTrajectories",
  "buildArPlacementAttempts",
  "buildArPlacementSurfaces",
  "buildArPlacementTimeToPlace",
  "buildBacktrackRatio",
  "buildBoundaryContacts",
  "buildBoundaryHeatmap",
  "buildBoundaryHeatmapStats",
  "buildCameraDirectionHeatmap",
  "buildCameraDistance",
  "buildCameraGestures",
  "buildCameraPositionHeatmap",
  "buildCapabilityChanges",
  "buildClickGazeRay",
  "buildCompileStalls",
  "buildDeadClicks",
  "buildDistinctScenes",
  "buildErrorHeatmap",
  "buildEventTypeCounts",
  "buildEventsDaily",
  "buildFlowHeatmap",
  "buildFpsHistogram",
  "buildFrameTimePercentiles",
  "buildFunnel",
  "buildGazeHeatmap",
  "buildGazeHeatmapStats",
  "buildGraphicsDiagnosticCounts",
  "buildHoverDwell",
  "buildInteractionsBySource",
  "buildJankRate",
  "buildListSessions",
  "buildLoadBounceFunnel",
  "buildMeshBlindSpots",
  "buildMeshDwell",
  "buildMeshInteractionKinds",
  "buildMeshUvHeatmap",
  "buildNavigationStats",
  "buildPerfByDevice",
  "buildPerfByScene",
  "buildPerfChurn",
  "buildPerfDaily",
  "buildPerfDistribution",
  "buildPerfHeatmap",
  "buildPerfSummary",
  "buildPointerHeatmap",
  "buildRageClicks",
  "buildReachability",
  "buildRenderScaleTruth",
  "buildRenderingTechnology",
  "buildResourcePercentiles",
  "buildResourceSummary",
  "buildSceneCoverage",
  "buildSceneRetention",
  "buildSessionTrajectory",
  "buildStabilityCounts",
  "buildTimeseries",
  "buildTopInputActions",
  "buildTopMeshes",
  "buildTopMeshesBySource",
  "buildTopMeshesTrend",
  "buildTrackingQuality",
  "buildVariantLeaderboard",
  "buildViewCoverageHistogram",
  "buildWorldHeatmap",
  "buildWorldHeatmapStats",
  "buildXrAbandonment",
  "buildXrLocomotionComfort",
  "buildXrRotationRate",
  "buildXrSourceUsage",
] as const;

/** Every exported `build*` aggregation name. The registry must cover them all. */
export type AggregationBuilderName = (typeof AGGREGATION_BUILDER_NAMES)[number];

/**
 * Group-by dimensions a metric's rows can be keyed by. Closed union, declared
 * once: the query DSL (ADR 0051 §3) will accept exactly this vocabulary, so it
 * is restricted to columns the store *promotes* — a group-by on any of them
 * renders identically on DuckDB, ClickHouse, Postgres and SQL Server.
 */
export type DimensionId =
  | "scene"
  | "session"
  | "mesh"
  | "name"
  | "source"
  | "event_type"
  | "cameraMode"
  | "device.engine"
  | "device.renderer"
  | "device.isMobile"
  | "device.browser"
  | "device.os";

/** Where each {@link DimensionId} reads from in the event model. */
export const DIMENSION_COLUMNS: Readonly<Record<DimensionId, string>> = {
  scene: "events.scene_id",
  session: "events.session_id",
  mesh: "events.mesh",
  name: "events.name (interaction/gesture kind, input action, custom name)",
  source: "events.source",
  event_type: "events.event_type",
  cameraMode: "session_start.payload.scene.cameraType",
  "device.engine": "session_start.payload.device.engine",
  "device.renderer": "session_start.payload.device.renderer",
  "device.isMobile": "session_start.payload.device.isMobile",
  "device.browser": "session_start.payload.device.browser (derived from the UA, ADR 0042)",
  "device.os": "session_start.payload.device.os (derived from the UA, ADR 0042)",
};

/**
 * Every request parameter the query surface accepts. Closed union, declared
 * once: a metric's `filters` are exactly the keys of the Zod querystring that
 * serves its endpoint (asserted by the collector's registry route test), and the
 * DSL will accept the same names.
 */
export type FilterId =
  | "since"
  | "until"
  | "scene"
  | "session"
  | "source"
  | "mesh"
  | "region"
  | "cameraMode"
  | "bins"
  | "limit"
  | "cellSize"
  | "interval"
  | "type"
  | "bucket"
  | "bucketMs"
  | "bucketSize"
  | "minRepeats"
  | "windowMs"
  | "fpsThreshold"
  | "stallMs"
  | "moveThreshold"
  | "rapidTurn"
  | "centerX"
  | "centerY"
  | "centerZ"
  | "severity"
  | "category"
  | "errorKind"
  | "groupByOrigin"
  | "originVoxel"
  | "steps"
  | "bands"
  | "variant"
  | "conversion"
  // Cross-cutting result shaping (ADR 0051 §2, design sketch §B.1). Unlike every
  // other filter this one narrows nothing: it selects the *envelope* the
  // collector wraps the rows in, and is consumed by the response layer rather
  // than by an aggregation option.
  | "format";

/**
 * The option interface (in `types.ts`) a {@link FilterId} feeds. `BuilderOptions`
 * means the builder's own inline option bag rather than a shared interface.
 */
export type FilterOptionInterface =
  | "RangeOptions"
  | "SceneOptions"
  | "SourceOptions"
  | "SessionOptions"
  | "MeshOptions"
  | "RegionOptions"
  | "CameraModeOptions"
  | "TimeseriesOptions"
  | "ErrorHeatmapOptions"
  | "PerfChurnOptions"
  | "FunnelOptions"
  | "LoadBounceFunnelOptions"
  | "VariantLeaderboardOptions"
  | "BuilderOptions"
  /**
   * Not an aggregation option at all: the parameter is consumed by the
   * collector's response layer and never reaches a builder. Only `format`
   * (design sketch §B.1) uses it.
   */
  | "ResultEnvelope";

/** How one request parameter reaches the aggregation layer. */
export interface FilterTarget {
  /** The option interface in `types.ts` this parameter is assigned to. */
  option: FilterOptionInterface;
  /** The field on that interface the collector assigns the value to. */
  field: string;
  /** What the parameter does, agent-facing. */
  description: string;
}

/**
 * The single mapping from a request parameter to the option field it drives.
 * Consumers (docs generator, OpenAPI, the DSL) read filter semantics here rather
 * than re-deriving them from the route handlers.
 */
export const FILTER_TARGETS: Readonly<Record<FilterId, FilterTarget>> = {
  since: {
    option: "RangeOptions",
    field: "since",
    description: "Inclusive lower bound of the time range, epoch milliseconds.",
  },
  until: {
    option: "RangeOptions",
    field: "until",
    description: "Exclusive upper bound of the time range, epoch milliseconds.",
  },
  scene: {
    option: "SceneOptions",
    field: "scene",
    description: "Restrict to one developer-assigned scene id (ADR 0010).",
  },
  session: {
    option: "SessionOptions",
    field: "session",
    description: "Scope the aggregate to a single session id.",
  },
  source: {
    option: "SourceOptions",
    field: "source",
    description:
      "Restrict to one input source: mouse / touch / xr-controller / hand / … (ADR 0011).",
  },
  mesh: {
    option: "MeshOptions",
    field: "mesh",
    description: "Restrict to one mesh/object name.",
  },
  region: {
    option: "RegionOptions",
    field: "region",
    description:
      "World-space drill-down box `minX,minY,minZ,maxX,maxY,maxZ` (ADR 0040 §4). Omit for the whole scene.",
  },
  cameraMode: {
    option: "CameraModeOptions",
    field: "cameraType",
    description:
      "Camera navigation model to scope to (ADR 0026). `viewer` maps to the stored `arc-rotate`, `first-person` to `free`.",
  },
  bins: {
    option: "BuilderOptions",
    field: "bins",
    description: "Grid resolution per axis for a binned heatmap (1–500).",
  },
  limit: {
    option: "BuilderOptions",
    field: "limit",
    description: "Maximum rows returned; the registry `limits.maxRows` is the hard cap.",
  },
  cellSize: {
    option: "BuilderOptions",
    field: "cellSize",
    description:
      "Voxel / ground-cell edge in world units. Omit to let the collector derive it from the scene or region bounds (ADR 0040 §1).",
  },
  interval: {
    option: "TimeseriesOptions",
    field: "interval",
    description: "Time-bucket width in seconds.",
  },
  type: {
    option: "TimeseriesOptions",
    field: "type",
    description: "Restrict the volume to a single event type.",
  },
  bucket: {
    option: "BuilderOptions",
    field: "bucket",
    description: "Histogram bin width in FPS.",
  },
  bucketMs: {
    option: "BuilderOptions",
    field: "bucketMs",
    description: "Histogram bin width in milliseconds.",
  },
  bucketSize: {
    option: "BuilderOptions",
    field: "bucketSize",
    description: "Histogram bin width in world units.",
  },
  minRepeats: {
    option: "BuilderOptions",
    field: "minRepeats",
    description: "Minimum clicks in a window before it counts as a rage cluster.",
  },
  windowMs: {
    option: "PerfChurnOptions",
    field: "windowMs",
    description: "How long before a session's end a perf dip still counts as correlated.",
  },
  fpsThreshold: {
    option: "PerfChurnOptions",
    field: "fpsThreshold",
    description: "A `frame_perf` sample below this FPS counts as a dip.",
  },
  stallMs: {
    option: "PerfChurnOptions",
    field: "stallMs",
    description: "A `compile_stall` at least this long (ms) counts as a dip.",
  },
  moveThreshold: {
    option: "BuilderOptions",
    field: "moveThreshold",
    description:
      "Inter-sample distance (world units) above which a segment counts as active travel.",
  },
  rapidTurn: {
    option: "BuilderOptions",
    field: "rapidTurn",
    description: "View-turn threshold in radians (0..π) above which a step counts as a rapid turn.",
  },
  centerX: {
    option: "BuilderOptions",
    field: "center[0]",
    description: "X of the reference point distances are measured from.",
  },
  centerY: {
    option: "BuilderOptions",
    field: "center[1]",
    description: "Y of the reference point distances are measured from.",
  },
  centerZ: {
    option: "BuilderOptions",
    field: "center[2]",
    description: "Z of the reference point distances are measured from.",
  },
  severity: {
    option: "ErrorHeatmapOptions",
    field: "severity",
    description:
      "`graphics_diagnostic` severity (info / warning / error / fatal). Setting it excludes JS runtime errors.",
  },
  category: {
    option: "ErrorHeatmapOptions",
    field: "category",
    description:
      "`graphics_diagnostic` category (context-loss / validation / shader-compile / …). Setting it excludes JS runtime errors.",
  },
  errorKind: {
    option: "ErrorHeatmapOptions",
    field: "errorKind",
    description:
      "`runtime_error` kind (error / unhandledrejection). Setting it excludes engine diagnostics.",
  },
  groupByOrigin: {
    option: "BuilderOptions",
    field: "groupByOrigin",
    description: "Add the click-time standpoint voxel as a grouping dimension.",
  },
  originVoxel: {
    option: "BuilderOptions",
    field: "originVoxel",
    description: "Restrict to clicks whose standpoint falls in this `vx,vy,vz` voxel.",
  },
  steps: {
    option: "FunnelOptions",
    field: "steps",
    description: "Ordered funnel step predicates, JSON-encoded (ADR 0038). At least two.",
  },
  bands: {
    option: "LoadBounceFunnelOptions",
    field: "bands",
    description:
      "Ascending, comma-separated load-time band boundaries in ms. Omit for the default `1000,3000,5000`.",
  },
  variant: {
    option: "VariantLeaderboardOptions",
    field: "variant",
    description:
      "JSON funnel-step predicate selecting the variant events. Omit to treat every `custom` event as a variant.",
  },
  conversion: {
    option: "VariantLeaderboardOptions",
    field: "conversion",
    description: "JSON funnel-step predicate for the success event. Omit to report views only.",
  },
  format: {
    option: "ResultEnvelope",
    field: "(response layer)",
    description:
      "Result envelope: `full` (default — the bare rows, unchanged), `table` (the same rows plus " +
      "a `meta` envelope), or `summary` (a bounded, self-describing digest: top rows or clusters " +
      "or a trend, with shares, a sample size, a templated reading and the caveats).",
  },
};

/** Physical meaning of a column's values. */
export type ColumnUnit =
  | "count"
  | "sessions"
  | "ms"
  | "s"
  | "fps"
  | "ratio"
  | "percent"
  | "world-units"
  | "radians"
  | "bytes"
  | "epoch-ms"
  | "id"
  | "label"
  | "timestamp"
  | "index";

/** Per-column semantics used by summaries, comparisons and the docs tables. */
export interface ColumnSemantics {
  description: string;
  unit?: ColumnUnit;
  /** For summaries: the column to rank by. At most one per metric. */
  measure?: boolean;
  /** For summaries: the column that names the row (mesh, scene, bucket…). */
  label?: boolean;
  /**
   * For summaries of a `bucket`-grain metric: the **ordered** column the rows
   * advance along (the time bucket, the day, the histogram bin, the funnel
   * step). Exactly one per `bucket`-grain metric, and never set on any other
   * grain — asserted in `src/__tests__/registry.test.ts`.
   *
   * It exists because `label` cannot double as the axis: `mesh_trend` is one row
   * per (mesh, bucket) and labels its rows by `mesh`, so ordering by `label`
   * would interleave series instead of walking time.
   */
  axis?: boolean;
  /** Denominator column when this column is a rate/share. */
  rateOf?: string;
}

/** What one row of a metric represents. */
export type MetricGrain =
  "project" | "scene" | "session" | "mesh" | "bin" | "voxel" | "bucket" | "row";

/** Grouping used by the docs, the capabilities resource and the health score. */
export type MetricCategory =
  | "attention"
  | "interaction"
  | "navigation"
  | "performance"
  | "errors"
  | "xr"
  | "ar"
  | "sessions"
  | "conversion";

/** The collector route a metric is served on. */
export interface MetricEndpoint {
  method: "GET";
  /** Fastify path, `:param` placeholders included. */
  path: string;
  /**
   * Filters carried in the path rather than the querystring (e.g. the session id
   * of a trajectory). One entry per `:param` segment, in order.
   */
  pathParams?: readonly FilterId[];
}

/** Comparison semantics for `compare`, `movers` and `anomalies` (ADR 0051 §4). */
export interface MetricComparison {
  /** The column whose change is "the" change for this metric. */
  primary: string;
  /** Whether a rise is good, bad, or merely informational. */
  direction: "up" | "down" | "neutral";
  /** Minimum denominator before a delta is worth reporting. */
  minSample: number;
}

/**
 * Everything a consumer needs to call a metric, read its result and judge how
 * far to trust it.
 */
export interface MetricDefinition {
  /** Stable id, snake_case. Also the DSL `metric` name and the agent tool name. */
  id: MetricId;
  title: string;
  /** What it measures and what one row is — agent-facing, one paragraph. */
  description: string;
  /**
   * The aggregation builder that computes it. Omitted for **resource** entries
   * (`session_meta`, `scene_representation`) which are store reads, not
   * aggregations, but are part of the agent surface.
   */
  builder?: AggregationBuilderName;
  /** The canned collector route, when one exists. */
  endpoint?: MetricEndpoint;
  /** What one row represents. */
  grain: MetricGrain;
  /** The dimension columns this metric's rows are keyed by. */
  dimensions: readonly DimensionId[];
  /** Accepted querystring parameters — exactly the endpoint's Zod keys. */
  filters: readonly FilterId[];
  /** Output row schema: the source for OpenAPI, tool output schemas and coercion. */
  row: z.ZodObject;
  /** Per-column semantics, keyed by column name. */
  columns: Readonly<Record<string, ColumnSemantics>>;
  /** Registry-declared caps, so no consumer can ask for an unbounded payload. */
  limits: { maxRows: number; maxSummaryRows: number };
  /** How to read the result. */
  interpretation: string;
  /** Small-sample, capture-gating and sampling-rate warnings. */
  caveats: readonly string[];
  /** The capture channels that feed it (ADR 0012) — empty for derived rollups. */
  sourceChannels: readonly EventType[];
  /** Metrics worth reading alongside this one. */
  related: readonly MetricId[];
  /** Comparison semantics, when the metric has a meaningful single measure. */
  comparable?: MetricComparison;
  category: MetricCategory;
}

/**
 * Every metric id. Declared as a closed union (rather than inferred from the
 * registry object) so `METRIC_REGISTRY` is checked for exhaustive coverage and
 * `MetricDefinition.id` can reference it without a circular type.
 *
 * The first twenty ids are the tool names already shipped in
 * `@uptimizr/agent-core` (`readTools`) and MUST NOT change — an MCP client that
 * calls `top_meshes` today must keep working when the catalog is generated from
 * this registry (design sketch §A.4).
 */
export type MetricId =
  // --- ids that are already shipped agent tool names (ADR 0017 / ADR 0050) ---
  | "list_sessions"
  | "pointer_heatmap"
  | "world_heatmap"
  | "camera_heatmap"
  | "click_rays"
  | "flow_links"
  | "top_meshes"
  | "perf_summary"
  | "list_scenes"
  | "timeseries"
  | "event_counts"
  | "session_meta"
  | "scene_representation"
  | "funnel"
  | "aggregate_paths"
  | "rendering_technology"
  | "xr_rotation"
  | "xr_sources"
  | "xr_abandonment"
  | "xr_locomotion"
  // --- attention / spatial ---
  | "mesh_uv_heatmap"
  | "world_heatmap_stats"
  | "gaze_heatmap"
  | "gaze_heatmap_stats"
  | "view_coverage_histogram"
  | "position_heatmap"
  | "session_trajectory"
  | "scene_coverage"
  | "camera_distance"
  // --- meshes / interaction ---
  | "mesh_sources"
  | "mesh_trend"
  | "mesh_dwell"
  | "mesh_blind_spots"
  | "mesh_interaction_kinds"
  | "mesh_reachability"
  | "dead_clicks"
  | "rage_clicks"
  | "hover_dwell"
  | "interaction_sources"
  | "top_input_actions"
  | "camera_gestures"
  // --- navigation ---
  | "navigation_stats"
  | "backtrack_ratio"
  // --- performance ---
  | "render_scale_truth"
  | "perf_distribution"
  | "fps_histogram"
  | "frame_time_percentiles"
  | "jank_rate"
  | "perf_churn"
  | "perf_by_device"
  | "perf_by_scene"
  | "perf_heatmap"
  | "perf_daily"
  | "events_daily"
  | "compile_stalls"
  | "resource_summary"
  | "resource_percentiles"
  // --- errors / stability ---
  | "stability_counts"
  | "graphics_diagnostics"
  | "error_heatmap"
  | "capability_changes"
  // --- XR / AR ---
  | "boundary_heatmap"
  | "boundary_heatmap_stats"
  | "xr_boundary_contacts"
  | "xr_tracking_quality"
  | "ar_placement_time_to_place"
  | "ar_placement_attempts"
  | "ar_placement_surfaces"
  // --- conversion ---
  | "scene_retention"
  | "load_bounce_funnel"
  | "variant_leaderboard";

// --- Row-schema building blocks ------------------------------------------
//
// Numeric columns are **strict** `z.number()`: they describe what the collector
// actually emits. Engines that string-encode 64-bit integers or decimals (notably
// ClickHouse over HTTP) are normalised by `coerceRows` in every store's query
// runner, at the single point rows leave the driver (ADR 0051 §2) — so by the
// time a row reaches a consumer, a numeric column *is* a number. Do not
// reintroduce `z.coerce.number()` here: that would make the schema describe a
// wire format rather than the API contract, and would let a store regression
// pass unnoticed.

/** A numeric column (integer or fractional). */
const num = z.number();
/** A whole-number column: a `count(*)`, a distinct count, or a `floor()` bin. */
const int = z.number().int();
/**
 * A nullable numeric column. Two things make a column nullable:
 *
 * 1. the metric is one an engine or connector may not report at all
 *    (`avg_render_scale` on a renderer with no dynamic resolution); or
 * 2. it is an aggregate over a set that can be **empty** — `sum`, `avg`, `max`
 *    and `quantile` are SQL-`NULL` over no rows, and a summary metric with no
 *    `GROUP BY` still returns its one row when the range or filter matched
 *    nothing. A brand-new project reads `null`, not `0`.
 *
 * `null` means "no samples" and is never `0`-filled: a zero average is a claim
 * about the data, absence is not.
 */
const numOrNull = z.number().nullable();
/** A nullable whole-number column — see {@link numOrNull} for when null occurs. */
const intOrNull = z.number().int().nullable();
/** An identifier or label column; `''` means "unknown"/"unattributed". */
const text = z.string();
/**
 * An engine-formatted wall-clock column (`YYYY-MM-DD HH:MM:SS.mmm`). Every store
 * normalises temporal projections to naive-UTC text, so this is a string on all
 * four engines; the parity harness excludes these columns from comparison.
 */
const ts = z.string();
/** A date-granular column (`YYYY-MM-DD`), identical on every engine. */
const day = z.string();

/** `{ gx, gy, count }` — a screen/UV-space heatmap bin. */
const heatmapBinRow = z.object({ gx: int, gy: int, count: int });
/** `{ vx, vy, vz, count }` — an occupied voxel of a world-space heatmap. */
const voxelCountRow = z.object({ vx: int, vy: int, vz: int, count: int });
/** `{ cells, hits }` — un-truncated totals behind a top-N voxel list. */
const spatialStatsRow = z.object({ cells: int, hits: int });

// --- Reusable caveats -----------------------------------------------------

/** Continuous camera-pose capture is a sampling dial, not a census (ADR 0012). */
const CAMERA_SAMPLED =
  "`camera_sample` is a sampled channel (ADR 0012; ~1 Hz by default, idle samples suppressed). " +
  "Counts are proportional to dwell, not exact, and change scale if `sampleCameraMs` / " +
  "`sampling.camera` is retuned — compare shares, not absolute counts, across projects.";

/** Pointer movement is throttled; clicks are never dropped. */
const POINTER_SAMPLED =
  "`pointer_move` is throttled (`pointerMoveThrottleMs`, 250 ms by default, ADR 0012); " +
  "`pointer_click` is a discrete event and is never sampled.";

/** The gaze raycast is opt-in. */
const GAZE_OPT_IN =
  "Requires the gaze raycast capture option (`capture.gaze`, **off by default**, ADR 0030 / " +
  "ADR 0012). Without it `camera_sample` carries no `hitPoint` and this metric is empty.";

/**
 * Aggregates over an empty set are SQL-NULL, and a single-row summary still
 * returns its row when nothing matched. Shared by every metric whose columns can
 * therefore come back `null` on a fresh project or an over-narrow filter.
 */
const EMPTY_SET_NULLS =
  "Over a range or filter that matched no samples the row is still returned, with every " +
  "aggregate column `null` rather than `0` (only the plain counts stay numeric). Read `null` " +
  "as 'no data' — do not sum it as zero.";

/** Small-sample warning shared by per-row leaderboards. */
const SMALL_SAMPLE =
  "Rows backed by fewer than ~30 events are directional only — rank changes at that size are noise.";

/** Spatial cell size drives the shape of every voxel/bin result. */
const CELL_SIZE_SENSITIVE =
  "The result shape depends on `cellSize`: when it is omitted the collector derives it from the " +
  "selected scene's registered bounds or the `region` box (ADR 0040 §1), so voxel indices are " +
  "only comparable between calls that used the same effective cell size.";

/** Truncated top-N spatial lists need their `*_stats` companion for totals. */
const TRUNCATED_TOP_N =
  "Rows are the busiest cells only, capped by `limit`. Read the matching `*_stats` metric for the " +
  "true occupied-cell and hit totals before computing shares.";

/** Per-session then aggregate (ADR 0028) explanation. */
const PER_SESSION_THEN_AGGREGATE =
  "Computed per session and then aggregated across sessions (ADR 0028 §1), so neither a long " +
  "session nor a high-refresh device dominates the headline.";

/** Wall-clock projections are engine-formatted. */
const ENGINE_TIMESTAMPS =
  "`started_at` / `ended_at` are engine-formatted naive-UTC strings and are excluded from " +
  "cross-engine parity; derive durations from them, do not compare them byte-for-byte.";

/**
 * The metric registry: one entry per `build*` aggregation, plus the two
 * builder-less resource reads that are part of the agent surface.
 *
 * Declared with `satisfies` (not a type annotation) so each entry keeps its
 * literal `builder` type — which is what makes the compile-time coverage guard
 * at the bottom of this file work. The `Record<MetricId, …>` target makes a
 * missing metric a type error.
 */
export const METRIC_REGISTRY = {
  // =========================================================================
  // Sessions & orientation
  // =========================================================================
  list_sessions: {
    id: "list_sessions",
    title: "Recent sessions",
    description:
      "One row per session seen in the range: its id, the server-derived daily-rotating visitor " +
      "hash, how many events it produced, and its first/last event timestamps. The entry point " +
      "for 'what traffic did this project get' and for picking a session to drill into.",
    builder: "buildListSessions",
    endpoint: { method: "GET", path: "/api/v1/sessions" },
    grain: "session",
    dimensions: ["session"],
    filters: ["since", "until", "bins", "limit", "cameraMode", "format"],
    row: z.object({
      session_id: text,
      visitor_id: text,
      events: int,
      started_at: ts,
      ended_at: ts,
    }),
    columns: {
      session_id: { description: "Session identifier.", unit: "id", label: true },
      visitor_id: {
        description:
          "Server-side daily-rotating visitor hash (ADR 0003). Not stable across days, never a PII identifier.",
        unit: "id",
      },
      events: {
        description: "Events recorded for the session in range.",
        unit: "count",
        measure: true,
      },
      started_at: { description: "First event timestamp.", unit: "timestamp" },
      ended_at: { description: "Last event timestamp.", unit: "timestamp" },
    },
    limits: { maxRows: 1000, maxSummaryRows: 10 },
    interpretation:
      "Session length is `ended_at - started_at`; a very short span with a high `events` count is " +
      "a bursty load, the reverse is an idle tab. `visitor_id` rotates daily, so it identifies a " +
      "returning visitor within a day only.",
    caveats: [
      "`bins` is accepted by the shared range schema but ignored by this metric.",
      "Event counts scale with the capture fidelity dial (ADR 0012), so they are not comparable across projects with different sampling profiles.",
      ENGINE_TIMESTAMPS,
    ],
    sourceChannels: [],
    related: ["session_meta", "list_scenes", "timeseries"],
    comparable: { primary: "events", direction: "neutral", minSample: 30 },
    category: "sessions",
  },
  session_meta: {
    id: "session_meta",
    title: "Session descriptor",
    description:
      "The coarse descriptor for one session — start time, the device/graphics block reported at " +
      "`session_start`, the scene metadata and the app-supplied anonymous user descriptor. A " +
      "single-object resource read from the store, not an aggregation, and deliberately not the " +
      "raw event stream.",
    endpoint: { method: "GET", path: "/api/v1/sessions/:id/meta", pathParams: ["session"] },
    grain: "session",
    dimensions: ["session"],
    filters: [],
    row: z.object({
      sessionId: text,
      startedAt: ts.optional(),
      device: z.unknown().optional(),
      scene: z.unknown().optional(),
      user: z.unknown().optional(),
    }),
    columns: {
      sessionId: { description: "Session identifier.", unit: "id", label: true },
      startedAt: { description: "Session start time, when known.", unit: "timestamp" },
      device: {
        description:
          "Device/graphics block from `session_start` (engine, renderer, mobile flag, derived browser/OS).",
      },
      scene: {
        description: "Scene metadata from `session_start` (scene id, camera type, description).",
      },
      user: {
        description: "App-supplied anonymous user descriptor; absent unless the host app set one.",
      },
    },
    limits: { maxRows: 1, maxSummaryRows: 1 },
    interpretation:
      "Use it to attribute an outlier session (a bad FPS row, an abandoned XR session) to a device " +
      "or camera model before drawing a conclusion from it.",
    caveats: [
      "Returns 404 when the session id is unknown to the project.",
      "Carries no PII by default (ADR 0003); `user` holds only what the host app chose to attach.",
      "Not an aggregation — there is no `build*` builder, and it takes no time range.",
    ],
    sourceChannels: ["session_start"],
    related: ["list_sessions", "perf_by_device"],
    category: "sessions",
  },
  scene_representation: {
    id: "scene_representation",
    title: "Scene representation",
    description:
      "The registered proxy geometry for one scene (ADR 0014): its world bounds, up-axis and unit " +
      "scale, and the named proxy boxes when one was uploaded. A metadata resource read, not an " +
      "aggregation — it is what turns the voxel coordinates of the spatial metrics into named places.",
    endpoint: {
      method: "GET",
      path: "/api/v1/scenes/:sceneId/representation",
      pathParams: ["scene"],
    },
    grain: "scene",
    dimensions: ["scene"],
    filters: [],
    row: z.object({
      projectId: text,
      sceneId: text,
      label: text.nullable(),
      kind: text,
      upAxis: text,
      unitScale: num,
      bounds: z.array(num).nullable(),
      proxy: z.unknown().nullable(),
      assetUrl: text.nullable(),
      contentHash: text.nullable(),
      proxyVersion: int.nullable(),
      capturedAt: z.unknown().nullable(),
      updatedAt: z.unknown(),
    }),
    columns: {
      projectId: { description: "Owning project.", unit: "id" },
      sceneId: { description: "Developer-assigned scene id.", unit: "id", label: true },
      label: {
        description: "Human-friendly scene name, when the developer supplied one.",
        unit: "label",
      },
      kind: {
        description: "`proxy`, `asset` or `none` — what geometry is registered.",
        unit: "label",
      },
      upAxis: {
        description: "Canonical up axis of the stored geometry (`y` or `z`, ADR 0018).",
        unit: "label",
      },
      unitScale: { description: "World units per metre.", unit: "ratio" },
      bounds: {
        description: "Scene AABB `[minX,minY,minZ,maxX,maxY,maxZ]`, when known.",
        unit: "world-units",
      },
      proxy: { description: "Full proxy geometry (named boxes) when `kind` is `proxy`." },
      assetUrl: { description: "External asset URL when `kind` is `asset`." },
      contentHash: { description: "Content digest for cache validation.", unit: "id" },
      proxyVersion: { description: "Proxy wire-format version.", unit: "index" },
      capturedAt: { description: "When the geometry was captured.", unit: "timestamp" },
      updatedAt: { description: "When the registration was last written.", unit: "timestamp" },
    },
    limits: { maxRows: 1, maxSummaryRows: 1 },
    interpretation:
      "Read `bounds` before interpreting any voxel metric: it is what turns a voxel index into a " +
      "world position, and what a coverage percentage is measured against.",
    caveats: [
      "Returns 404 when the scene has no registration — spatial metrics still work, but their coordinates cannot be named.",
      "Registration is an explicit developer action (`scanSceneProxy` or the CLI); most projects have none at first.",
      "Not an aggregation — there is no `build*` builder, and it takes no time range.",
    ],
    sourceChannels: [],
    related: ["scene_coverage", "world_heatmap", "gaze_heatmap", "list_scenes"],
    category: "sessions",
  },
  list_scenes: {
    id: "list_scenes",
    title: "Active scenes",
    description:
      "The distinct developer-assigned scenes (ADR 0010) that saw activity in the range, with " +
      "their event count and most recent activity. One row per scene; the orientation query before " +
      "any scene-scoped question.",
    builder: "buildDistinctScenes",
    endpoint: { method: "GET", path: "/api/v1/scenes" },
    grain: "scene",
    dimensions: ["scene"],
    filters: ["since", "until", "limit", "format"],
    row: z.object({ scene_id: text, events: int, last_seen: ts }),
    columns: {
      scene_id: { description: "Developer-assigned scene id.", unit: "id", label: true },
      events: {
        description: "Events recorded for the scene in range.",
        unit: "count",
        measure: true,
      },
      last_seen: { description: "Most recent event timestamp for the scene.", unit: "timestamp" },
    },
    limits: { maxRows: 1000, maxSummaryRows: 10 },
    interpretation:
      "An app that never calls `setScene(...)` reports a single `default` scene (ADR 0010) — that " +
      "is not a bug, it means the app is not scene-tagged.",
    caveats: [
      "Event counts scale with the capture fidelity dial (ADR 0012), so a 'busy' scene may simply sample more.",
      ENGINE_TIMESTAMPS,
    ],
    sourceChannels: [],
    related: ["scene_representation", "perf_by_scene", "scene_retention"],
    comparable: { primary: "events", direction: "neutral", minSample: 50 },
    category: "sessions",
  },
  timeseries: {
    id: "timeseries",
    title: "Event volume over time",
    description:
      "Event volume bucketed into fixed `interval`-second windows, with the average FPS of any " +
      "`frame_perf` samples in the same bucket. One row per bucket: the shape of traffic with the " +
      "coarse perf trend beside it.",
    builder: "buildTimeseries",
    endpoint: { method: "GET", path: "/api/v1/timeseries" },
    grain: "bucket",
    dimensions: ["scene", "event_type"],
    filters: ["since", "until", "interval", "scene", "type", "format"],
    row: z.object({ bucket: int, events: int, avg_fps: num }),
    columns: {
      bucket: {
        description: "Bucket start as epoch milliseconds.",
        unit: "epoch-ms",
        label: true,
        axis: true,
      },
      events: { description: "Events in the bucket.", unit: "count", measure: true },
      avg_fps: {
        description:
          "Mean FPS of the `frame_perf` samples in the bucket; `0` when there were none.",
        unit: "fps",
      },
    },
    limits: { maxRows: 1000, maxSummaryRows: 8 },
    interpretation:
      "Read it as a trend, not a level. A bucket with no `frame_perf` samples reports `avg_fps` 0, " +
      "so treat a zero as 'no perf data', never as a stall.",
    caveats: [
      "Buckets are fixed width; a range shorter than one `interval` collapses to a single bucket.",
      "Volume scales with the capture fidelity dial (ADR 0012) — a rise can be a sampling change rather than traffic.",
      "`avg_fps` pools raw samples, so a chatty session dominates its bucket; use `perf_distribution` for an honest headline.",
    ],
    sourceChannels: ["frame_perf"],
    related: ["event_counts", "perf_distribution", "events_daily"],
    comparable: { primary: "events", direction: "neutral", minSample: 100 },
    category: "sessions",
  },
  event_counts: {
    id: "event_counts",
    title: "Counts per event type",
    description:
      "How many events of each type were recorded in the range, optionally for one scene. One row " +
      "per event type. The scene-health overview: error rate, context losses, focus/visibility " +
      "gaps and interaction volume all read off this single query.",
    builder: "buildEventTypeCounts",
    endpoint: { method: "GET", path: "/api/v1/event-counts" },
    grain: "row",
    dimensions: ["event_type", "scene"],
    filters: ["since", "until", "scene", "format"],
    row: z.object({ event_type: text, count: int }),
    columns: {
      event_type: {
        description: "Event type identifier from `@uptimizr/schema`.",
        unit: "label",
        label: true,
      },
      count: { description: "Events of that type in range.", unit: "count", measure: true },
    },
    limits: { maxRows: 100, maxSummaryRows: 10 },
    interpretation:
      "An event type missing from the result means that channel produced nothing — usually its " +
      "capture option is off (ADR 0012), not that the behaviour never happened. Check the absence " +
      "before concluding anything from it.",
    caveats: [
      "Continuous channels (`camera_sample`, `pointer_move`, `frame_perf`) dwarf discrete ones by construction; compare like with like.",
      "Counts scale with the capture fidelity dial (ADR 0012).",
    ],
    sourceChannels: [],
    related: ["timeseries", "stability_counts", "events_daily"],
    comparable: { primary: "count", direction: "neutral", minSample: 50 },
    category: "sessions",
  },
  events_daily: {
    id: "events_daily",
    title: "Daily event-count trend",
    description:
      "Per-day, per-event-type event counts read from the `events_daily` rollup. One row per " +
      "(day, event type). The long-horizon companion to `timeseries` for trend questions that " +
      "span weeks.",
    builder: "buildEventsDaily",
    grain: "bucket",
    dimensions: ["event_type"],
    filters: [],
    row: z.object({ day: day, event_type: text, events: int }),
    columns: {
      day: {
        description: "Calendar day (UTC) as `YYYY-MM-DD`.",
        unit: "label",
        label: true,
        axis: true,
      },
      event_type: { description: "Event type identifier.", unit: "label" },
      events: { description: "Events of that type on that day.", unit: "count", measure: true },
    },
    limits: { maxRows: 1000, maxSummaryRows: 10 },
    interpretation:
      "Day boundaries are UTC. The upper bound of the range is exclusive at date granularity, so " +
      "span a full day on either side when you want a specific day included.",
    caveats: [
      "No collector endpoint serves this builder today — it is reachable through the store / `QuerySpec` API only.",
      "On the OSS DuckDB store this is a query-time aggregation; on the ClickHouse scale tier it reads a materialized view whose counts are merged.",
      "Counts scale with the capture fidelity dial (ADR 0012).",
    ],
    sourceChannels: [],
    related: ["timeseries", "event_counts", "perf_daily"],
    comparable: { primary: "events", direction: "neutral", minSample: 100 },
    category: "sessions",
  },

  // =========================================================================
  // Attention & spatial
  // =========================================================================
  pointer_heatmap: {
    id: "pointer_heatmap",
    title: "2D pointer heatmap",
    description:
      "Screen-space pointer activity binned into a `bins × bins` grid over the normalized viewport. " +
      "One row per occupied cell. Answers 'where on screen do people point and click' — the classic " +
      "web heatmap, for a 3D canvas.",
    builder: "buildPointerHeatmap",
    endpoint: { method: "GET", path: "/api/v1/heatmaps/pointer" },
    grain: "bin",
    dimensions: ["scene", "session", "source", "cameraMode"],
    filters: [
      "since",
      "until",
      "bins",
      "limit",
      "scene",
      "session",
      "source",
      "cameraMode",
      "format",
    ],
    row: heatmapBinRow,
    columns: {
      gx: { description: "Horizontal cell index, `0 .. bins-1`.", unit: "index", label: true },
      gy: { description: "Vertical cell index, `0 .. bins-1`.", unit: "index" },
      count: { description: "Pointer events in the cell.", unit: "count", measure: true },
    },
    limits: { maxRows: 1000, maxSummaryRows: 8 },
    interpretation:
      "Cells are normalized viewport fractions, so the map is resolution-independent but not " +
      "aspect-ratio-independent — a scene played on phones and desktops mixes two framings in one " +
      "grid. Segment by `cameraMode` or `source` when that matters.",
    caveats: [
      POINTER_SAMPLED,
      "Covers `pointer_move` and `pointer_click` together, so dwell (moves) dominates intent (clicks). Use `dead_clicks` / `rage_clicks` for click-only questions.",
      "`limit` is accepted by the shared range schema but the builder returns every occupied cell up to its own cap.",
    ],
    sourceChannels: ["pointer_move", "pointer_click"],
    related: ["world_heatmap", "mesh_uv_heatmap", "click_rays", "top_meshes"],
    comparable: { primary: "count", direction: "neutral", minSample: 100 },
    category: "attention",
  },
  mesh_uv_heatmap: {
    id: "mesh_uv_heatmap",
    title: "Per-mesh UV (texture-space) heatmap",
    description:
      "Interaction hits on one object binned into a `bins × bins` grid over that object's own " +
      "`[0,1]` UV space (#149). One row per occupied cell. Answers 'which part of this product " +
      "model gets attention', independent of where the object sits in the scene.",
    builder: "buildMeshUvHeatmap",
    endpoint: { method: "GET", path: "/api/v1/heatmaps/mesh-uv" },
    grain: "bin",
    dimensions: ["scene", "session", "source", "mesh"],
    filters: ["since", "until", "bins", "limit", "scene", "session", "source", "mesh", "format"],
    row: heatmapBinRow,
    columns: {
      gx: { description: "U cell index, `0 .. bins-1`.", unit: "index", label: true },
      gy: { description: "V cell index, `0 .. bins-1`.", unit: "index" },
      count: { description: "Interaction hits in the cell.", unit: "count", measure: true },
    },
    limits: { maxRows: 1000, maxSummaryRows: 8 },
    interpretation:
      "The grid is the object's texture space, so it only reads meaningfully for a mesh with sane, " +
      "non-overlapping UVs. Overlapping UV islands fold distinct surfaces into one cell.",
    caveats: [
      "`mesh` is **required** — the metric is per-object by construction.",
      "`uv` rides in the event payload rather than a promoted column, so only events whose connector reported it participate.",
      "Counts `pointer_click`, `mesh_interaction` and `hover_dwell`; `hover_dwell` needs its opt-in capture option (ADR 0012).",
    ],
    sourceChannels: ["pointer_click", "mesh_interaction", "hover_dwell"],
    related: ["pointer_heatmap", "top_meshes", "mesh_interaction_kinds"],
    comparable: { primary: "count", direction: "neutral", minSample: 50 },
    category: "attention",
  },
  world_heatmap: {
    id: "world_heatmap",
    title: "3D world-space pointer heatmap",
    description:
      "Pointer raycast hit points voxel-binned into a uniform grid of `cellSize`-sized cubes. One " +
      "row per occupied voxel, busiest first. Answers 'where in the scene do people point and " +
      "click' in world coordinates rather than on screen.",
    builder: "buildWorldHeatmap",
    endpoint: { method: "GET", path: "/api/v1/heatmaps/world" },
    grain: "voxel",
    dimensions: ["scene", "source", "cameraMode"],
    filters: [
      "since",
      "until",
      "cellSize",
      "limit",
      "scene",
      "source",
      "cameraMode",
      "region",
      "format",
    ],
    row: voxelCountRow,
    columns: {
      vx: { description: "Voxel X index (`floor(x / cellSize)`).", unit: "index", label: true },
      vy: { description: "Voxel Y index.", unit: "index" },
      vz: { description: "Voxel Z index.", unit: "index" },
      count: { description: "Pointer hits in the voxel.", unit: "count", measure: true },
    },
    limits: { maxRows: 1000, maxSummaryRows: 8 },
    interpretation:
      "Multiply a voxel index by the effective `cellSize` to get its world corner. Pair with " +
      "`scene_representation` to name what is at a hotspot, and with `world_heatmap_stats` to know " +
      "what share of activity the returned voxels represent.",
    caveats: [CELL_SIZE_SENSITIVE, TRUNCATED_TOP_N, POINTER_SAMPLED],
    sourceChannels: ["pointer_move", "pointer_click"],
    related: ["world_heatmap_stats", "gaze_heatmap", "pointer_heatmap", "click_rays"],
    comparable: { primary: "count", direction: "neutral", minSample: 100 },
    category: "attention",
  },
  world_heatmap_stats: {
    id: "world_heatmap_stats",
    title: "World heatmap totals",
    description:
      "The un-truncated totals behind `world_heatmap` (ADR 0040 §3): how many voxels are occupied " +
      "and how many hits they hold, computed with no row cap. Always a single row.",
    builder: "buildWorldHeatmapStats",
    endpoint: { method: "GET", path: "/api/v1/heatmaps/world/stats" },
    grain: "project",
    dimensions: ["scene", "source", "cameraMode"],
    filters: ["since", "until", "cellSize", "scene", "source", "cameraMode", "region", "format"],
    row: spatialStatsRow,
    columns: {
      cells: { description: "Occupied voxels across the whole scene or region.", unit: "count" },
      hits: {
        description: "Total pointer hits across those voxels.",
        unit: "count",
        measure: true,
      },
    },
    limits: { maxRows: 1, maxSummaryRows: 1 },
    interpretation:
      "Use `hits` as the denominator when turning a truncated `world_heatmap` into shares, and " +
      "`cells` to say 'showing the top N of M occupied cells'.",
    caveats: [
      CELL_SIZE_SENSITIVE,
      "Must be called with exactly the same filters and `cellSize` as the `world_heatmap` it describes, or the totals do not match.",
    ],
    sourceChannels: ["pointer_move", "pointer_click"],
    related: ["world_heatmap"],
    category: "attention",
  },
  gaze_heatmap: {
    id: "gaze_heatmap",
    title: "World-space gaze heatmap",
    description:
      "Where the camera-forward (gaze) ray landed on real geometry, voxel-binned into a uniform " +
      "grid (ADR 0030). One row per occupied voxel, busiest first. This is 'what did people " +
      "actually look at', as opposed to what they clicked.",
    builder: "buildGazeHeatmap",
    endpoint: { method: "GET", path: "/api/v1/heatmaps/gaze" },
    grain: "voxel",
    dimensions: ["scene", "session", "cameraMode"],
    filters: [
      "since",
      "until",
      "cellSize",
      "limit",
      "scene",
      "session",
      "cameraMode",
      "region",
      "format",
    ],
    row: voxelCountRow,
    columns: {
      vx: { description: "Voxel X index.", unit: "index", label: true },
      vy: { description: "Voxel Y index.", unit: "index" },
      vz: { description: "Voxel Z index.", unit: "index" },
      count: { description: "Gaze hits in the voxel.", unit: "count", measure: true },
    },
    limits: { maxRows: 1000, maxSummaryRows: 8 },
    interpretation:
      "Gaze counts are dwell-weighted: each sample is one tick of looking, so a voxel's count is " +
      "roughly attention-seconds divided by the sample interval, not a number of visitors.",
    caveats: [
      GAZE_OPT_IN,
      CAMERA_SAMPLED,
      CELL_SIZE_SENSITIVE,
      TRUNCATED_TOP_N,
      "Gaze has no input source, so there is no `source` filter.",
    ],
    sourceChannels: ["camera_sample"],
    related: ["gaze_heatmap_stats", "world_heatmap", "camera_heatmap", "mesh_blind_spots"],
    comparable: { primary: "count", direction: "neutral", minSample: 100 },
    category: "attention",
  },
  gaze_heatmap_stats: {
    id: "gaze_heatmap_stats",
    title: "Gaze heatmap totals",
    description:
      "The un-truncated totals behind `gaze_heatmap` (ADR 0040 §3): occupied voxels and total gaze " +
      "hits, with no row cap. Always a single row.",
    builder: "buildGazeHeatmapStats",
    endpoint: { method: "GET", path: "/api/v1/heatmaps/gaze/stats" },
    grain: "project",
    dimensions: ["scene", "session", "cameraMode"],
    filters: ["since", "until", "cellSize", "scene", "session", "cameraMode", "region", "format"],
    row: spatialStatsRow,
    columns: {
      cells: {
        description: "Occupied gaze voxels across the whole scene or region.",
        unit: "count",
      },
      hits: { description: "Total gaze hits across those voxels.", unit: "count", measure: true },
    },
    limits: { maxRows: 1, maxSummaryRows: 1 },
    interpretation:
      "Use `hits` as the denominator for shares over a truncated `gaze_heatmap`, and `cells` for " +
      "coverage and cold-spot reasoning.",
    caveats: [
      GAZE_OPT_IN,
      CELL_SIZE_SENSITIVE,
      "Must be called with exactly the same filters and `cellSize` as the `gaze_heatmap` it describes.",
    ],
    sourceChannels: ["camera_sample"],
    related: ["gaze_heatmap"],
    category: "attention",
  },
  camera_heatmap: {
    id: "camera_heatmap",
    title: "View-direction heatmap",
    description:
      "Camera forward vectors binned by spherical angle into a `bins × bins` azimuth/elevation " +
      "grid. One row per occupied direction bin. The abstract 'which way did people look' dome — " +
      "it needs no scene geometry, so it works even without the gaze raycast.",
    builder: "buildCameraDirectionHeatmap",
    endpoint: { method: "GET", path: "/api/v1/heatmaps/camera" },
    grain: "bin",
    dimensions: ["scene", "session", "cameraMode"],
    filters: ["since", "until", "bins", "limit", "scene", "session", "cameraMode", "format"],
    row: z.object({ azimuth_bin: int, elevation_bin: int, count: int }),
    columns: {
      azimuth_bin: {
        description: "Horizontal angle bin from `atan2(z, x)`, `0 .. bins-1`.",
        unit: "index",
        label: true,
      },
      elevation_bin: {
        description: "Vertical angle bin from `asin(y / |v|)`, `0 .. bins-1`.",
        unit: "index",
      },
      count: { description: "Camera samples pointing into the bin.", unit: "count", measure: true },
    },
    limits: { maxRows: 1000, maxSummaryRows: 8 },
    interpretation:
      "Bins are equal-angle, not equal-area, so the poles (`elevation_bin` at either extreme) cover " +
      "less solid angle than the equator. Compare bins at similar elevations.",
    caveats: [
      CAMERA_SAMPLED,
      "Direction only — it says where people faced, not what was in front of them. Use `gaze_heatmap` for surfaces.",
      "An orbit/viewer scene concentrates direction around the orbit axis by construction; segment with `cameraMode`.",
    ],
    sourceChannels: ["camera_sample"],
    related: ["gaze_heatmap", "view_coverage_histogram", "flow_links"],
    comparable: { primary: "count", direction: "neutral", minSample: 100 },
    category: "attention",
  },
  view_coverage_histogram: {
    id: "view_coverage_histogram",
    title: "360° view-coverage histogram",
    description:
      "How much of the view dome each session actually looked at, bucketed across sessions (#146). " +
      "One row per 25-point coverage band. Answers 'how many visitors saw less than a quarter of " +
      "the product'.",
    builder: "buildViewCoverageHistogram",
    endpoint: { method: "GET", path: "/api/v1/coverage/view-histogram" },
    grain: "bucket",
    dimensions: ["scene", "session", "cameraMode"],
    filters: ["since", "until", "bins", "limit", "scene", "session", "cameraMode", "format"],
    row: z.object({ bucket: int, sessions: int }),
    columns: {
      bucket: {
        description:
          "Inclusive lower bound of the coverage band in percent (`0`, `25`, `50`, `75`).",
        unit: "percent",
        label: true,
        axis: true,
      },
      sessions: {
        description: "Sessions whose coverage fell in the band.",
        unit: "sessions",
        measure: true,
      },
    },
    limits: { maxRows: 4, maxSummaryRows: 4 },
    interpretation:
      "Coverage is the fraction of the `bins × bins` direction grid a session visited, so it is " +
      "relative to `bins`: a coarser grid makes every session look more thorough. Keep `bins` fixed " +
      "when comparing periods.",
    caveats: [
      CAMERA_SAMPLED,
      "A 100%-coverage session folds into the top (`75`) bucket rather than a fifth bucket.",
      "Very short sessions land in the `0` bucket simply for lack of samples, not for lack of interest.",
    ],
    sourceChannels: ["camera_sample"],
    related: ["camera_heatmap", "scene_coverage", "gaze_heatmap"],
    comparable: { primary: "sessions", direction: "neutral", minSample: 30 },
    category: "attention",
  },
  position_heatmap: {
    id: "position_heatmap",
    title: "Floor-plan camera-position heatmap",
    description:
      "Camera positions binned onto the X/Z ground plane in `cellSize`-sized cells, with the mean " +
      "height per cell (ADR 0026). One row per occupied cell, busiest first. The 'where do visitors " +
      "stand and linger' map for a walkable scene.",
    builder: "buildCameraPositionHeatmap",
    endpoint: { method: "GET", path: "/api/v1/heatmaps/position" },
    grain: "bin",
    dimensions: ["scene", "session", "cameraMode"],
    filters: [
      "since",
      "until",
      "cellSize",
      "limit",
      "scene",
      "session",
      "cameraMode",
      "region",
      "format",
    ],
    row: z.object({ gx: int, gz: int, avg_y: num, count: int }),
    columns: {
      gx: { description: "Ground cell X index.", unit: "index", label: true },
      gz: { description: "Ground cell Z index.", unit: "index" },
      avg_y: { description: "Mean camera height in the cell.", unit: "world-units" },
      count: { description: "Camera samples in the cell.", unit: "count", measure: true },
    },
    limits: { maxRows: 10000, maxSummaryRows: 8 },
    interpretation:
      "Because camera pose is sampled on a timer, `count` is dwell time in sample ticks — a bright " +
      "cell is where people stood still, not necessarily where most people walked. Cross-check " +
      "with `aggregate_paths` for flow.",
    caveats: [
      CAMERA_SAMPLED,
      CELL_SIZE_SENSITIVE,
      "Meaningless for an orbit/viewer scene, where the camera position is an artefact of the orbit — filter `cameraMode=first-person`.",
    ],
    sourceChannels: ["camera_sample"],
    related: ["aggregate_paths", "scene_coverage", "navigation_stats", "backtrack_ratio"],
    comparable: { primary: "count", direction: "neutral", minSample: 100 },
    category: "navigation",
  },
  session_trajectory: {
    id: "session_trajectory",
    title: "Session walked path",
    description:
      "One session's ordered camera positions, oldest first (ADR 0026). One row per sampled point. " +
      "The single-visitor path behind the crowd view in `aggregate_paths`.",
    builder: "buildSessionTrajectory",
    endpoint: {
      method: "GET",
      path: "/api/v1/sessions/:sessionId/trajectory",
      pathParams: ["session"],
    },
    grain: "row",
    dimensions: ["session", "scene"],
    filters: ["since", "until", "limit", "scene", "format"],
    row: z.object({ ts: int, x: num, y: num, z: num }),
    columns: {
      ts: {
        description:
          "Sample time as epoch milliseconds (the query projects `epochMs(ts)`, so this is a number even though `TrajectoryPointRow.ts` is declared `string` in `types.ts`).",
        unit: "epoch-ms",
        label: true,
      },
      x: { description: "Camera X in canonical world space.", unit: "world-units" },
      y: { description: "Camera Y (height).", unit: "world-units" },
      z: { description: "Camera Z.", unit: "world-units" },
    },
    limits: { maxRows: 10000, maxSummaryRows: 10 },
    interpretation:
      "Points are unbinned world positions in the canonical frame (ADR 0018). Gaps between " +
      "consecutive timestamps are dwell, not teleportation.",
    caveats: [
      CAMERA_SAMPLED,
      "The session id is a path parameter, not a querystring filter.",
      "Aggregate-safe: this is a pose track, not the raw event stream, and is not gated by `ENABLE_RAW_SESSION_RETENTION`.",
    ],
    sourceChannels: ["camera_sample"],
    related: ["aggregate_paths", "position_heatmap", "navigation_stats"],
    category: "navigation",
  },
  aggregate_paths: {
    id: "aggregate_paths",
    title: "Aggregate desire-line paths",
    description:
      "Every session's camera path binned onto the ground grid and returned as ordered, " +
      "session-keyed points (#73, ADR 0037). One row per (session, sampled point). Overlaying the " +
      "poly-lines makes the routes visitors actually walk self-reinforce into desire lines.",
    builder: "buildAggregateTrajectories",
    endpoint: { method: "GET", path: "/api/v1/paths" },
    grain: "row",
    dimensions: ["session", "scene", "cameraMode"],
    filters: ["since", "until", "cellSize", "limit", "scene", "cameraMode", "format"],
    row: z.object({ session_id: text, ts: int, gx: int, gz: int }),
    columns: {
      session_id: { description: "Session the point belongs to.", unit: "id", label: true },
      ts: {
        description:
          "Sample time as epoch milliseconds; order points by it per session. (The query projects `epochMs(ts)`, so this is a number even though `AggregateTrajectoryPointRow.ts` is declared `string` in `types.ts`.)",
        unit: "epoch-ms",
      },
      gx: { description: "Ground cell X index.", unit: "index" },
      gz: { description: "Ground cell Z index.", unit: "index" },
    },
    limits: { maxRows: 50000, maxSummaryRows: 10 },
    interpretation:
      "Group by `session_id`, order by `ts`, and de-duplicate consecutive identical cells — the " +
      "binning already removes sub-cell jitter, so repeated cells mean standing still.",
    caveats: [
      CAMERA_SAMPLED,
      CELL_SIZE_SENSITIVE,
      "No single-session filter by design — this is the crowd view; use `session_trajectory` for one visitor.",
      "The row cap truncates *points*, not sessions, so a busy range can return partial paths.",
    ],
    sourceChannels: ["camera_sample"],
    related: ["session_trajectory", "position_heatmap", "backtrack_ratio"],
    category: "navigation",
  },
  scene_coverage: {
    id: "scene_coverage",
    title: "Scene coverage / dead zones",
    description:
      "Camera *positions* voxel-binned into a uniform 3D grid. One row per occupied voxel with its " +
      "visit count. Exploration completeness and never-visited regions are computed by comparing " +
      "the occupied voxels against the scene's registered bounds.",
    builder: "buildSceneCoverage",
    endpoint: { method: "GET", path: "/api/v1/coverage" },
    grain: "voxel",
    dimensions: ["scene", "session"],
    filters: ["since", "until", "cellSize", "limit", "scene", "session", "format"],
    row: voxelCountRow,
    columns: {
      vx: { description: "Voxel X index.", unit: "index", label: true },
      vy: { description: "Voxel Y index.", unit: "index" },
      vz: { description: "Voxel Z index.", unit: "index" },
      count: { description: "Camera samples in the voxel.", unit: "count", measure: true },
    },
    limits: { maxRows: 10000, maxSummaryRows: 8 },
    interpretation:
      "'Coverage' is only a percentage once you divide the occupied voxel count by the voxel count " +
      "of the scene AABB — read `scene_representation` for the bounds. Without a registered scene " +
      "this metric shows visited volume but no denominator.",
    caveats: [
      CAMERA_SAMPLED,
      CELL_SIZE_SENSITIVE,
      "Positions, not gaze: a region can be well covered on foot and still never looked at.",
    ],
    sourceChannels: ["camera_sample"],
    related: ["scene_representation", "position_heatmap", "view_coverage_histogram"],
    comparable: { primary: "count", direction: "neutral", minSample: 100 },
    category: "navigation",
  },
  camera_distance: {
    id: "camera_distance",
    title: "Camera distance / zoom distribution",
    description:
      "Histogram of the distance from each camera sample to a reference point (by default the " +
      "world origin; pass the scene-AABB centre for a product view). One row per `bucketSize`-wide " +
      "distance band. A proxy for engagement intensity — how close visitors get to the subject.",
    builder: "buildCameraDistance",
    endpoint: { method: "GET", path: "/api/v1/camera/distance" },
    grain: "bucket",
    dimensions: ["scene", "session"],
    filters: [
      "since",
      "until",
      "centerX",
      "centerY",
      "centerZ",
      "bucketSize",
      "limit",
      "scene",
      "session",
      "format",
    ],
    row: z.object({ bucket: int, count: int }),
    columns: {
      bucket: {
        description:
          "Band index; the band covers `bucket * bucketSize` to `(bucket+1) * bucketSize`.",
        unit: "index",
        label: true,
        axis: true,
      },
      count: { description: "Camera samples in the band.", unit: "count", measure: true },
    },
    limits: { maxRows: 1000, maxSummaryRows: 8 },
    interpretation:
      "Distances are measured from the supplied `center`, which defaults to the origin — leaving it " +
      "unset in a scene whose subject is not at the origin makes the histogram meaningless.",
    caveats: [
      CAMERA_SAMPLED,
      "Bands are unlabelled; multiply by `bucketSize` to recover world units.",
      "A first-person scene spreads over many bands by construction; the metric is most informative for orbit/viewer scenes.",
    ],
    sourceChannels: ["camera_sample"],
    related: ["position_heatmap", "camera_gestures", "scene_coverage"],
    category: "navigation",
  },
  click_rays: {
    id: "click_rays",
    title: "View-gated click rays",
    description:
      "Each click aggregated into a ray from an origin voxel to the hit voxel, sharing the world " +
      "heatmap's grid. One row per (origin voxel, hit voxel, mesh). Shows not just *what* was " +
      "clicked but *from where* — the standpoint an interaction was made from.",
    builder: "buildClickGazeRay",
    endpoint: { method: "GET", path: "/api/v1/heatmaps/click-rays" },
    grain: "voxel",
    dimensions: ["scene", "session", "source", "mesh"],
    filters: ["since", "until", "cellSize", "limit", "scene", "source", "session", "format"],
    row: z.object({
      cam_vx: int,
      cam_vy: int,
      cam_vz: int,
      origin_x: num,
      origin_y: num,
      origin_z: num,
      hit_vx: int,
      hit_vy: int,
      hit_vz: int,
      hit_x: num,
      hit_y: num,
      hit_z: num,
      mesh: text,
      count: int,
    }),
    columns: {
      cam_vx: { description: "Origin voxel X index.", unit: "index" },
      cam_vy: { description: "Origin voxel Y index.", unit: "index" },
      cam_vz: { description: "Origin voxel Z index.", unit: "index" },
      origin_x: { description: "Mean origin X within the voxel.", unit: "world-units" },
      origin_y: { description: "Mean origin Y within the voxel.", unit: "world-units" },
      origin_z: { description: "Mean origin Z within the voxel.", unit: "world-units" },
      hit_vx: { description: "Hit voxel X index.", unit: "index" },
      hit_vy: { description: "Hit voxel Y index.", unit: "index" },
      hit_vz: { description: "Hit voxel Z index.", unit: "index" },
      hit_x: { description: "Mean hit X within the voxel.", unit: "world-units" },
      hit_y: { description: "Mean hit Y within the voxel.", unit: "world-units" },
      hit_z: { description: "Mean hit Z within the voxel.", unit: "world-units" },
      mesh: { description: "Clicked mesh name.", unit: "label", label: true },
      count: { description: "Clicks on this ray.", unit: "count", measure: true },
    },
    limits: { maxRows: 1000, maxSummaryRows: 8 },
    interpretation:
      "The origin is the true pointing origin: a pose source (XR controller, hand, gaze) supplies " +
      "its own ray origin, a flat pointer is un-projected onto the camera near plane (ADR 0043), " +
      "and anything else falls back to the nearest preceding camera position.",
    caveats: [
      CELL_SIZE_SENSITIVE,
      "Flat-pointer origins need the camera intrinsics (`fov`/`aspect`/`near`) on the joined camera sample; older data falls back to the camera position.",
      "Clicks with neither a ray, a reconstructable near-plane point, nor a camera origin are dropped entirely.",
      "The camera join is nearest-preceding-in-time, so a long `sampleCameraMs` makes the origin approximate.",
    ],
    sourceChannels: ["pointer_click", "camera_sample"],
    related: ["flow_links", "world_heatmap", "mesh_reachability", "top_meshes"],
    comparable: { primary: "count", direction: "neutral", minSample: 50 },
    category: "interaction",
  },
  flow_links: {
    id: "flow_links",
    title: "Gaze → mesh flow links",
    description:
      "Weighted links from a camera-direction bin to the mesh that was clicked while facing that " +
      "way. One row per (direction bin, mesh), or per (standpoint voxel, direction bin, mesh) in " +
      "position-aware mode. Connects where people looked from to what they acted on.",
    builder: "buildFlowHeatmap",
    endpoint: { method: "GET", path: "/api/v1/heatmaps/flow" },
    grain: "bin",
    dimensions: ["scene", "session", "mesh", "cameraMode"],
    filters: [
      "since",
      "until",
      "bins",
      "limit",
      "scene",
      "session",
      "cameraMode",
      "cellSize",
      "groupByOrigin",
      "originVoxel",
      "format",
    ],
    row: z.object({
      azimuth_bin: int,
      elevation_bin: int,
      mesh: text,
      count: int,
      origin_vx: int.optional(),
      origin_vy: int.optional(),
      origin_vz: int.optional(),
      origin_x: num.optional(),
      origin_y: num.optional(),
      origin_z: num.optional(),
    }),
    columns: {
      azimuth_bin: { description: "Horizontal view-direction bin.", unit: "index" },
      elevation_bin: { description: "Vertical view-direction bin.", unit: "index" },
      mesh: { description: "Clicked mesh name.", unit: "label", label: true },
      count: { description: "Clicks on this link.", unit: "count", measure: true },
      origin_vx: {
        description: "Standpoint voxel X index; present only in position-aware mode.",
        unit: "index",
      },
      origin_vy: {
        description: "Standpoint voxel Y index; position-aware mode only.",
        unit: "index",
      },
      origin_vz: {
        description: "Standpoint voxel Z index; position-aware mode only.",
        unit: "index",
      },
      origin_x: {
        description: "Mean standpoint X for the voxel; position-aware mode only.",
        unit: "world-units",
      },
      origin_y: {
        description: "Mean standpoint Y; position-aware mode only.",
        unit: "world-units",
      },
      origin_z: {
        description: "Mean standpoint Z; position-aware mode only.",
        unit: "world-units",
      },
    },
    limits: { maxRows: 1000, maxSummaryRows: 8 },
    interpretation:
      "Without `groupByOrigin` or `originVoxel` the six `origin_*` columns are absent and each row " +
      "is a pure direction→mesh link. Setting either adds the standpoint dimension and multiplies " +
      "the row count, so raise `limit` accordingly.",
    caveats: [
      "Clicks are ASOF-joined to the nearest preceding camera sample; a coarse `sampleCameraMs` blurs the direction attributed to a click.",
      "Only clicks that hit a mesh participate — empty-space clicks are the `dead_clicks` signal.",
      CELL_SIZE_SENSITIVE,
    ],
    sourceChannels: ["pointer_click", "camera_sample"],
    related: ["click_rays", "camera_heatmap", "top_meshes"],
    comparable: { primary: "count", direction: "neutral", minSample: 50 },
    category: "interaction",
  },

  // =========================================================================
  // Meshes & interaction
  // =========================================================================
  top_meshes: {
    id: "top_meshes",
    title: "Most-interacted meshes",
    description:
      "Meshes ranked by how many events referenced them. One row per mesh. The 3D analogue of a " +
      "top-pages report: which objects in the scene draw activity.",
    builder: "buildTopMeshes",
    endpoint: { method: "GET", path: "/api/v1/meshes/top" },
    grain: "mesh",
    dimensions: ["mesh", "session"],
    filters: ["since", "until", "bins", "limit", "session", "format"],
    row: z.object({ mesh: text, count: int }),
    columns: {
      mesh: { description: "Mesh / object name.", unit: "label", label: true },
      count: { description: "Events referencing the mesh.", unit: "count", measure: true },
    },
    limits: { maxRows: 1000, maxSummaryRows: 10 },
    interpretation:
      "This counts **every** mesh-referencing event, including passive gaze hits — so it measures " +
      "attention, not intent. Use `mesh_sources` for active interactions only, and " +
      "`mesh_interaction_kinds` for how people acted.",
    caveats: [
      "No scene filter on this builder; scope by time or session instead.",
      "Passive `camera_sample` gaze hits inflate the count when the gaze raycast is on (ADR 0030).",
      SMALL_SAMPLE,
      "`bins` is accepted by the shared range schema but ignored.",
    ],
    sourceChannels: ["mesh_interaction", "pointer_click", "camera_sample"],
    related: ["mesh_sources", "mesh_interaction_kinds", "mesh_dwell", "mesh_blind_spots"],
    comparable: { primary: "count", direction: "neutral", minSample: 30 },
    category: "interaction",
  },
  mesh_sources: {
    id: "mesh_sources",
    title: "Mesh interactions by input source",
    description:
      "The mesh leaderboard broken out by the input source that drove each interaction (#74, " +
      "ADR 0011). One row per (mesh, source). Scoped to **active** interactions, so passive gaze " +
      "never inflates popularity.",
    builder: "buildTopMeshesBySource",
    endpoint: { method: "GET", path: "/api/v1/meshes/sources" },
    grain: "mesh",
    dimensions: ["mesh", "source", "scene", "session", "cameraMode"],
    filters: [
      "since",
      "until",
      "bins",
      "limit",
      "scene",
      "session",
      "source",
      "cameraMode",
      "format",
    ],
    row: z.object({ mesh: text, source: text, count: int }),
    columns: {
      mesh: { description: "Mesh / object name.", unit: "label", label: true },
      source: { description: "Input source that drove the interaction.", unit: "label" },
      count: { description: "Active interactions for the pairing.", unit: "count", measure: true },
    },
    limits: { maxRows: 1000, maxSummaryRows: 10 },
    interpretation:
      "Summing a mesh's rows gives its active-interaction total — the honest 'most used object' " +
      "number, unlike `top_meshes` which also counts gaze.",
    caveats: [
      "Counts `mesh_interaction` and `pointer_click` only.",
      "A connector that never reports `source` groups everything under the realized default (`mouse`, ADR 0011).",
      SMALL_SAMPLE,
      "`bins` is accepted by the shared schema but ignored.",
    ],
    sourceChannels: ["mesh_interaction", "pointer_click"],
    related: ["top_meshes", "interaction_sources", "mesh_interaction_kinds"],
    comparable: { primary: "count", direction: "neutral", minSample: 30 },
    category: "interaction",
  },
  mesh_trend: {
    id: "mesh_trend",
    title: "Per-mesh interaction trend",
    description:
      "The active-interaction tally per mesh, bucketed into fixed `interval`-second windows (#74). " +
      "One row per (mesh, bucket), oldest bucket first — the per-mesh sparkline behind the " +
      "leaderboard.",
    builder: "buildTopMeshesTrend",
    endpoint: { method: "GET", path: "/api/v1/meshes/trend" },
    grain: "bucket",
    dimensions: ["mesh", "scene", "session", "source", "cameraMode"],
    filters: [
      "since",
      "until",
      "bins",
      "limit",
      "scene",
      "session",
      "source",
      "cameraMode",
      "interval",
      "format",
    ],
    row: z.object({ mesh: text, bucket: int, count: int }),
    columns: {
      mesh: { description: "Mesh / object name.", unit: "label", label: true },
      bucket: { description: "Window start as epoch milliseconds.", unit: "epoch-ms", axis: true },
      count: { description: "Active interactions in the window.", unit: "count", measure: true },
    },
    limits: { maxRows: 2000, maxSummaryRows: 10 },
    interpretation:
      "Order buckets per mesh and compare the recent half against the earlier half for a " +
      "rising/falling delta. Buckets with no interaction are absent, not zero-filled.",
    caveats: [
      "Counts `mesh_interaction` and `pointer_click` only (passive gaze excluded).",
      "The row cap truncates (mesh, bucket) pairs, so a wide range with many meshes can lose the tail of the trend.",
      SMALL_SAMPLE,
      "`bins` is accepted by the shared schema but ignored.",
    ],
    sourceChannels: ["mesh_interaction", "pointer_click"],
    related: ["top_meshes", "mesh_sources", "timeseries"],
    comparable: { primary: "count", direction: "neutral", minSample: 30 },
    category: "interaction",
  },
  mesh_dwell: {
    id: "mesh_dwell",
    title: "Per-object dwell / attention",
    description:
      "How long each object spent on screen and near the view centre, from `mesh_visibility` " +
      "summaries (#37). One row per mesh, ranked by total on-screen time. The 3D analogue of " +
      "time-on-element.",
    builder: "buildMeshDwell",
    endpoint: { method: "GET", path: "/api/v1/meshes/dwell" },
    grain: "mesh",
    dimensions: ["mesh", "scene", "session"],
    filters: ["since", "until", "bins", "limit", "scene", "session", "format"],
    row: z.object({
      mesh: text,
      visible_ms: num,
      centered_ms: num,
      max_screen_fraction: num,
      samples: int,
    }),
    columns: {
      mesh: { description: "Mesh / object name.", unit: "label", label: true },
      visible_ms: {
        description: "Total on-screen time across the range.",
        unit: "ms",
        measure: true,
      },
      centered_ms: {
        description: "Time the object was near the view centre (a gaze proxy).",
        unit: "ms",
      },
      max_screen_fraction: {
        description: "Largest screen fraction the object reached (prominence proxy), 0..1.",
        unit: "ratio",
      },
      samples: { description: "Bucketed visibility summaries behind the totals.", unit: "count" },
    },
    limits: { maxRows: 1000, maxSummaryRows: 10 },
    interpretation:
      "`centered_ms / visible_ms` is the share of on-screen time the object held the viewer's " +
      "attention rather than merely being in frame. High `visible_ms` with low `centered_ms` is " +
      "background scenery.",
    caveats: [
      "Requires the per-object dwell capture option (`capture.meshVisibility`, **off by default**, ADR 0012); without it the result is empty.",
      "Only objects the developer chose to track are reported — this is never the whole scene.",
      "Durations are bucketed summaries, not continuous timing; short glances below the bucket threshold are lost.",
    ],
    sourceChannels: ["mesh_visibility"],
    related: ["mesh_blind_spots", "hover_dwell", "top_meshes", "gaze_heatmap"],
    comparable: { primary: "visible_ms", direction: "neutral", minSample: 10 },
    category: "attention",
  },
  mesh_blind_spots: {
    id: "mesh_blind_spots",
    title: "Blind spots / never-noticed meshes",
    description:
      "Per mesh, how long it was visible against how much it was engaged with (#143). One row per " +
      "mesh that was seen at least once, most-seen-yet-least-touched first. A product detail with " +
      "high visibility and near-zero interaction is a blind spot.",
    builder: "buildMeshBlindSpots",
    endpoint: { method: "GET", path: "/api/v1/meshes/blind-spots" },
    grain: "mesh",
    dimensions: ["mesh", "scene", "session"],
    filters: ["since", "until", "bins", "limit", "scene", "session", "format"],
    row: z.object({
      mesh: text,
      visible_ms: num,
      vis_samples: int,
      interactions: int,
      hover_ms: num,
      hover_episodes: int,
    }),
    columns: {
      mesh: { description: "Mesh / object name.", unit: "label", label: true },
      visible_ms: {
        description: "Total on-screen time (> 0 by construction).",
        unit: "ms",
        measure: true,
      },
      vis_samples: { description: "Visibility summaries behind `visible_ms`.", unit: "count" },
      interactions: { description: "`mesh_interaction` events on the mesh.", unit: "count" },
      hover_ms: { description: "Hover-without-action time on the mesh.", unit: "ms" },
      hover_episodes: { description: "Hover hesitation episodes on the mesh.", unit: "count" },
    },
    limits: { maxRows: 1000, maxSummaryRows: 10 },
    interpretation:
      "Read `interactions + hover_episodes` as engagement and `visible_ms` as opportunity. The " +
      "blind spots are the rows at the top: plenty of opportunity, no engagement.",
    caveats: [
      "Requires the per-object dwell capture option (`capture.meshVisibility`, **off by default**); `hover_ms`/`hover_episodes` additionally need `capture.hoverDwell`.",
      "Only meshes with non-zero visibility appear — a mesh nobody ever rendered cannot be a blind spot here.",
      "Raw `pointer_click` is deliberately excluded (a mesh-hitting click already surfaces as a `mesh_interaction`).",
      SMALL_SAMPLE,
    ],
    sourceChannels: ["mesh_visibility", "mesh_interaction", "hover_dwell"],
    related: ["mesh_dwell", "hover_dwell", "top_meshes", "gaze_heatmap"],
    comparable: { primary: "interactions", direction: "up", minSample: 10 },
    category: "attention",
  },
  mesh_interaction_kinds: {
    id: "mesh_interaction_kinds",
    title: "Interaction kinds per mesh",
    description:
      "Per-mesh counts of each interaction *kind* — hover, pick, click, drag, select, squeeze, " +
      "grab, release, teleport (#72, ADR 0023). One row per (mesh, kind). Separates an object " +
      "that is merely hovered from one that is actually picked or dragged.",
    builder: "buildMeshInteractionKinds",
    endpoint: { method: "GET", path: "/api/v1/meshes/kinds" },
    grain: "mesh",
    dimensions: ["mesh", "name", "scene", "session", "source", "cameraMode"],
    filters: [
      "since",
      "until",
      "bins",
      "limit",
      "scene",
      "session",
      "source",
      "cameraMode",
      "format",
    ],
    row: z.object({ mesh: text, kind: text, count: int }),
    columns: {
      mesh: { description: "Mesh / object name.", unit: "label", label: true },
      kind: { description: "Interaction kind from `mesh_interaction.kind`.", unit: "label" },
      count: {
        description: "Interactions of that kind on the mesh.",
        unit: "count",
        measure: true,
      },
    },
    limits: { maxRows: 1000, maxSummaryRows: 10 },
    interpretation:
      "The mix matters more than the totals: a hover-only object looks interactive but is not being " +
      "used; a drag-heavy one is a manipulator.",
    caveats: [
      "`mesh_interaction` only — a `pointer_click` that hit a mesh but produced no interaction event is not counted.",
      "Which kinds a connector emits is engine-specific (ADR 0023); an absent kind may mean 'not emitted', not 'never done'.",
      SMALL_SAMPLE,
      "`bins` is accepted by the shared schema but ignored.",
    ],
    sourceChannels: ["mesh_interaction"],
    related: ["top_meshes", "mesh_sources", "hover_dwell"],
    comparable: { primary: "count", direction: "neutral", minSample: 30 },
    category: "interaction",
  },
  mesh_reachability: {
    id: "mesh_reachability",
    title: "Mesh reachability by distance",
    description:
      "How far each interacted mesh sat from where the visitor actually stood (#151). One row per " +
      "(mesh, distance band) with the mean distance in the band. Meshes whose interactions cluster " +
      "in far bands are consistently reached from an uncomfortable range.",
    builder: "buildReachability",
    endpoint: { method: "GET", path: "/api/v1/meshes/reachability" },
    grain: "mesh",
    dimensions: ["mesh", "scene", "session", "source", "cameraMode"],
    filters: [
      "since",
      "until",
      "bins",
      "limit",
      "scene",
      "session",
      "source",
      "cameraMode",
      "bucketSize",
      "format",
    ],
    row: z.object({ mesh: text, bucket: int, count: int, avg_distance: num }),
    columns: {
      mesh: { description: "Mesh / object name.", unit: "label", label: true },
      bucket: {
        description:
          "Distance band index; covers `bucket * bucketSize` to `(bucket+1) * bucketSize`.",
        unit: "index",
      },
      count: { description: "Interactions in the band.", unit: "count", measure: true },
      avg_distance: {
        description: "Mean standpoint→hit distance within the band.",
        unit: "world-units",
      },
    },
    limits: { maxRows: 10000, maxSummaryRows: 10 },
    interpretation:
      "Actionable for VR UI placement and first-person layout: an object whose mass sits beyond " +
      "arm's reach either needs moving or needs a ranged affordance.",
    caveats: [
      "Only `mesh_interaction` events that carry a world hit point participate.",
      "The standpoint is the nearest **preceding** camera sample; interactions with no camera sample in range are dropped entirely.",
      CAMERA_SAMPLED,
      "`source` constrains the interaction side only — a camera sample's source is the realized default (ADR 0011).",
    ],
    sourceChannels: ["mesh_interaction", "camera_sample"],
    related: ["click_rays", "top_meshes", "xr_sources"],
    comparable: { primary: "avg_distance", direction: "down", minSample: 30 },
    category: "interaction",
  },
  dead_clicks: {
    id: "dead_clicks",
    title: "Dead-click rate",
    description:
      "Of all clicks in the range, how many hit nothing at all (#46). Always a single row. A high " +
      "dead-click share is a 3D discoverability problem: visitors click where they expect something " +
      "interactive and get no response.",
    builder: "buildDeadClicks",
    endpoint: { method: "GET", path: "/api/v1/clicks/dead" },
    grain: "project",
    dimensions: ["scene", "session", "source", "cameraMode"],
    filters: [
      "since",
      "until",
      "bins",
      "limit",
      "scene",
      "session",
      "source",
      "cameraMode",
      "format",
    ],
    row: z.object({ total_clicks: int, dead_clicks: intOrNull }),
    columns: {
      total_clicks: { description: "Clicks in scope.", unit: "count" },
      dead_clicks: {
        description: "Clicks whose hit test missed every mesh.",
        unit: "count",
        measure: true,
        rateOf: "total_clicks",
      },
    },
    limits: { maxRows: 1, maxSummaryRows: 1 },
    interpretation:
      "The rate is `dead_clicks / total_clicks`. Some background clicking is normal in an orbit " +
      "scene (people click empty space to deselect); the signal is a *change* in the rate or an " +
      "unusually high rate in a scene meant to be clicked.",
    caveats: [
      EMPTY_SET_NULLS,
      "Clicks are never sampled, so this rate is exact for the captured sessions.",
      "A scene with no pickable geometry registered will report a 100% dead rate — check `top_meshes` is non-empty first.",
      "Fewer than ~50 clicks makes the rate too noisy to act on.",
    ],
    sourceChannels: ["pointer_click"],
    related: ["rage_clicks", "hover_dwell", "top_meshes", "pointer_heatmap"],
    comparable: { primary: "dead_clicks", direction: "down", minSample: 50 },
    category: "interaction",
  },
  rage_clicks: {
    id: "rage_clicks",
    title: "Rage-click clusters",
    description:
      "Rapid repeated clicks on the same mesh inside one time window (#47) — the 'I keep clicking " +
      "and nothing happens' frustration signal. One row per (session, mesh, window) that reached " +
      "`minRepeats`, biggest burst first.",
    builder: "buildRageClicks",
    endpoint: { method: "GET", path: "/api/v1/clicks/rage" },
    grain: "row",
    dimensions: ["session", "mesh", "scene", "source", "cameraMode"],
    filters: [
      "since",
      "until",
      "bins",
      "limit",
      "scene",
      "session",
      "source",
      "cameraMode",
      "interval",
      "minRepeats",
      "format",
    ],
    row: z.object({ session_id: text, mesh: text, bucket: int, clicks: int }),
    columns: {
      session_id: { description: "Session the burst happened in.", unit: "id" },
      mesh: { description: "Mesh that was clicked repeatedly.", unit: "label", label: true },
      bucket: { description: "Window start as epoch milliseconds.", unit: "epoch-ms" },
      clicks: {
        description: "Clicks on the mesh within the window.",
        unit: "count",
        measure: true,
      },
    },
    limits: { maxRows: 1000, maxSummaryRows: 10 },
    interpretation:
      "Rows are bursts, not visitors: one frustrated session can produce several. Count distinct " +
      "`session_id` values before claiming how many people were affected.",
    caveats: [
      "Only clicks that *hit* a mesh count; rapid clicking on empty space is `dead_clicks`.",
      "Windows are fixed-width buckets, so a burst straddling a boundary can split into two smaller clusters that both fall below `minRepeats`.",
      "Legitimate rapid clicking (a rotate-by-clicking control, a rapid-fire game) reads as rage here — check the mesh's role.",
    ],
    sourceChannels: ["pointer_click"],
    related: ["dead_clicks", "hover_dwell", "mesh_interaction_kinds"],
    comparable: { primary: "clicks", direction: "down", minSample: 10 },
    category: "interaction",
  },
  hover_dwell: {
    id: "hover_dwell",
    title: "Hover hesitation per object",
    description:
      "Per mesh, how long visitors lingered on an object *without clicking it*, over how many " +
      "episodes, and the longest single hover (#48). One row per mesh. High dwell with few " +
      "interactions flags objects that look interactive but are not.",
    builder: "buildHoverDwell",
    endpoint: { method: "GET", path: "/api/v1/hover/dwell" },
    grain: "mesh",
    dimensions: ["mesh", "scene", "session", "source", "cameraMode"],
    filters: [
      "since",
      "until",
      "bins",
      "limit",
      "scene",
      "session",
      "source",
      "cameraMode",
      "format",
    ],
    row: z.object({ mesh: text, dwell_ms: num, max_dwell_ms: num, episodes: int }),
    columns: {
      mesh: { description: "Mesh / object name.", unit: "label", label: true },
      dwell_ms: { description: "Total hover-without-action time.", unit: "ms", measure: true },
      max_dwell_ms: { description: "Longest single hover episode.", unit: "ms" },
      episodes: { description: "Hover episodes contributing to the totals.", unit: "count" },
    },
    limits: { maxRows: 1000, maxSummaryRows: 10 },
    interpretation:
      "`dwell_ms / episodes` is the average hesitation. A long average on an object that is not " +
      "meant to be interactive is a false affordance; on one that is, it is a discoverability gap.",
    caveats: [
      "Requires the hover-hesitation capture option (`capture.hoverDwell`, **off by default**, ADR 0012); without it the result is empty.",
      "Hover is a flat-pointer concept; XR sources rarely produce it.",
      "One bucketed episode is emitted per hover, so sub-threshold glances are not counted.",
    ],
    sourceChannels: ["hover_dwell"],
    related: ["mesh_blind_spots", "dead_clicks", "mesh_dwell", "mesh_interaction_kinds"],
    comparable: { primary: "dwell_ms", direction: "down", minSample: 10 },
    category: "attention",
  },
  interaction_sources: {
    id: "interaction_sources",
    title: "Interactions by input source",
    description:
      "For every interaction event that carries an input source, how many fired per (event type, " +
      "source) and across how many distinct sessions (ADR 0011). One row per pairing. Turns " +
      "`source` from a filter into the modality mix of the audience.",
    builder: "buildInteractionsBySource",
    endpoint: { method: "GET", path: "/api/v1/interactions/sources" },
    grain: "row",
    dimensions: ["event_type", "source", "scene", "session", "cameraMode"],
    filters: [
      "since",
      "until",
      "bins",
      "limit",
      "scene",
      "session",
      "source",
      "cameraMode",
      "format",
    ],
    row: z.object({ event_type: text, source: text, count: int, sessions: int }),
    columns: {
      event_type: { description: "The interaction event type.", unit: "label" },
      source: { description: "Input source that triggered it.", unit: "label", label: true },
      count: { description: "Events for the pairing.", unit: "count", measure: true },
      sessions: { description: "Distinct sessions that produced the pairing.", unit: "sessions" },
    },
    limits: { maxRows: 1000, maxSummaryRows: 10 },
    interpretation:
      "Compare `sessions` as well as `count`: a single power user on a gamepad can dominate `count` " +
      "while representing one visitor.",
    caveats: [
      "Only events that carry a non-empty `source` participate.",
      "A connector that does not report `source` realizes the `mouse` default (ADR 0011), so a flat-only project looks 100% mouse by construction.",
      SMALL_SAMPLE,
    ],
    sourceChannels: ["pointer_click", "pointer_move", "mesh_interaction", "input_action"],
    related: ["xr_sources", "mesh_sources", "top_input_actions"],
    comparable: { primary: "count", direction: "neutral", minSample: 30 },
    category: "interaction",
  },
  top_input_actions: {
    id: "top_input_actions",
    title: "Most-used shortcuts and actions",
    description:
      "App-level `input_action` labels — bound keyboard chords and gamepad buttons — ranked by how " +
      "often they fired, split by input source (#75, ADR 0023). One row per (action, source).",
    builder: "buildTopInputActions",
    endpoint: { method: "GET", path: "/api/v1/input-actions/top" },
    grain: "row",
    dimensions: ["name", "source", "scene", "session", "cameraMode"],
    filters: [
      "since",
      "until",
      "bins",
      "limit",
      "scene",
      "session",
      "source",
      "cameraMode",
      "format",
    ],
    row: z.object({ action: text, source: text, count: int }),
    columns: {
      action: {
        description: "Developer-assigned action label, e.g. `rotate-left`.",
        unit: "label",
        label: true,
      },
      source: { description: "Input source (keyboard, gamepad, …).", unit: "label" },
      count: { description: "Times the action fired.", unit: "count", measure: true },
    },
    limits: { maxRows: 1000, maxSummaryRows: 10 },
    interpretation:
      "Only actions the developer explicitly bound are captured, so the leaderboard is a view of " +
      "the *designed* shortcut surface — an absent action means it was never bound, not never used.",
    caveats: [
      "Keyboard capture is off unless `keyBindings` are supplied (privacy, ADR 0003/0023): arbitrary typing is never recorded.",
      SMALL_SAMPLE,
      "`bins` is accepted by the shared schema but ignored.",
    ],
    sourceChannels: ["input_action"],
    related: ["interaction_sources", "camera_gestures"],
    comparable: { primary: "count", direction: "neutral", minSample: 30 },
    category: "interaction",
  },
  camera_gestures: {
    id: "camera_gestures",
    title: "Camera navigation gestures",
    description:
      "How often visitors moved the viewpoint and for how long, per gesture kind — orbit, pan, " +
      "dolly, zoom, roll, fly, navigate (ADR 0025). One row per kind. Separates deliberate " +
      "navigation intent from object selection.",
    builder: "buildCameraGestures",
    endpoint: { method: "GET", path: "/api/v1/camera-gestures" },
    grain: "row",
    dimensions: ["name", "scene", "session", "source", "cameraMode"],
    filters: [
      "since",
      "until",
      "bins",
      "limit",
      "scene",
      "session",
      "source",
      "cameraMode",
      "format",
    ],
    row: z.object({ kind: text, gestures: int, total_ms: num, avg_ms: num, max_ms: num }),
    columns: {
      kind: { description: "Gesture class.", unit: "label", label: true },
      gestures: { description: "Gestures of this kind.", unit: "count", measure: true },
      total_ms: { description: "Total time spent in this gesture kind.", unit: "ms" },
      avg_ms: { description: "Mean gesture duration.", unit: "ms" },
      max_ms: { description: "Longest single gesture.", unit: "ms" },
    },
    limits: { maxRows: 1000, maxSummaryRows: 10 },
    interpretation:
      "A high orbit/pan share with little dolly means people are circling but not inspecting; heavy " +
      "`fly` in an XR session is the smooth-locomotion discomfort risk (see `xr_locomotion`).",
    caveats: [
      "Gesture capture is on by default, but classification sensitivity is tunable (`cameraGestureSensitivity`), so counts are not comparable across differently-tuned apps.",
      "A click that does not move the camera emits no gesture — absence is not inactivity.",
      "A teleport emits both a `fly` gesture and a `teleport` interaction (ADR 0025); do not double-count.",
    ],
    sourceChannels: ["camera_gesture"],
    related: ["xr_locomotion", "navigation_stats", "camera_distance", "top_input_actions"],
    comparable: { primary: "gestures", direction: "neutral", minSample: 30 },
    category: "navigation",
  },
  navigation_stats: {
    id: "navigation_stats",
    title: "Navigation effort per session",
    description:
      "Per session, how far the camera travelled and how much of that travel was active rather " +
      "than idle dwell. One row per session. A high segment count with low active distance flags a " +
      "stuck or lost visitor.",
    builder: "buildNavigationStats",
    endpoint: { method: "GET", path: "/api/v1/navigation" },
    grain: "session",
    dimensions: ["session", "scene"],
    filters: ["since", "until", "moveThreshold", "limit", "scene", "session", "format"],
    row: z.object({
      session_id: text,
      segments: int,
      total_distance: num,
      active_segments: int,
      active_distance: num,
    }),
    columns: {
      session_id: { description: "Session identifier.", unit: "id", label: true },
      segments: { description: "Inter-sample segments in the session.", unit: "count" },
      total_distance: { description: "Total path length.", unit: "world-units", measure: true },
      active_segments: {
        description: "Segments whose distance cleared `moveThreshold`.",
        unit: "count",
        rateOf: "segments",
      },
      active_distance: {
        description: "Path length across active segments only.",
        unit: "world-units",
      },
    },
    limits: { maxRows: 1000, maxSummaryRows: 10 },
    interpretation:
      "`active_segments / segments` is the share of the session spent moving. Distances are in " +
      "world units and only comparable within one scene's scale.",
    caveats: [
      CAMERA_SAMPLED,
      "Distance is the sum of straight lines between samples, so it under-reports curved paths and over-reports teleports.",
      "`moveThreshold` defines idle; change it and every number moves.",
    ],
    sourceChannels: ["camera_sample"],
    related: ["backtrack_ratio", "aggregate_paths", "position_heatmap", "camera_gestures"],
    comparable: { primary: "total_distance", direction: "neutral", minSample: 10 },
    category: "navigation",
  },
  backtrack_ratio: {
    id: "backtrack_ratio",
    title: "Path retrace / backtracking",
    description:
      "Per scene, the share of coarse-grid cell entries that re-entered an already-visited cell " +
      "(#153). One row per scene. A high ratio flags a dead end, a missed cue, or a puzzle that is " +
      "not reading clearly.",
    builder: "buildBacktrackRatio",
    endpoint: { method: "GET", path: "/api/v1/backtrack" },
    grain: "scene",
    dimensions: ["scene", "session"],
    filters: ["since", "until", "cellSize", "limit", "scene", "session", "format"],
    row: z.object({
      scene: text,
      sessions: int,
      entries: int,
      revisits: int,
      backtrack_ratio: num,
    }),
    columns: {
      scene: {
        description: "Scene the counts are pooled over; may be empty.",
        unit: "id",
        label: true,
      },
      sessions: {
        description: "Distinct sessions that entered any cell in the scene.",
        unit: "sessions",
      },
      entries: { description: "Cell entries (consecutive dwell collapsed).", unit: "count" },
      revisits: {
        description: "Entries into an already-visited cell.",
        unit: "count",
        rateOf: "entries",
      },
      backtrack_ratio: {
        description: "`revisits / entries` in [0, 1); higher means more re-walking.",
        unit: "ratio",
        measure: true,
      },
    },
    limits: { maxRows: 1000, maxSummaryRows: 10 },
    interpretation:
      "This is a coarse-grid revisit proxy, not true reverse-segment retracing: standing still " +
      "never counts, but circling a landmark does. Compare scenes at the same `cellSize`.",
    caveats: [
      CAMERA_SAMPLED,
      CELL_SIZE_SENSITIVE,
      "A small `cellSize` inflates the ratio (more cells to re-enter); a large one hides it.",
      "Meaningless for orbit/viewer scenes, where the camera revisits by construction.",
    ],
    sourceChannels: ["camera_sample"],
    related: ["navigation_stats", "aggregate_paths", "position_heatmap"],
    comparable: { primary: "backtrack_ratio", direction: "down", minSample: 30 },
    category: "navigation",
  },

  // =========================================================================
  // Performance
  // =========================================================================
  perf_summary: {
    id: "perf_summary",
    title: "Rendering performance summary",
    description:
      "The pooled FPS headline over the range: how many `frame_perf` samples were seen and their " +
      "average, minimum and median FPS. Always a single row. The quickest 'is this scene smooth' " +
      "check.",
    builder: "buildPerfSummary",
    endpoint: { method: "GET", path: "/api/v1/perf" },
    grain: "project",
    dimensions: ["session"],
    filters: ["since", "until", "bins", "limit", "session", "format"],
    row: z.object({ samples: int, avg_fps: numOrNull, min_fps: numOrNull, p50_fps: numOrNull }),
    columns: {
      samples: { description: "`frame_perf` samples in scope.", unit: "count" },
      avg_fps: { description: "Mean FPS across samples.", unit: "fps", measure: true },
      min_fps: { description: "Worst single sample.", unit: "fps" },
      p50_fps: { description: "Median FPS across samples.", unit: "fps" },
    },
    limits: { maxRows: 1, maxSummaryRows: 1 },
    interpretation:
      "Samples are pooled, so a long or high-refresh session dominates. For a headline that treats " +
      "each visitor equally, use `perf_distribution`; for the resolution behind the number, " +
      "`render_scale_truth`.",
    caveats: [
      EMPTY_SET_NULLS,
      "`frame_perf` is a sampled channel (`samplePerfMs`, 2 s by default, ADR 0012); `min_fps` is the worst *sampled* frame, not the worst frame.",
      "No scene filter on this builder — scope by session or use `perf_by_scene`.",
      "A healthy average can hide adaptive down-scaling; check `render_scale_truth`.",
      "Fewer than ~30 samples makes every number here unreliable.",
    ],
    sourceChannels: ["frame_perf"],
    related: ["perf_distribution", "render_scale_truth", "jank_rate", "perf_by_scene"],
    comparable: { primary: "p50_fps", direction: "up", minSample: 30 },
    category: "performance",
  },
  render_scale_truth: {
    id: "render_scale_truth",
    title: "Render-scale truth",
    description:
      "The FPS headline paired with the resolution the engine actually rendered at (#71, ADR 0021). " +
      "Always a single row. A scene can report a healthy frame rate only because an adaptive " +
      "renderer quietly dropped the render scale below 1.",
    builder: "buildRenderScaleTruth",
    endpoint: { method: "GET", path: "/api/v1/perf/render-scale" },
    grain: "project",
    dimensions: ["session"],
    filters: ["since", "until", "bins", "limit", "session", "format"],
    row: z.object({
      samples: int,
      avg_fps: numOrNull,
      p50_fps: numOrNull,
      avg_render_scale: numOrNull,
      p50_render_scale: numOrNull,
      downscaled_samples: intOrNull,
      scale_samples: intOrNull,
    }),
    columns: {
      samples: { description: "`frame_perf` samples in scope.", unit: "count" },
      avg_fps: { description: "Mean FPS across samples.", unit: "fps" },
      p50_fps: { description: "Median FPS across samples.", unit: "fps", measure: true },
      avg_render_scale: {
        description: "Mean reported render scale; `null` when nothing reported one.",
        unit: "ratio",
      },
      p50_render_scale: {
        description: "Median reported render scale; `null` when nothing reported one.",
        unit: "ratio",
      },
      downscaled_samples: {
        description: "Reported samples that rendered below native resolution.",
        unit: "count",
        rateOf: "scale_samples",
      },
      scale_samples: { description: "Samples that reported a render scale at all.", unit: "count" },
    },
    limits: { maxRows: 1, maxSummaryRows: 1 },
    interpretation:
      "The downscaled share is `downscaled_samples / scale_samples` — it is deliberately left to " +
      "the caller so it stays integer-exact across engines. A high share next to a good FPS means " +
      "the frame rate was bought with pixels.",
    caveats: [
      EMPTY_SET_NULLS,
      "`scale_samples` is 0 when no connector reported a render scale; both scale columns are then `null` and the share is undefined.",
      "`frame_perf` is a sampled channel (ADR 0012).",
      "No scene filter on this builder.",
    ],
    sourceChannels: ["frame_perf"],
    related: ["perf_summary", "perf_distribution", "capability_changes"],
    comparable: { primary: "p50_render_scale", direction: "up", minSample: 30 },
    category: "performance",
  },
  perf_distribution: {
    id: "perf_distribution",
    title: "FPS distribution (per-session)",
    description:
      "FPS percentiles computed per session and then aggregated (ADR 0028 §1): the median across " +
      "sessions of each session's p05 / p50 / p95. Always a single row. The honest smoothness " +
      "headline — one visitor, one vote.",
    builder: "buildPerfDistribution",
    endpoint: { method: "GET", path: "/api/v1/perf/distribution" },
    grain: "project",
    dimensions: ["scene", "session"],
    filters: ["since", "until", "bins", "limit", "scene", "session", "format"],
    row: z.object({
      sessions: int,
      samples: intOrNull,
      p05_fps: numOrNull,
      p50_fps: numOrNull,
      p95_fps: numOrNull,
    }),
    columns: {
      sessions: { description: "Sessions contributing a percentile.", unit: "sessions" },
      samples: { description: "Total `frame_perf` samples behind them.", unit: "count" },
      p05_fps: { description: "Median across sessions of each session's p05 FPS.", unit: "fps" },
      p50_fps: {
        description: "Median across sessions of each session's median FPS.",
        unit: "fps",
        measure: true,
      },
      p95_fps: { description: "Median across sessions of each session's p95 FPS.", unit: "fps" },
    },
    limits: { maxRows: 1, maxSummaryRows: 1 },
    interpretation:
      "`p05_fps` is the 'bad moments' number and the one users feel; `p50_fps` is the typical " +
      "experience. A wide p05→p95 spread means inconsistent frame pacing, which reads worse than a " +
      "steadily lower frame rate.",
    caveats: [
      EMPTY_SET_NULLS,
      PER_SESSION_THEN_AGGREGATE,
      "These are medians of per-session percentiles, not global percentiles — they do not describe the worst sessions. Use `jank_rate`'s worst-decile for that.",
      "Fewer than ~20 sessions makes the medians unstable.",
      "`frame_perf` is a sampled channel (ADR 0012).",
    ],
    sourceChannels: ["frame_perf"],
    related: ["perf_summary", "fps_histogram", "frame_time_percentiles", "jank_rate"],
    comparable: { primary: "p50_fps", direction: "up", minSample: 20 },
    category: "performance",
  },
  fps_histogram: {
    id: "fps_histogram",
    title: "Per-session median-FPS histogram",
    description:
      "How many sessions fell into each FPS band, where a session contributes a single data point " +
      "— its median FPS (ADR 0028 §1). One row per `bucket`-wide band. Answers 'how many " +
      "*experiences* were smooth', not how many frames.",
    builder: "buildFpsHistogram",
    endpoint: { method: "GET", path: "/api/v1/perf/fps-histogram" },
    grain: "bucket",
    dimensions: ["scene", "session"],
    filters: ["since", "until", "bins", "limit", "scene", "session", "bucket", "format"],
    row: z.object({ bucket: int, sessions: int }),
    columns: {
      bucket: {
        description: "Inclusive lower bound of the FPS bin.",
        unit: "fps",
        label: true,
        axis: true,
      },
      sessions: {
        description: "Sessions whose median FPS fell in the bin.",
        unit: "sessions",
        measure: true,
      },
    },
    limits: { maxRows: 100, maxSummaryRows: 8 },
    interpretation:
      "A bimodal shape is the classic desktop-vs-mobile split — confirm it with `perf_by_device` " +
      "rather than treating the average as representative of either group.",
    caveats: [
      "Bins are `bucket` FPS wide (default 10) and empty bins are absent, not zero-filled.",
      PER_SESSION_THEN_AGGREGATE,
      "Fewer than ~20 sessions makes the shape meaningless.",
    ],
    sourceChannels: ["frame_perf"],
    related: ["perf_distribution", "perf_by_device", "perf_by_scene"],
    comparable: { primary: "sessions", direction: "neutral", minSample: 20 },
    category: "performance",
  },
  frame_time_percentiles: {
    id: "frame_time_percentiles",
    title: "Frame-time percentiles",
    description:
      "Frame cost in milliseconds, computed per session then aggregated (ADR 0028 §1): the typical " +
      "frame and the tail. Always a single row. Milliseconds are the budget developers actually " +
      "work in — FPS is the reciprocal.",
    builder: "buildFrameTimePercentiles",
    endpoint: { method: "GET", path: "/api/v1/perf/frame-time" },
    grain: "project",
    dimensions: ["scene", "session"],
    filters: ["since", "until", "bins", "limit", "scene", "session", "format"],
    row: z.object({ sessions: int, samples: intOrNull, p50_ms: numOrNull, p95_ms: numOrNull }),
    columns: {
      sessions: { description: "Sessions contributing a percentile.", unit: "sessions" },
      samples: { description: "Total `frame_perf` samples behind them.", unit: "count" },
      p50_ms: {
        description: "Median across sessions of each session's median frame time.",
        unit: "ms",
        measure: true,
      },
      p95_ms: {
        description: "Median across sessions of each session's worst-window p95 frame time.",
        unit: "ms",
      },
    },
    limits: { maxRows: 1, maxSummaryRows: 1 },
    interpretation:
      "16.7 ms is the 60 Hz budget and 11.1 ms the 90 Hz XR budget. `p95_ms` is what makes a scene " +
      "feel janky even when `p50_ms` looks fine.",
    caveats: [
      EMPTY_SET_NULLS,
      "`p95_ms` is read from the SDK's per-window p95, not re-derived from window means, so it is a tail of tails.",
      "Samples that never reported frame-time detail are excluded rather than counted as zero.",
      PER_SESSION_THEN_AGGREGATE,
    ],
    sourceChannels: ["frame_perf"],
    related: ["perf_distribution", "jank_rate", "compile_stalls"],
    comparable: { primary: "p95_ms", direction: "down", minSample: 20 },
    category: "performance",
  },
  jank_rate: {
    id: "jank_rate",
    title: "Jank rate",
    description:
      "How often frames ran long, per session then aggregated (ADR 0028 §1): the median session's " +
      "long-frames-per-window rate and the worst decile's. Always a single row. Surfaces the janky " +
      "minority instead of averaging it away.",
    builder: "buildJankRate",
    endpoint: { method: "GET", path: "/api/v1/perf/jank" },
    grain: "project",
    dimensions: ["scene", "session"],
    filters: ["since", "until", "bins", "limit", "scene", "session", "format"],
    row: z.object({
      sessions: int,
      total_long_frames: numOrNull,
      median_rate: numOrNull,
      worst_decile_rate: numOrNull,
    }),
    columns: {
      sessions: { description: "Sessions contributing a rate.", unit: "sessions" },
      total_long_frames: {
        description: "Raw long-frame count across all sessions.",
        unit: "count",
      },
      median_rate: {
        description: "Median per-session long-frames-per-sample-window rate.",
        unit: "ratio",
        measure: true,
      },
      worst_decile_rate: {
        description: "p90 per-session rate — the unlucky visitors.",
        unit: "ratio",
      },
    },
    limits: { maxRows: 1, maxSummaryRows: 1 },
    interpretation:
      "A `median_rate` near zero with a high `worst_decile_rate` is the signature of a device-class " +
      "problem: most visitors are fine, a tenth are not. Follow it into `perf_by_device`.",
    caveats: [
      EMPTY_SET_NULLS,
      "A 'long frame' is defined by the SDK's `jankFrameMs` threshold (50 ms by default); apps that retune it are not comparable.",
      "Rates are per sample *window*, not per frame, so they scale with `samplePerfMs`.",
      PER_SESSION_THEN_AGGREGATE,
    ],
    sourceChannels: ["frame_perf"],
    related: ["frame_time_percentiles", "perf_distribution", "perf_by_device", "perf_churn"],
    comparable: { primary: "median_rate", direction: "down", minSample: 20 },
    category: "performance",
  },
  perf_churn: {
    id: "perf_churn",
    title: "Perf-correlated churn",
    description:
      "Does a stutter actually cost sessions (#144)? Of the sessions that ended in range, how many " +
      "ended shortly after an FPS dip or a compile stall, with the cause attributed. Always a " +
      "single row of aggregate counts.",
    builder: "buildPerfChurn",
    endpoint: { method: "GET", path: "/api/v1/perf/churn" },
    grain: "project",
    dimensions: ["scene", "session"],
    filters: [
      "since",
      "until",
      "bins",
      "limit",
      "scene",
      "session",
      "windowMs",
      "fpsThreshold",
      "stallMs",
      "format",
    ],
    row: z.object({
      sessions: int,
      churn_sessions: int,
      fps_churn_sessions: intOrNull,
      stall_churn_sessions: intOrNull,
    }),
    columns: {
      sessions: {
        description: "Sessions with a `session_end` in scope — the denominator.",
        unit: "sessions",
      },
      churn_sessions: {
        description: "Sessions that ended within `windowMs` of a qualifying dip.",
        unit: "sessions",
        measure: true,
        rateOf: "sessions",
      },
      fps_churn_sessions: {
        description: "Churned sessions whose window held a low-FPS sample.",
        unit: "sessions",
      },
      stall_churn_sessions: {
        description: "Churned sessions whose window held a compile stall.",
        unit: "sessions",
      },
    },
    limits: { maxRows: 1, maxSummaryRows: 1 },
    interpretation:
      "This is correlation, not causation — a session that ends after a dip may have ended anyway. " +
      "Compare the churn rate against a period with fewer dips before acting.",
    caveats: [
      EMPTY_SET_NULLS,
      "A session counted in both cause columns is counted once in `churn_sessions`, so the cause columns can sum to more than the total.",
      "Sessions with no `session_end` (a hard tab close that never flushed) are outside the denominator entirely.",
      "Every number moves with `windowMs` / `fpsThreshold` / `stallMs`; report the thresholds with the result.",
      "Fewer than ~50 ended sessions makes the rate noise.",
    ],
    sourceChannels: ["session_end", "frame_perf", "compile_stall"],
    related: ["jank_rate", "compile_stalls", "load_bounce_funnel", "perf_distribution"],
    comparable: { primary: "churn_sessions", direction: "down", minSample: 50 },
    category: "performance",
  },
  perf_by_device: {
    id: "perf_by_device",
    title: "FPS by device class",
    description:
      "Median FPS attributed to the graphics backend, mobile flag, GPU renderer and the coarse " +
      "browser/OS families derived at ingestion (ADR 0028 §2, ADR 0042). One row per device " +
      "combination. Where a bimodal FPS histogram gets explained.",
    builder: "buildPerfByDevice",
    endpoint: { method: "GET", path: "/api/v1/perf/by-device" },
    grain: "row",
    dimensions: [
      "device.engine",
      "device.isMobile",
      "device.renderer",
      "device.browser",
      "device.os",
      "scene",
      "session",
    ],
    filters: ["since", "until", "bins", "limit", "scene", "session", "format"],
    row: z.object({
      engine: text,
      is_mobile: text,
      renderer: text,
      browser: text,
      os: text,
      sessions: int,
      samples: int,
      p50_fps: num,
    }),
    columns: {
      engine: {
        description: "Graphics backend reported at `session_start`; `''` if unreported.",
        unit: "label",
      },
      is_mobile: { description: "Mobile flag as reported; `''` if unreported.", unit: "label" },
      renderer: {
        description: "GPU renderer string; `''` if unreported.",
        unit: "label",
        label: true,
      },
      browser: { description: "Coarse browser family derived from the User-Agent.", unit: "label" },
      os: { description: "Coarse OS family derived from the User-Agent.", unit: "label" },
      sessions: { description: "Sessions in the group.", unit: "sessions" },
      samples: { description: "`frame_perf` samples behind them.", unit: "count" },
      p50_fps: {
        description: "Median across the group's sessions of each session's median FPS.",
        unit: "fps",
        measure: true,
      },
    },
    limits: { maxRows: 1000, maxSummaryRows: 10 },
    interpretation:
      "The group is the full cross-product, so the rows are narrow. Sum `sessions` over the values " +
      "of one column to get a by-browser or by-OS view without a second query.",
    caveats: [
      "Device fields are read from the `session_start` payload and are `''` when a connector never reported them — `''` is a real group, not a null.",
      "GPU `renderer` strings are high-cardinality and vendor-formatted; expect many near-duplicate rows.",
      "Groups with one or two sessions carry no signal — check `sessions` before comparing medians.",
      PER_SESSION_THEN_AGGREGATE,
    ],
    sourceChannels: ["session_start", "frame_perf"],
    related: ["fps_histogram", "perf_distribution", "rendering_technology", "session_meta"],
    comparable: { primary: "p50_fps", direction: "up", minSample: 10 },
    category: "performance",
  },
  perf_by_scene: {
    id: "perf_by_scene",
    title: "FPS by scene",
    description:
      "Median FPS attributed to each scene, per session then aggregated (ADR 0028 §1). One row per " +
      "scene. The comparison that tells you which level is expensive.",
    builder: "buildPerfByScene",
    endpoint: { method: "GET", path: "/api/v1/perf/by-scene" },
    grain: "scene",
    dimensions: ["scene", "session"],
    filters: ["since", "until", "bins", "limit", "scene", "session", "format"],
    row: z.object({ scene_id: text, sessions: int, samples: int, p50_fps: num }),
    columns: {
      scene_id: { description: "Developer-assigned scene id.", unit: "id", label: true },
      sessions: { description: "Sessions in the scene.", unit: "sessions" },
      samples: { description: "`frame_perf` samples behind them.", unit: "count" },
      p50_fps: {
        description: "Median across the scene's sessions of each session's median FPS.",
        unit: "fps",
        measure: true,
      },
    },
    limits: { maxRows: 1000, maxSummaryRows: 10 },
    interpretation:
      "Because each session is one vote, a scene visited mostly on phones will look slower than one " +
      "visited mostly on desktops even with identical content — cross-check `perf_by_device`.",
    caveats: [
      "Scenes with a handful of sessions are not comparable; check `sessions` first.",
      PER_SESSION_THEN_AGGREGATE,
      "An app that never calls `setScene(...)` reports everything under `default`.",
    ],
    sourceChannels: ["frame_perf"],
    related: ["perf_by_device", "perf_heatmap", "list_scenes", "perf_distribution"],
    comparable: { primary: "p50_fps", direction: "up", minSample: 10 },
    category: "performance",
  },
  perf_heatmap: {
    id: "perf_heatmap",
    title: "Spatial FPS heatmap",
    description:
      "`frame_perf` samples voxel-binned by the camera position they were captured at (#145), with " +
      "each cell's sample count, mean FPS and worst sample. One row per occupied voxel, " +
      "worst-FPS-first. Answers *where* performance degrades.",
    builder: "buildPerfHeatmap",
    endpoint: { method: "GET", path: "/api/v1/heatmaps/perf" },
    grain: "voxel",
    dimensions: ["scene", "session"],
    filters: ["since", "until", "cellSize", "limit", "scene", "session", "format"],
    row: z.object({ vx: int, vy: int, vz: int, samples: int, avg_fps: num, min_fps: num }),
    columns: {
      vx: { description: "Voxel X index.", unit: "index", label: true },
      vy: { description: "Voxel Y index.", unit: "index" },
      vz: { description: "Voxel Z index.", unit: "index" },
      samples: { description: "`frame_perf` samples in the voxel.", unit: "count" },
      avg_fps: { description: "Mean FPS in the voxel.", unit: "fps", measure: true },
      min_fps: { description: "Worst single sample in the voxel.", unit: "fps" },
    },
    limits: { maxRows: 10000, maxSummaryRows: 8 },
    interpretation:
      "Rows come back worst-FPS-first, so the capped slice is the jankiest cells rather than an " +
      "arbitrary corner. A low-`samples` cell with terrible FPS is one unlucky moment, not a hot " +
      "spot — weight by `samples`.",
    caveats: [
      "Needs `frame_perf` samples that carry a camera position; connectors that omit it contribute nothing.",
      CELL_SIZE_SENSITIVE,
      "`frame_perf` is a sampled channel (ADR 0012), so a fast traverse through a bad region may leave few samples behind.",
    ],
    sourceChannels: ["frame_perf"],
    related: ["perf_by_scene", "scene_coverage", "position_heatmap", "error_heatmap"],
    comparable: { primary: "avg_fps", direction: "up", minSample: 30 },
    category: "performance",
  },
  perf_daily: {
    id: "perf_daily",
    title: "Daily performance trend",
    description:
      "Per-day FPS aggregates read from the `perf_daily` rollup: sample count and average / " +
      "minimum / median FPS. One row per day. The long-horizon performance trend.",
    builder: "buildPerfDaily",
    grain: "bucket",
    dimensions: [],
    filters: [],
    row: z.object({ day: day, samples: int, avg_fps: num, min_fps: num, p50_fps: num }),
    columns: {
      day: {
        description: "Calendar day (UTC) as `YYYY-MM-DD`.",
        unit: "label",
        label: true,
        axis: true,
      },
      samples: { description: "`frame_perf` samples on that day.", unit: "count" },
      avg_fps: { description: "Mean FPS across the day's samples.", unit: "fps", measure: true },
      min_fps: { description: "Worst single sample of the day.", unit: "fps" },
      p50_fps: { description: "Median FPS across the day's samples.", unit: "fps" },
    },
    limits: { maxRows: 1000, maxSummaryRows: 10 },
    interpretation:
      "Pooled per day, so a single busy session can move the average. Use it for direction of " +
      "travel, and `perf_distribution` over a narrower range for a decision.",
    caveats: [
      "No collector endpoint serves this builder today — it is reachable through the store / `QuerySpec` API only.",
      "On the OSS DuckDB store this is a query-time aggregation; on the ClickHouse scale tier it merges materialized aggregate states.",
      "Day boundaries are UTC and the upper bound is exclusive at date granularity.",
    ],
    sourceChannels: ["frame_perf"],
    related: ["perf_summary", "events_daily", "perf_distribution"],
    comparable: { primary: "p50_fps", direction: "up", minSample: 30 },
    category: "performance",
  },
  compile_stalls: {
    id: "compile_stalls",
    title: "Shader / pipeline compile stalls",
    description:
      "Per compile phase, how many main-thread compile hitches happened and their total, average " +
      "and worst duration (#42). One row per phase. Compilation is the biggest single source of " +
      "first-interaction jank, and frame-rate averages hide it.",
    builder: "buildCompileStalls",
    endpoint: { method: "GET", path: "/api/v1/perf/compile-stalls" },
    grain: "row",
    dimensions: ["name", "scene", "session"],
    filters: ["since", "until", "bins", "limit", "scene", "session", "format"],
    row: z.object({ phase: text, stalls: int, total_ms: num, avg_ms: num, max_ms: num }),
    columns: {
      phase: {
        description:
          "Coarse compile phase (shader / pipeline / material / other); `''` if unattributed.",
        unit: "label",
        label: true,
      },
      stalls: { description: "Compile stalls in the phase.", unit: "count" },
      total_ms: {
        description: "Total main-thread time spent compiling.",
        unit: "ms",
        measure: true,
      },
      avg_ms: { description: "Mean compile-stall duration.", unit: "ms" },
      max_ms: { description: "Worst single compile stall.", unit: "ms" },
    },
    limits: { maxRows: 1000, maxSummaryRows: 10 },
    interpretation:
      "`max_ms` is what a visitor felt as a freeze; `total_ms` is what a warm-up pass could remove. " +
      "Most stalls cluster at first load, so a per-session view is more actionable than a range total.",
    caveats: [
      "Compile-stall capture is on by default, but only engines that expose compilation hooks report it.",
      "Mostly a first-load cost, so totals scale with new visitors rather than with usage.",
      "Durations ride in the shared `visible_ms` column; do not mix them with dwell metrics.",
    ],
    sourceChannels: ["compile_stall"],
    related: ["stability_counts", "perf_churn", "frame_time_percentiles", "load_bounce_funnel"],
    comparable: { primary: "total_ms", direction: "down", minSample: 10 },
    category: "performance",
  },
  resource_summary: {
    id: "resource_summary",
    title: "GPU / memory footprint summary",
    description:
      "The average and peak of each footprint metric over the range (#44): JS heap, submitted " +
      "triangles and vertices, resident texture and geometry bytes. Always a single row — the " +
      "actual cost the scene asked of the device.",
    builder: "buildResourceSummary",
    endpoint: { method: "GET", path: "/api/v1/perf/resources" },
    grain: "project",
    dimensions: ["session"],
    filters: ["since", "until", "bins", "limit", "session", "format"],
    row: z.object({
      samples: int,
      avg_js_heap_bytes: numOrNull,
      max_js_heap_bytes: numOrNull,
      avg_triangles: numOrNull,
      max_triangles: numOrNull,
      avg_vertices: numOrNull,
      max_vertices: numOrNull,
      avg_texture_bytes: numOrNull,
      max_texture_bytes: numOrNull,
      avg_geometry_bytes: numOrNull,
      max_geometry_bytes: numOrNull,
    }),
    columns: {
      samples: { description: "Footprint samples in the range.", unit: "count" },
      avg_js_heap_bytes: { description: "Mean used JS heap.", unit: "bytes", measure: true },
      max_js_heap_bytes: { description: "Peak used JS heap.", unit: "bytes" },
      avg_triangles: { description: "Mean triangles submitted per sampled frame.", unit: "count" },
      max_triangles: { description: "Peak triangles submitted in a sampled frame.", unit: "count" },
      avg_vertices: { description: "Mean vertices submitted per sampled frame.", unit: "count" },
      max_vertices: { description: "Peak vertices submitted in a sampled frame.", unit: "count" },
      avg_texture_bytes: { description: "Mean resident texture memory.", unit: "bytes" },
      max_texture_bytes: { description: "Peak resident texture memory.", unit: "bytes" },
      avg_geometry_bytes: { description: "Mean resident geometry memory.", unit: "bytes" },
      max_geometry_bytes: { description: "Peak resident geometry memory.", unit: "bytes" },
    },
    limits: { maxRows: 1, maxSummaryRows: 1 },
    interpretation:
      "Peaks matter more than averages here: a device runs out of memory at the peak. Read it " +
      "against the device caps in `session_meta`, not against an absolute budget.",
    caveats: [
      EMPTY_SET_NULLS,
      "Requires the footprint capture option (`capture.resourceSample`, **off by default**, ADR 0012); without it the result is empty.",
      "Unreported metrics are stored as `0` and excluded from the averages, so a metric one engine omits does not dilute another's.",
      "JS heap is only available where the browser exposes it (Chromium-family); elsewhere it reads as unreported.",
      "Averages are pooled over samples, so a long session dominates — use `resource_percentiles` for a per-session view.",
    ],
    sourceChannels: ["resource_sample"],
    related: ["resource_percentiles", "perf_summary", "perf_by_device"],
    comparable: { primary: "max_js_heap_bytes", direction: "down", minSample: 10 },
    category: "performance",
  },
  resource_percentiles: {
    id: "resource_percentiles",
    title: "GPU / memory footprint percentiles",
    description:
      "Footprint percentiles computed per session then aggregated (ADR 0028 §1): a typical (p50) " +
      "and peak (p95) JS heap, texture bytes and triangle count per session, summarised as the " +
      "median across sessions. Always a single row.",
    builder: "buildResourcePercentiles",
    endpoint: { method: "GET", path: "/api/v1/perf/resource-percentiles" },
    grain: "project",
    dimensions: ["scene", "session"],
    filters: ["since", "until", "bins", "limit", "scene", "session", "format"],
    row: z.object({
      sessions: int,
      samples: intOrNull,
      p50_js_heap_bytes: numOrNull,
      p95_js_heap_bytes: numOrNull,
      p50_texture_bytes: numOrNull,
      p95_texture_bytes: numOrNull,
      p50_triangles: numOrNull,
      p95_triangles: numOrNull,
    }),
    columns: {
      sessions: { description: "Sessions contributing a percentile.", unit: "sessions" },
      samples: { description: "Footprint samples behind them.", unit: "count" },
      p50_js_heap_bytes: {
        description: "Median session's typical JS heap.",
        unit: "bytes",
        measure: true,
      },
      p95_js_heap_bytes: { description: "Median session's peak JS heap.", unit: "bytes" },
      p50_texture_bytes: { description: "Median session's typical texture memory.", unit: "bytes" },
      p95_texture_bytes: { description: "Median session's peak texture memory.", unit: "bytes" },
      p50_triangles: {
        description: "Median session's typical submitted triangles.",
        unit: "count",
      },
      p95_triangles: { description: "Median session's peak submitted triangles.", unit: "count" },
    },
    limits: { maxRows: 1, maxSummaryRows: 1 },
    interpretation:
      "The distribution-honest companion to `resource_summary`: a single heavy session no longer " +
      "sets the headline footprint.",
    caveats: [
      EMPTY_SET_NULLS,
      "Requires the footprint capture option (`capture.resourceSample`, **off by default**, ADR 0012).",
      "Unreported metrics (stored `0`) are excluded rather than counted as zero.",
      PER_SESSION_THEN_AGGREGATE,
      "Fewer than ~20 sessions makes the medians unstable.",
    ],
    sourceChannels: ["resource_sample"],
    related: ["resource_summary", "perf_distribution", "perf_by_device"],
    comparable: { primary: "p95_js_heap_bytes", direction: "down", minSample: 20 },
    category: "performance",
  },

  // =========================================================================
  // Errors, stability & capabilities
  // =========================================================================
  stability_counts: {
    id: "stability_counts",
    title: "Stability incidents",
    description:
      "GPU context losses and shader/pipeline compile stalls over the range, plus their total. " +
      "Always a single row. These are the hard failures a frame-rate average cannot show — a " +
      "context loss blanks the canvas, a compile stall freezes first interaction.",
    builder: "buildStabilityCounts",
    endpoint: { method: "GET", path: "/api/v1/perf/stability" },
    grain: "project",
    dimensions: ["scene", "session"],
    filters: ["since", "until", "bins", "limit", "scene", "session", "format"],
    row: z.object({ context_losses: int, compile_stalls: int, incidents: int }),
    columns: {
      context_losses: { description: "`context_lost` events in scope.", unit: "count" },
      compile_stalls: { description: "`compile_stall` events in scope.", unit: "count" },
      incidents: { description: "Sum of both.", unit: "count", measure: true },
    },
    limits: { maxRows: 1, maxSummaryRows: 1 },
    interpretation:
      "An empty range reports `0`, never null. Normalise by session count (`list_sessions`) before " +
      "comparing periods — raw incident counts track traffic.",
    caveats: [
      "Context-loss capture is on by default but engine-dependent; a connector that does not hook it reports zero.",
      "Compile stalls cluster at first load, so this total is dominated by new visitors.",
      "It counts incidents, not affected sessions — one bad session can produce many.",
    ],
    sourceChannels: ["context_lost", "compile_stall"],
    related: ["compile_stalls", "graphics_diagnostics", "capability_changes", "event_counts"],
    comparable: { primary: "incidents", direction: "down", minSample: 10 },
    category: "errors",
  },
  graphics_diagnostics: {
    id: "graphics_diagnostics",
    title: "Engine diagnostic counts",
    description:
      "Opt-in engine diagnostics crossed by (severity, category, backend) with a rollup-aware " +
      "incident total (ADR 0021 part 2). One row per combination. Surfaces validation errors, " +
      "shader-compile failures and context-loss detail the engine reports.",
    builder: "buildGraphicsDiagnosticCounts",
    endpoint: { method: "GET", path: "/api/v1/graphics-diagnostics" },
    grain: "row",
    dimensions: ["scene", "session"],
    filters: ["since", "until", "bins", "limit", "scene", "session", "format"],
    row: z.object({ severity: text, category: text, backend: text, incidents: int }),
    columns: {
      severity: {
        description: "Diagnostic severity (info / warning / error / fatal).",
        unit: "label",
      },
      category: {
        description: "Diagnostic category (context-loss / validation / shader-compile / …).",
        unit: "label",
        label: true,
      },
      backend: {
        description: "Graphics backend; `''` when the connector omitted it.",
        unit: "label",
      },
      incidents: {
        description: "Incidents in the cell, markers and per-session rollups folded together.",
        unit: "count",
        measure: true,
      },
    },
    limits: { maxRows: 1000, maxSummaryRows: 10 },
    interpretation:
      "Sum over one column to get the by-severity, by-category or by-backend breakdown from this " +
      "single query. Each event is either one discrete incident or a per-session rollup of N, and " +
      "the total already accounts for both.",
    caveats: [
      "Diagnostic capture is **off by default** (`captureGraphicsDiagnostics`, ADR 0021); an empty result is the common case and does not mean the engine is clean.",
      "Severity/category/backend ride in the event payload rather than promoted columns.",
      "Counts incidents, not affected sessions.",
    ],
    sourceChannels: ["graphics_diagnostic"],
    related: ["stability_counts", "error_heatmap", "rendering_technology", "capability_changes"],
    comparable: { primary: "incidents", direction: "down", minSample: 10 },
    category: "errors",
  },
  error_heatmap: {
    id: "error_heatmap",
    title: "Spatial error heatmap",
    description:
      "Positioned runtime errors and engine diagnostics voxel-binned into a uniform grid (#154). " +
      "One row per occupied voxel, busiest first. Reveals *where* in the scene things break, not " +
      "only when.",
    builder: "buildErrorHeatmap",
    endpoint: { method: "GET", path: "/api/v1/heatmaps/errors" },
    grain: "voxel",
    dimensions: ["scene", "session"],
    filters: [
      "since",
      "until",
      "cellSize",
      "limit",
      "scene",
      "session",
      "region",
      "severity",
      "category",
      "errorKind",
      "format",
    ],
    row: voxelCountRow,
    columns: {
      vx: { description: "Voxel X index.", unit: "index", label: true },
      vy: { description: "Voxel Y index.", unit: "index" },
      vz: { description: "Voxel Z index.", unit: "index" },
      count: { description: "Errors and diagnostics in the voxel.", unit: "count", measure: true },
    },
    limits: { maxRows: 10000, maxSummaryRows: 8 },
    interpretation:
      "Setting `severity` or `category` narrows to engine diagnostics; setting `errorKind` narrows " +
      "to JS runtime errors. Leave all three unset to bin both streams together.",
    caveats: [
      "Only events carrying a full 3-vector position participate — errors from pages with no 3D connector are excluded by construction.",
      "The position is the camera pose at the moment the error fired, which is best-effort and not necessarily where the fault is.",
      "Engine diagnostics need their opt-in capture option (ADR 0021); with it off only JS runtime errors appear.",
      CELL_SIZE_SENSITIVE,
    ],
    sourceChannels: ["runtime_error", "graphics_diagnostic"],
    related: ["graphics_diagnostics", "stability_counts", "perf_heatmap"],
    comparable: { primary: "count", direction: "down", minSample: 10 },
    category: "errors",
  },
  rendering_technology: {
    id: "rendering_technology",
    title: "Rendering-technology mix",
    description:
      "Session counts crossed by (api, backend, api version, shading language) from the " +
      "always-on `session_start` graphics block (ADR 0021 part 1, ADR 0046). One row per " +
      "combination — WebGPU vs WebGL2 adoption, and which shading language is in play.",
    builder: "buildRenderingTechnology",
    endpoint: { method: "GET", path: "/api/v1/rendering-technology" },
    grain: "row",
    dimensions: ["scene", "session"],
    filters: ["since", "until", "bins", "limit", "scene", "session", "format"],
    row: z.object({
      api: text,
      backend: text,
      api_version: text,
      shading_language: text,
      sessions: int,
    }),
    columns: {
      api: {
        description: "Graphics API; `''` when the connector omitted it.",
        unit: "label",
        label: true,
      },
      backend: { description: "Engine backend; `''` if unreported.", unit: "label" },
      api_version: { description: "API version string; `''` if unreported.", unit: "label" },
      shading_language: { description: "Shading language; `''` if unreported.", unit: "label" },
      sessions: { description: "Sessions in the cell.", unit: "sessions", measure: true },
    },
    limits: { maxRows: 1000, maxSummaryRows: 10 },
    interpretation:
      "Sum over one column to derive the by-api, by-backend, by-version or by-shading-language " +
      "breakdown from this single query. `session_start` is always on, so a populated result is the " +
      "normal case.",
    caveats: [
      "`''` means 'the connector did not report this field', which is a real and often large group.",
      "It counts sessions, not visitors — one person across two days counts twice.",
      SMALL_SAMPLE,
    ],
    sourceChannels: ["session_start"],
    related: ["perf_by_device", "capability_changes", "graphics_diagnostics"],
    comparable: { primary: "sessions", direction: "neutral", minSample: 30 },
    category: "performance",
  },
  capability_changes: {
    id: "capability_changes",
    title: "Capability / fidelity transitions",
    description:
      "How often the app reported a capability fallback or recovery, per (kind, from, to) (#49). " +
      "One row per transition. Explains perf and visual-fidelity variance — e.g. how many sessions " +
      "fell back from WebGPU to WebGL2.",
    builder: "buildCapabilityChanges",
    endpoint: { method: "GET", path: "/api/v1/capabilities" },
    grain: "row",
    dimensions: ["name", "scene", "session"],
    filters: ["since", "until", "bins", "limit", "scene", "session", "format"],
    row: z.object({ kind: text, from: text, to: text, changes: int }),
    columns: {
      kind: {
        description:
          "Capability class (graphics-backend / quality / device-recovery / tracking / feature / other).",
        unit: "label",
        label: true,
      },
      from: { description: "Previous capability token; `''` if unreported.", unit: "label" },
      to: { description: "New capability token; `''` if unreported.", unit: "label" },
      changes: { description: "Times the transition was reported.", unit: "count", measure: true },
    },
    limits: { maxRows: 1000, maxSummaryRows: 10 },
    interpretation:
      "A fallback and its recovery are separate rows in opposite directions; a large imbalance " +
      'means sessions ended while degraded. `kind: "tracking"` rows are the XR signal behind ' +
      "`xr_tracking_quality`.",
    caveats: [
      "Only transitions the app or connector actually reports appear — silence is not stability.",
      "Reported through `reportCapabilityChange(...)` or the XR tracking option; neither is universal.",
      SMALL_SAMPLE,
    ],
    sourceChannels: ["capability_change"],
    related: [
      "rendering_technology",
      "xr_tracking_quality",
      "render_scale_truth",
      "stability_counts",
    ],
    comparable: { primary: "changes", direction: "down", minSample: 10 },
    category: "errors",
  },

  // =========================================================================
  // XR & AR
  // =========================================================================
  xr_rotation: {
    id: "xr_rotation",
    title: "XR head-rotation rate",
    description:
      "Per session, how fast the view turned over the camera pose stream — the angular path, the " +
      "worst single jerk, and how many steps cleared the rapid-turn threshold. One row per session. " +
      "A motion-sickness proxy.",
    builder: "buildXrRotationRate",
    endpoint: { method: "GET", path: "/api/v1/xr/rotation" },
    grain: "session",
    dimensions: ["session", "scene"],
    filters: ["since", "until", "rapidTurn", "limit", "scene", "session", "format"],
    row: z.object({
      session_id: text,
      samples: int,
      avg_turn_rad: num,
      max_turn_rad: num,
      total_turn_rad: num,
      rapid_segments: int,
    }),
    columns: {
      session_id: { description: "Session identifier.", unit: "id", label: true },
      samples: { description: "Pose samples contributing a turn.", unit: "count" },
      avg_turn_rad: {
        description: "Mean angle between consecutive view directions.",
        unit: "radians",
      },
      max_turn_rad: { description: "Worst single inter-sample turn.", unit: "radians" },
      total_turn_rad: {
        description: "Total angular path travelled.",
        unit: "radians",
        measure: true,
      },
      rapid_segments: {
        description: "Steps whose turn cleared `rapidTurn`.",
        unit: "count",
        rateOf: "samples",
      },
    },
    limits: { maxRows: 1000, maxSummaryRows: 10 },
    interpretation:
      "`rapid_segments / samples` is the share of the session spent turning uncomfortably fast. " +
      "Rapid view rotation correlates with simulator sickness, most acutely in a headset.",
    caveats: [
      "Turn *rate* depends on the pose cadence: at ~1 Hz a 'step' spans a second, so the angles are coarse. Raise the camera sampling rate before trusting them in a headset.",
      CAMERA_SAMPLED,
      "Not XR-gated — it runs over any session's camera samples, including flat-screen ones.",
      "`rapid_segments` moves with `rapidTurn`; report the threshold with the result.",
    ],
    sourceChannels: ["camera_sample"],
    related: ["xr_locomotion", "xr_abandonment", "camera_gestures", "xr_tracking_quality"],
    comparable: { primary: "rapid_segments", direction: "down", minSample: 10 },
    category: "xr",
  },
  xr_sources: {
    id: "xr_sources",
    title: "XR input-source usage",
    description:
      "The immersive input mix: one row per XR input source (hand, controller, gaze, transient) " +
      "with its interaction count and how many sessions used it. Flat-screen sources are excluded " +
      "so the split is purely XR.",
    builder: "buildXrSourceUsage",
    endpoint: { method: "GET", path: "/api/v1/xr/sources" },
    grain: "row",
    dimensions: ["source", "scene", "session"],
    filters: ["since", "until", "bins", "limit", "scene", "session", "format"],
    row: z.object({ source: text, interactions: int, sessions: int }),
    columns: {
      source: { description: "XR input source.", unit: "label", label: true },
      interactions: { description: "Interactions from the source.", unit: "count", measure: true },
      sessions: { description: "Distinct sessions that used it.", unit: "sessions" },
    },
    limits: { maxRows: 1000, maxSummaryRows: 10 },
    interpretation:
      "Weigh `sessions` alongside `interactions`: hand tracking often shows few sessions with many " +
      "interactions (it is chatty), controllers the reverse.",
    caveats: [
      "An empty result means no XR input was seen, which is the normal case for a flat-screen project.",
      "Requires XR interaction capture (`xr.capture.clicks` / `meshPicks`); pose-only XR sessions contribute nothing.",
      SMALL_SAMPLE,
    ],
    sourceChannels: ["pointer_click", "pointer_move", "mesh_interaction"],
    related: ["interaction_sources", "xr_locomotion", "xr_tracking_quality", "mesh_reachability"],
    comparable: { primary: "interactions", direction: "neutral", minSample: 30 },
    category: "xr",
  },
  xr_abandonment: {
    id: "xr_abandonment",
    title: "XR session abandonment",
    description:
      "For every session that used an XR input source, its wall-clock bounds and event / " +
      "interaction counts. One row per XR session. A short span with few interactions is headset " +
      "drop-off.",
    builder: "buildXrAbandonment",
    endpoint: { method: "GET", path: "/api/v1/xr/abandonment" },
    grain: "session",
    dimensions: ["session", "scene"],
    filters: ["since", "until", "bins", "limit", "scene", "session", "format"],
    row: z.object({
      session_id: text,
      events: int,
      xr_interactions: int,
      started_at: ts,
      ended_at: ts,
    }),
    columns: {
      session_id: { description: "Session identifier.", unit: "id", label: true },
      events: { description: "All events in the session.", unit: "count" },
      xr_interactions: {
        description: "Interactions from an XR input source.",
        unit: "count",
        measure: true,
      },
      started_at: { description: "First event timestamp.", unit: "timestamp" },
      ended_at: { description: "Last event timestamp.", unit: "timestamp" },
    },
    limits: { maxRows: 1000, maxSummaryRows: 10 },
    interpretation:
      "Abandonment is read from the span: `ended_at - started_at` short relative to the rest of the " +
      "cohort. Pair with `xr_rotation` and `xr_locomotion` to test whether discomfort explains it.",
    caveats: [
      "Sessions with no XR input are omitted entirely, so this is never a full session list.",
      ENGINE_TIMESTAMPS,
      "A short span can equally mean a quick successful task; compare against the cohort, not an absolute.",
    ],
    sourceChannels: ["pointer_click", "pointer_move", "mesh_interaction"],
    related: ["xr_locomotion", "xr_rotation", "xr_tracking_quality", "list_sessions"],
    comparable: { primary: "xr_interactions", direction: "up", minSample: 10 },
    category: "xr",
  },
  xr_locomotion: {
    id: "xr_locomotion",
    title: "XR locomotion & comfort",
    description:
      "Per XR session, its locomotion-style mix — fly and navigate gestures, discrete teleports, " +
      "and total time in locomotion — plus the session's wall-clock span (#148). One row per XR " +
      "session. Constant smooth locomotion is a motion-sickness risk; teleport-dominant sessions " +
      "are not.",
    builder: "buildXrLocomotionComfort",
    endpoint: { method: "GET", path: "/api/v1/xr/locomotion" },
    grain: "session",
    dimensions: ["session", "scene"],
    filters: ["since", "until", "bins", "limit", "scene", "session", "format"],
    row: z.object({
      session_id: text,
      fly_gestures: int,
      navigate_gestures: int,
      teleports: int,
      locomotion_ms: num,
      started_at: ts,
      ended_at: ts,
    }),
    columns: {
      session_id: { description: "Session identifier.", unit: "id", label: true },
      fly_gestures: {
        description: "`fly` gestures — smooth thumbstick moves *and* teleport flies.",
        unit: "count",
      },
      navigate_gestures: {
        description: "`navigate` gestures — untyped user-bracketed moves.",
        unit: "count",
      },
      teleports: { description: "Discrete viewpoint jumps.", unit: "count" },
      locomotion_ms: {
        description: "Total time in fly + navigate gestures.",
        unit: "ms",
        measure: true,
      },
      started_at: { description: "First event timestamp.", unit: "timestamp" },
      ended_at: { description: "Last event timestamp.", unit: "timestamp" },
    },
    limits: { maxRows: 1000, maxSummaryRows: 10 },
    interpretation:
      "Smooth locomotion is `fly_gestures - teleports`: a teleport emits both a fly gesture and a " +
      "teleport interaction (ADR 0025), so the raw `fly_gestures` over-counts smooth movement. A " +
      "high smooth count with a short span is the discomfort / rage-quit signature.",
    caveats: [
      "Sessions with no XR input are omitted entirely.",
      "Requires camera-gesture capture (on by default) and XR mesh-pick capture for the teleport half.",
      ENGINE_TIMESTAMPS,
      SMALL_SAMPLE,
    ],
    sourceChannels: ["camera_gesture", "mesh_interaction"],
    related: ["xr_rotation", "xr_abandonment", "camera_gestures", "xr_boundary_contacts"],
    comparable: { primary: "locomotion_ms", direction: "down", minSample: 10 },
    category: "xr",
  },
  xr_tracking_quality: {
    id: "xr_tracking_quality",
    title: "XR tracking quality",
    description:
      "Per session that reported a tracking transition, how much of it ran with degraded or lost " +
      "spatial tracking, split by hand vs controller (#155, ADR 0048). One row per session. A " +
      "session that looked fine on FPS can still have been unusable because the hands kept " +
      "disappearing.",
    builder: "buildTrackingQuality",
    endpoint: { method: "GET", path: "/api/v1/xr/tracking" },
    grain: "session",
    dimensions: ["session", "scene", "source"],
    filters: ["since", "until", "bins", "limit", "scene", "session", "format"],
    row: z.object({
      session_id: text,
      degraded_ms: num,
      hand_degraded_ms: num,
      controller_degraded_ms: num,
      degraded_episodes: int,
      started_at: ts,
      ended_at: ts,
    }),
    columns: {
      session_id: { description: "Session identifier.", unit: "id", label: true },
      degraded_ms: {
        description: "Total degraded / lost tracking time.",
        unit: "ms",
        measure: true,
      },
      hand_degraded_ms: { description: "Degraded time attributed to hand tracking.", unit: "ms" },
      controller_degraded_ms: {
        description: "Degraded time attributed to controller tracking.",
        unit: "ms",
      },
      degraded_episodes: { description: "Completed degraded episodes.", unit: "count" },
      started_at: { description: "First event timestamp of the whole session.", unit: "timestamp" },
      ended_at: { description: "Last event timestamp of the whole session.", unit: "timestamp" },
    },
    limits: { maxRows: 1000, maxSummaryRows: 10 },
    interpretation:
      "The degraded share is `degraded_ms / (ended_at - started_at)` — the timestamps deliberately " +
      "bound the whole session, not just the tracking events, so that division is meaningful.",
    caveats: [
      "Requires the XR tracking capture option (`xr.capture.tracking`, ADR 0048); sessions with no tracking transition are omitted entirely.",
      "Detection is coarse: a source deliberately switched off looks the same as one whose tracking was lost. Apps with a real confidence hook should report transitions explicitly.",
      "Only *completed* episodes carry a duration, so tracking still degraded at session end is under-counted.",
      ENGINE_TIMESTAMPS,
    ],
    sourceChannels: ["capability_change"],
    related: ["capability_changes", "xr_sources", "xr_abandonment", "xr_locomotion"],
    comparable: { primary: "degraded_ms", direction: "down", minSample: 10 },
    category: "xr",
  },
  boundary_heatmap: {
    id: "boundary_heatmap",
    title: "Guardian / boundary-touch heatmap",
    description:
      "Where room-scale VR visitors approached their play-space boundary, voxel-binned into a " +
      "uniform grid (#157, ADR 0048). One row per occupied voxel, busiest first. The 'where did " +
      "people keep bumping into their guardian' map.",
    builder: "buildBoundaryHeatmap",
    endpoint: { method: "GET", path: "/api/v1/heatmaps/boundary" },
    grain: "voxel",
    dimensions: ["scene", "session"],
    filters: ["since", "until", "cellSize", "limit", "scene", "session", "region", "format"],
    row: voxelCountRow,
    columns: {
      vx: { description: "Voxel X index.", unit: "index", label: true },
      vy: { description: "Voxel Y index.", unit: "index" },
      vz: { description: "Voxel Z index.", unit: "index" },
      count: { description: "Boundary approaches in the voxel.", unit: "count", measure: true },
    },
    limits: { maxRows: 1000, maxSummaryRows: 8 },
    interpretation:
      "A cluster means the experience asked visitors to move somewhere their physical room does not " +
      "allow — content to reposition, not a bug in the headset.",
    caveats: [
      "Requires boundary-proximity capture (`trackBoundaryProximity`, opt-in, ADR 0048); empty otherwise.",
      "The boundary polygon and room geometry are **never** captured (ADR 0003) — only the coarse HMD position at closest approach.",
      "Room layouts differ per visitor, so voxels only pool meaningfully within one scene's content frame.",
      CELL_SIZE_SENSITIVE,
      TRUNCATED_TOP_N,
    ],
    sourceChannels: ["xr_boundary_proximity"],
    related: [
      "boundary_heatmap_stats",
      "xr_boundary_contacts",
      "position_heatmap",
      "xr_locomotion",
    ],
    comparable: { primary: "count", direction: "down", minSample: 30 },
    category: "xr",
  },
  boundary_heatmap_stats: {
    id: "boundary_heatmap_stats",
    title: "Boundary heatmap totals",
    description:
      "The un-truncated totals behind `boundary_heatmap` (ADR 0040 §3): occupied voxels and total " +
      "boundary contacts, with no row cap. Always a single row.",
    builder: "buildBoundaryHeatmapStats",
    endpoint: { method: "GET", path: "/api/v1/heatmaps/boundary/stats" },
    grain: "project",
    dimensions: ["scene", "session"],
    filters: ["since", "until", "cellSize", "scene", "session", "region", "format"],
    row: spatialStatsRow,
    columns: {
      cells: { description: "Occupied boundary voxels across the scene or region.", unit: "count" },
      hits: { description: "Total boundary approaches.", unit: "count", measure: true },
    },
    limits: { maxRows: 1, maxSummaryRows: 1 },
    interpretation:
      "Use `hits` as the denominator for shares over a truncated `boundary_heatmap`, and `cells` for " +
      "'showing the top N of M cells'.",
    caveats: [
      "Requires boundary-proximity capture (opt-in, ADR 0048).",
      CELL_SIZE_SENSITIVE,
      "Must be called with exactly the same filters and `cellSize` as the `boundary_heatmap` it describes.",
    ],
    sourceChannels: ["xr_boundary_proximity"],
    related: ["boundary_heatmap"],
    category: "xr",
  },
  xr_boundary_contacts: {
    id: "xr_boundary_contacts",
    title: "Boundary contacts per session",
    description:
      "For every session that touched its play-space boundary, how many approaches it made and how " +
      "long it spent in the near-boundary zone (#157, ADR 0048). One row per session. Frequent " +
      "contact means the physical space did not fit the experience.",
    builder: "buildBoundaryContacts",
    endpoint: { method: "GET", path: "/api/v1/xr/boundary-contacts" },
    grain: "session",
    dimensions: ["session", "scene"],
    filters: ["since", "until", "bins", "limit", "scene", "session", "format"],
    row: z.object({ session_id: text, contacts: int, near_ms: num }),
    columns: {
      session_id: { description: "Session identifier.", unit: "id", label: true },
      contacts: {
        description: "Boundary approaches in the session.",
        unit: "count",
        measure: true,
      },
      near_ms: { description: "Total time spent inside the near-boundary zone.", unit: "ms" },
    },
    limits: { maxRows: 1000, maxSummaryRows: 10 },
    interpretation:
      "`near_ms / contacts` is how long an average approach lasted: many short contacts is a " +
      "cramped room, few long ones is content placed against the edge.",
    caveats: [
      "Requires boundary-proximity capture (opt-in, ADR 0048); sessions that never approached are absent.",
      "Room size is a property of the visitor, not the content — normalise before comparing scenes.",
      "No boundary geometry is ever read; only the promoted position and duration each event carries.",
    ],
    sourceChannels: ["xr_boundary_proximity"],
    related: ["boundary_heatmap", "xr_locomotion", "xr_abandonment"],
    comparable: { primary: "contacts", direction: "down", minSample: 10 },
    category: "xr",
  },
  ar_placement_time_to_place: {
    id: "ar_placement_time_to_place",
    title: "AR time-to-place distribution",
    description:
      "How long visitors took to place a model on a surface, histogrammed into `bucketMs`-wide " +
      "bins (#156, ADR 0048 §1). One row per bin, one settle per data point. The felt cost of " +
      "getting a 'view in your room' model down — the AR analogue of a slow add-to-cart.",
    builder: "buildArPlacementTimeToPlace",
    endpoint: { method: "GET", path: "/api/v1/ar/placement/time-to-place" },
    grain: "bucket",
    dimensions: ["scene", "session"],
    filters: ["since", "until", "bins", "limit", "scene", "session", "bucketMs", "format"],
    row: z.object({ bucket: int, placements: int }),
    columns: {
      bucket: {
        description: "Inclusive lower bound of the time-to-place bin.",
        unit: "ms",
        label: true,
        axis: true,
      },
      placements: { description: "Placement settles in the bin.", unit: "count", measure: true },
    },
    limits: { maxRows: 1000, maxSummaryRows: 8 },
    interpretation:
      "A right shift over time means visitors are struggling more, not that the model got bigger. " +
      "Read it beside `ar_placement_attempts`, which separates 'slow to decide' from 'fought the UI'.",
    caveats: [
      "Requires AR placement capture (`trackArPlacement`, opt-in, ADR 0048).",
      "`timeToPlaceMs` rides in the event payload; settles without it bin at `0`.",
      "Only *settles* are counted — abandoned placements never emit an event, so the histogram survivor-biases toward success.",
    ],
    sourceChannels: ["ar_placement"],
    related: ["ar_placement_attempts", "ar_placement_surfaces"],
    comparable: { primary: "placements", direction: "neutral", minSample: 20 },
    category: "ar",
  },
  ar_placement_attempts: {
    id: "ar_placement_attempts",
    title: "AR re-placement distribution",
    description:
      "How many place / re-place actions visitors made before committing (#156, ADR 0048 §1). One " +
      "row per attempt count. `attempts = 1` is a clean first try; a long right tail is placement " +
      "friction.",
    builder: "buildArPlacementAttempts",
    endpoint: { method: "GET", path: "/api/v1/ar/placement/attempts" },
    grain: "bucket",
    dimensions: ["scene", "session"],
    filters: ["since", "until", "bins", "limit", "scene", "session", "format"],
    row: z.object({ attempts: int, placements: int }),
    columns: {
      attempts: {
        description: "Place / re-place actions before the settle.",
        unit: "count",
        label: true,
        axis: true,
      },
      placements: {
        description: "Settles that took exactly that many attempts.",
        unit: "count",
        measure: true,
      },
    },
    limits: { maxRows: 1000, maxSummaryRows: 8 },
    interpretation:
      "The share at `attempts = 1` is the clean-placement rate — the single number worth tracking " +
      "release over release.",
    caveats: [
      "Requires AR placement capture (`trackArPlacement`, opt-in, ADR 0048).",
      "`attempts` rides in the event payload and defaults to 1 when absent, so older data skews clean.",
      "Only settles are counted; abandoned placements are invisible here.",
    ],
    sourceChannels: ["ar_placement"],
    related: ["ar_placement_time_to_place", "ar_placement_surfaces"],
    comparable: { primary: "placements", direction: "neutral", minSample: 20 },
    category: "ar",
  },
  ar_placement_surfaces: {
    id: "ar_placement_surfaces",
    title: "AR placement surfaces",
    description:
      "Per coarse surface bucket — floor, wall, table, ceiling, unknown — how many settles landed " +
      "there and their average committed scale (#156, ADR 0048 §1). One row per surface. Shows " +
      "where visitors place models and how far off the authored size they settle.",
    builder: "buildArPlacementSurfaces",
    endpoint: { method: "GET", path: "/api/v1/ar/placement/surfaces" },
    grain: "row",
    dimensions: ["scene", "session"],
    filters: ["since", "until", "bins", "limit", "scene", "session", "format"],
    row: z.object({ surface: text, placements: int, avg_scale: num }),
    columns: {
      surface: {
        description: "Coarse surface bucket; `unknown` when unclassified.",
        unit: "label",
        label: true,
      },
      placements: { description: "Settles on the surface.", unit: "count", measure: true },
      avg_scale: {
        description: "Mean final scale; `1` means the authored real-world size.",
        unit: "ratio",
      },
    },
    limits: { maxRows: 1000, maxSummaryRows: 8 },
    interpretation:
      "An `avg_scale` far from 1 means the model's default size does not match how people actually " +
      "use it — a retail-configuration signal, not a tracking problem.",
    caveats: [
      "Requires AR placement capture (`trackArPlacement`, opt-in, ADR 0048).",
      "`surface` and `scale` ride in the event payload; unclassified settles group under `unknown`, which is often the largest bucket.",
      SMALL_SAMPLE,
    ],
    sourceChannels: ["ar_placement"],
    related: ["ar_placement_attempts", "ar_placement_time_to_place"],
    comparable: { primary: "avg_scale", direction: "neutral", minSample: 20 },
    category: "ar",
  },

  // =========================================================================
  // Conversion
  // =========================================================================
  funnel: {
    id: "funnel",
    title: "Conversion funnel",
    description:
      "An ordered, per-session conversion funnel over caller-supplied step predicates (ADR 0038): " +
      "how many sessions reached each step in order. One row per step, 0-based. The OSS collector " +
      "has no authoring surface, so the steps come from the caller.",
    builder: "buildFunnel",
    endpoint: { method: "GET", path: "/api/v1/funnel" },
    grain: "bucket",
    dimensions: ["scene", "cameraMode"],
    filters: ["since", "until", "scene", "cameraMode", "steps", "format"],
    row: z.object({ step: int, sessions: int }),
    columns: {
      step: {
        description: "0-based step index, in the order the caller supplied.",
        unit: "index",
        label: true,
        axis: true,
      },
      sessions: {
        description: "Sessions that reached the step in order.",
        unit: "sessions",
        measure: true,
      },
    },
    limits: { maxRows: 32, maxSummaryRows: 32 },
    interpretation:
      "Conversion into step k is `sessions[k] / sessions[k-1]`. Labels are the caller's concern — " +
      "the query returns indices only.",
    caveats: [
      "`steps` is required: a JSON array of at least two predicates matching on promoted columns only (`type`, `name`, `mesh`).",
      "Steps must happen in order within one session; a session that did them out of order does not convert.",
      "Predicates are pure equality on promoted columns — payload props are not queryable (ADR 0038).",
      "Fewer than ~50 sessions in the first step makes every downstream rate noise.",
    ],
    sourceChannels: [],
    related: ["scene_retention", "load_bounce_funnel", "variant_leaderboard"],
    comparable: { primary: "sessions", direction: "up", minSample: 50 },
    category: "conversion",
  },
  scene_retention: {
    id: "scene_retention",
    title: "Scene-to-scene retention",
    description:
      "Directed scene→scene links weighted by how many distinct sessions made each consecutive " +
      "transition (#147), derived purely from the observed order of `scene_change` markers. One " +
      "row per link, busiest first. The zero-config level funnel.",
    builder: "buildSceneRetention",
    endpoint: { method: "GET", path: "/api/v1/scene-retention" },
    grain: "row",
    dimensions: ["scene"],
    filters: ["since", "until", "limit", "format"],
    row: z.object({ from_scene: text, to_scene: text, sessions: int }),
    columns: {
      from_scene: { description: "Scene the session moved from.", unit: "id", label: true },
      to_scene: { description: "Scene it moved to next.", unit: "id" },
      sessions: {
        description: "Distinct sessions that made the transition.",
        unit: "sessions",
        measure: true,
      },
    },
    limits: { maxRows: 10000, maxSummaryRows: 10 },
    interpretation:
      "Weights are distinct sessions, so a link reads as level-to-level retention. Compare a " +
      "scene's outgoing total against its incoming total to find where players stop.",
    caveats: [
      "No scene filter by design — the whole point is the cross-scene flow.",
      "Sessions with a single `scene_change` contribute no link (there is no 'from'), and every session's last scene has no outgoing link.",
      "Apps that never call `setScene(...)` emit no `scene_change` and produce an empty result.",
      "Fewer than ~30 sessions per link makes ordering unreliable.",
    ],
    sourceChannels: ["scene_change"],
    related: ["funnel", "list_scenes", "load_bounce_funnel"],
    comparable: { primary: "sessions", direction: "up", minSample: 30 },
    category: "conversion",
  },
  load_bounce_funnel: {
    id: "load_bounce_funnel",
    title: "Load → bounce funnel",
    description:
      "Sessions bucketed by their initial load time, with how many bounced in each band (#152) — a " +
      "bounce being a session that produced no interaction at or after its first asset load. One " +
      "row per band. Turns 'slow loads cost you customers' into a number.",
    builder: "buildLoadBounceFunnel",
    endpoint: { method: "GET", path: "/api/v1/load-bounce" },
    grain: "bucket",
    dimensions: ["scene"],
    filters: ["since", "until", "scene", "bands", "format"],
    row: z.object({ band: int, sessions: int, bounced: int }),
    columns: {
      band: {
        description: "0-based band index, ordered by ascending load time.",
        unit: "index",
        label: true,
        axis: true,
      },
      sessions: { description: "Sessions whose initial load fell in the band.", unit: "sessions" },
      bounced: {
        description: "Of those, how many produced no interaction.",
        unit: "sessions",
        measure: true,
        rateOf: "sessions",
      },
    },
    limits: { maxRows: 17, maxSummaryRows: 17 },
    interpretation:
      "The bounce rate is `bounced / sessions`. The story is the *slope* across bands, not any one " +
      "band's rate — a rising slope is the load-time cost.",
    caveats: [
      "Band boundaries come from `bands` (default `1000,3000,5000`); labels are the caller's concern, and a different set makes results incomparable.",
      "A session's load time is the `loadMs` of its earliest `asset_load`; sessions with no `asset_load` in scope are excluded entirely.",
      "The engagement check is not re-bounded by `until`, so a load near the end of the window is not mis-counted as a bounce.",
      "Fewer than ~50 sessions in a band makes its rate noise.",
    ],
    sourceChannels: ["asset_load", "pointer_click", "mesh_interaction", "camera_gesture"],
    related: ["funnel", "perf_churn", "compile_stalls", "scene_retention"],
    comparable: { primary: "bounced", direction: "down", minSample: 50 },
    category: "conversion",
  },
  variant_leaderboard: {
    id: "variant_leaderboard",
    title: "Variant → conversion leaderboard",
    description:
      "For a product configurator (#150): per variant — a custom event grouped by its name — how " +
      "often it was viewed, over how many sessions, how many of those converted, and the mean " +
      "dwell before the visitor switched or converted. One row per variant, ranked by views.",
    builder: "buildVariantLeaderboard",
    endpoint: { method: "GET", path: "/api/v1/variant-leaderboard" },
    grain: "row",
    dimensions: ["name", "scene", "cameraMode"],
    filters: ["since", "until", "scene", "cameraMode", "variant", "conversion", "limit", "format"],
    row: z.object({
      variant: text,
      views: int,
      sessions: int,
      conversions: int,
      avg_dwell_ms: num,
    }),
    columns: {
      variant: {
        description: "Variant name (the custom event's `name`).",
        unit: "label",
        label: true,
      },
      views: { description: "Matching events fired.", unit: "count", measure: true },
      sessions: { description: "Distinct sessions that viewed the variant.", unit: "sessions" },
      conversions: {
        description:
          "Sessions that fired the conversion event at or after their first view; `0` with no `conversion` predicate.",
        unit: "sessions",
        rateOf: "sessions",
      },
      avg_dwell_ms: {
        description:
          "Mean time from a view to the next boundary (a switch to a different variant, or the conversion).",
        unit: "ms",
      },
    },
    limits: { maxRows: 500, maxSummaryRows: 10 },
    interpretation:
      "The conversion rate is `conversions / sessions`. `avg_dwell_ms` is considered time: a variant " +
      "with high dwell and low conversion is attractive but not convincing.",
    caveats: [
      "Variants are discriminated by the custom event's promoted `name` — payload `props` are not portably queryable (ADR 0038), so configurators must encode the variant in the name.",
      "`conversions` is 0 unless a `conversion` predicate is supplied; do not read that as a zero conversion rate.",
      "A re-view of the same variant is not a dwell boundary, and views with no later boundary are excluded from the average.",
      "Fewer than ~50 sessions per variant makes the ranking unreliable.",
    ],
    sourceChannels: ["custom"],
    related: ["funnel", "top_meshes", "scene_retention"],
    comparable: { primary: "conversions", direction: "up", minSample: 50 },
    category: "conversion",
  },
} satisfies Readonly<Record<MetricId, MetricDefinition>>;

/** The registry's own type, with each entry's literal `builder` preserved. */
export type MetricRegistry = typeof METRIC_REGISTRY;

/**
 * Every `build*` aggregation that a registry entry claims. Derived from the
 * literal `builder` values, which is why {@link METRIC_REGISTRY} is declared with
 * `satisfies` rather than a type annotation.
 */
type RegisteredBuilderName = {
  [K in MetricId]: MetricRegistry[K] extends { builder: infer B extends string } ? B : never;
}[MetricId];

/**
 * Names in {@link AGGREGATION_BUILDER_NAMES} that no registry entry claims.
 */
export type UnregisteredAggregation = Exclude<AggregationBuilderName, RegisteredBuilderName>;

/** Fails to compile unless `T` is `never`; the error names the offending member. */
type AssertNever<T extends never> = T;

/**
 * **Compile-time coverage guard (design sketch §A.3).** If you add a `build*`
 * aggregation to {@link AGGREGATION_BUILDER_NAMES} without a registry entry,
 * this line fails to typecheck and names the missing builder. Add the entry — a
 * new aggregation is not done until it has one. The runtime companions are this
 * package's `src/__tests__/registry.test.ts` (entry ↔ list) and `@uptimizr/db`'s
 * `src/__tests__/registry.test.ts` (list ↔ the real `build*` exports).
 */
export type NoUnregisteredAggregations = AssertNever<UnregisteredAggregation>;

/** Every registry id, in declaration order. */
export const METRIC_IDS = Object.keys(METRIC_REGISTRY) as readonly MetricId[];

/** Narrow an arbitrary string to a {@link MetricId}. */
export function isMetricId(value: string): value is MetricId {
  return Object.prototype.hasOwnProperty.call(METRIC_REGISTRY, value);
}

/** Look a metric up by id, or `undefined` when the id is unknown. */
export function getMetric(id: string): MetricDefinition | undefined {
  return isMetricId(id) ? (METRIC_REGISTRY[id] as MetricDefinition) : undefined;
}

/** Every registry entry as a plain array, typed as the shared interface. */
export function allMetrics(): readonly MetricDefinition[] {
  return METRIC_IDS.map((id) => METRIC_REGISTRY[id] as MetricDefinition);
}

/**
 * Reverse lookup: aggregation builder name → the metric that claims it.
 *
 * `MetricDefinition.builder` is the forward direction (a metric names its
 * builder); this is the direction the *store edge* needs — a `QuerySpec` knows
 * which aggregation produced it, and numeric coercion has to find that
 * aggregation's row schema (ADR 0051 §2). Built once, at module load: the
 * compile-time coverage guard below makes the mapping total over every exported
 * `build*`, and every builder is claimed by exactly one metric (asserted in
 * `src/__tests__/registry.test.ts`).
 */
export const METRIC_BY_BUILDER: ReadonlyMap<AggregationBuilderName, MetricDefinition> = new Map(
  METRIC_IDS.map((id) => METRIC_REGISTRY[id] as MetricDefinition)
    .filter((metric): metric is MetricDefinition & { builder: AggregationBuilderName } =>
      Boolean(metric.builder),
    )
    .map((metric) => [metric.builder, metric] as const),
);

/**
 * The registry entry that claims a given aggregation builder, or `undefined` for
 * the (currently empty) set of unclaimed builders.
 */
export function metricForBuilder(builder: AggregationBuilderName): MetricDefinition | undefined {
  return METRIC_BY_BUILDER.get(builder);
}

/**
 * A **resource** entry is a store read rather than an aggregation: it has no
 * `build*` builder, no time range, and is included so the generated agent
 * catalog stays a superset of the hand-written one (design sketch §A.4).
 */
export function isResourceMetric(metric: MetricDefinition): boolean {
  return metric.builder === undefined;
}
