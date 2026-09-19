/**
 * **Portable bucket measures** — the input side of the insight primitives
 * (ADR 0051 §4, design sketch §D).
 *
 * `baseline` and `movers` both answer questions about *one number moving over
 * time*: "what is normal for this scene", "what changed since last week". Both
 * therefore need the same thing from the store — a per-bucket series of a
 * comparable metric's `comparable.primary` column — and neither may compute
 * statistics in SQL, because five dialects' `quantile`, `median` and
 * `stddev` do not agree and the answer must not depend on which engine a
 * self-hoster chose.
 *
 * This module is the declaration that makes that series portable. For each
 * comparable registry metric it records **how to reproduce that metric's
 * primary column per time bucket** as a single grouped scan of `events`:
 *
 * - which capture channels the metric reads (`eventTypes`);
 * - a closed vocabulary of extra predicates (`where`) — a promoted-column
 *   equality or set membership, or a geometry-arity guard. Never free SQL, so
 *   nothing here can become an injection surface;
 * - the aggregate that produces the value (`count`, distinct `sessions`, `sum`,
 *   `avg`, `max`, `quantile`);
 * - how bucket values combine into a window total (`rollup`).
 *
 * `buckets.ts` renders exactly one generic query from this data, per dialect.
 *
 * ## What is *not* here, and why
 *
 * 42 of the registry's 63 `comparable` metrics have a faithful portable bucket
 * form. The rest do not, and are deliberately absent rather than approximated:
 *
 * - **funnel-shaped** metrics (`funnel`, `load_bounce_funnel`,
 *   `variant_leaderboard`, `scene_retention`) are defined by request-supplied
 *   step predicates or by a cohort that spans buckets — bucketing them changes
 *   what they mean;
 * - **join- or window-function-shaped** metrics (`click_rays`, `flow_links`,
 *   `mesh_reachability`, `navigation_stats`, `backtrack_ratio`,
 *   `xr_rotation`, `xr_abandonment`, `perf_churn`, `rage_clicks`) derive a row
 *   from the *relationship between consecutive events*, which a per-bucket
 *   `GROUP BY` cannot express without changing the answer at every bucket
 *   boundary;
 * - **per-session-then-aggregate** ratios (`jank_rate`) and payload-derived
 *   percentiles that are not promoted columns (`frame_time_percentiles`,
 *   `render_scale_truth`, `mesh_uv_heatmap`, `mesh_blind_spots`,
 *   `xr_boundary_contacts`) would need a second aggregation level or a JSON
 *   extraction whose null-handling differs from the metric's own.
 *
 * An approximate series is worse than no series: `baseline` would report a
 * "normal" that the metric's own endpoint never produces. Asking for one of
 * those metrics is a `400` naming the ids that *do* have a series
 * ({@link BUCKETABLE_METRIC_IDS}), which is a better answer than a plausible
 * wrong number. Widening the catalog is additive — add an entry here, a parity
 * case in `src/parity/cases.ts`, and the metric becomes available to both
 * primitives with no route or registry change.
 */

import type { MetricId } from "@uptimizr/metrics";

/** The two time grains an insight series can be bucketed at. */
export type BucketGrain = "day" | "hour";

/** Bucket width in seconds, the unit `Dialect.timeBucketMs` takes. */
export const BUCKET_SECONDS: Readonly<Record<BucketGrain, number>> = {
  day: 86_400,
  hour: 3_600,
};

/** Whether an arbitrary string names a supported bucket grain. */
export function isBucketGrain(value: string): value is BucketGrain {
  return value === "day" || value === "hour";
}

/**
 * Promoted numeric columns a measure may aggregate.
 *
 * Restricted to columns the events table actually promotes, so a measure never
 * needs a JSON extraction whose null semantics differ per engine. The one
 * exception is `ar_placement_scale`, which `buildArPlacementSurfaces` itself
 * reads with `jsonFloat` — it is rendered the same way here so the two agree.
 */
export type BucketValueColumn = "fps" | "visible_ms" | "js_heap_bytes" | "ar_placement_scale";

/**
 * A predicate a measure may add beyond its event-type filter.
 *
 * A closed vocabulary of three shapes over promoted columns only. Values are
 * compile-time constants declared in {@link BUCKET_MEASURES}, never request
 * input, and are bound as parameters regardless.
 */
export type BucketPredicate =
  /** `mesh`/`name`/`source` equals (or does not equal) a constant. `''` is the store's "unknown". */
  | {
      readonly kind: "eq" | "ne";
      readonly column: "mesh" | "name" | "source";
      readonly value: string;
    }
  /** `name`/`source` is one of a constant set. */
  | { readonly kind: "in"; readonly column: "name" | "source"; readonly values: readonly string[] }
  /**
   * A vector column carries a full coordinate (`arrayLength(col) = arity`) — the
   * same guard every spatial aggregation applies before it bins a point, so the
   * bucket count matches the heatmap's own row total.
   */
  | { readonly kind: "geometry"; readonly column: string; readonly arity: 2 | 3 };

/** The aggregate that turns a bucket's matching events into one value. */
export type BucketAggregate =
  | { readonly kind: "count" }
  | { readonly kind: "sessions" }
  | { readonly kind: "sum"; readonly column: BucketValueColumn }
  | { readonly kind: "avg"; readonly column: BucketValueColumn }
  | { readonly kind: "max"; readonly column: BucketValueColumn }
  | { readonly kind: "quantile"; readonly column: BucketValueColumn; readonly q: number };

/** How a metric's per-bucket values combine into one number for a whole window. */
export type BucketRollup =
  /** Additive quantities (counts, durations, sessions): the window value is the sum. */
  | "sum"
  /** Levels (an FPS median, a heap percentile, a scale): the window value is the mean of the buckets. */
  | "mean";

/** How to reproduce one metric's `comparable.primary` as a per-bucket series. */
export interface BucketMeasure {
  /**
   * The registry column this series stands for — always the metric's
   * `comparable.primary`, asserted in `src/__tests__/insights.test.ts`.
   */
  readonly column: string;
  /** Capture channels the series counts over. Empty means *every* event type. */
  readonly eventTypes: readonly string[];
  /** Extra predicates, ANDed with the event-type filter. */
  readonly where?: readonly BucketPredicate[];
  readonly aggregate: BucketAggregate;
  readonly rollup: BucketRollup;
  /** Where the bucket form differs in emphasis from the metric's own endpoint. */
  readonly note?: string;
}

/** Shorthand for the commonest measure: "count these channels' events per bucket". */
function counted(
  column: string,
  eventTypes: readonly string[],
  where?: readonly BucketPredicate[],
  note?: string,
): BucketMeasure {
  return {
    column,
    eventTypes,
    ...(where ? { where } : {}),
    aggregate: { kind: "count" },
    rollup: "sum",
    ...(note ? { note } : {}),
  };
}

/** A vector-column arity guard, matching the spatial aggregations' own. */
function geometry(column: string, arity: 2 | 3): BucketPredicate {
  return { kind: "geometry", column, arity };
}

/** The median-FPS series shared by every metric whose primary is `p50_fps`. */
const P50_FPS: BucketMeasure = {
  column: "p50_fps",
  eventTypes: ["frame_perf"],
  aggregate: { kind: "quantile", column: "fps", q: 0.5 },
  rollup: "mean",
  note:
    "The bucket series is the median over the bucket's raw `frame_perf` samples. The metric's own " +
    "endpoint computes per session and then aggregates (ADR 0028 §1), so a bucket median and the " +
    "endpoint's headline can differ slightly when one session dominates a bucket.",
};

/**
 * The portable bucket form of every comparable metric that has one, keyed by
 * metric id. See the module doc for what is deliberately absent.
 */
export const BUCKET_MEASURES: Readonly<Partial<Record<MetricId, BucketMeasure>>> = {
  // --- volume / orientation ------------------------------------------------
  list_sessions: counted("events", []),
  list_scenes: counted("events", []),
  timeseries: counted("events", []),
  event_counts: counted("count", []),
  events_daily: counted("events", []),

  // --- attention / spatial -------------------------------------------------
  // Each counts exactly the events its heatmap bins, geometry guard included, so
  // the series total equals the sum of the heatmap's own bin counts.
  pointer_heatmap: counted("count", ["pointer_move", "pointer_click"], [geometry("screen", 2)]),
  world_heatmap: counted("count", ["pointer_move", "pointer_click"], [geometry("hit_point", 3)]),
  gaze_heatmap: counted("count", ["camera_sample"], [geometry("hit_point", 3)]),
  camera_heatmap: counted("count", ["camera_sample"], [geometry("direction", 3)]),
  position_heatmap: counted("count", ["camera_sample"], [geometry("position", 3)]),
  scene_coverage: counted("count", ["camera_sample"], [geometry("position", 3)]),
  view_coverage_histogram: {
    column: "sessions",
    eventTypes: ["camera_sample"],
    aggregate: { kind: "sessions" },
    rollup: "sum",
    note:
      "Distinct sessions are counted *within* each bucket, so a session that spans two buckets " +
      "contributes to both and the window total is an upper bound on distinct sessions.",
  },

  // --- meshes / interaction -----------------------------------------------
  top_meshes: counted(
    "count",
    ["mesh_interaction", "pointer_click", "camera_sample"],
    [{ kind: "ne", column: "mesh", value: "" }],
  ),
  mesh_sources: counted(
    "count",
    ["mesh_interaction", "pointer_click"],
    [{ kind: "ne", column: "mesh", value: "" }],
  ),
  mesh_trend: counted(
    "count",
    ["mesh_interaction", "pointer_click"],
    [{ kind: "ne", column: "mesh", value: "" }],
  ),
  mesh_interaction_kinds: counted(
    "count",
    ["mesh_interaction"],
    [{ kind: "ne", column: "mesh", value: "" }],
  ),
  mesh_dwell: {
    column: "visible_ms",
    eventTypes: ["mesh_visibility"],
    where: [{ kind: "ne", column: "mesh", value: "" }],
    aggregate: { kind: "sum", column: "visible_ms" },
    rollup: "sum",
  },
  dead_clicks: counted(
    "dead_clicks",
    ["pointer_click"],
    [{ kind: "eq", column: "mesh", value: "" }],
    "Counts the clicks that hit nothing. The metric's own `total_clicks` denominator is not part " +
      "of the series — read `pointer_heatmap` alongside it for click volume.",
  ),
  hover_dwell: {
    column: "dwell_ms",
    eventTypes: ["hover_dwell"],
    aggregate: { kind: "sum", column: "visible_ms" },
    rollup: "sum",
  },
  interaction_sources: counted("count", [
    "pointer_click",
    "pointer_move",
    "mesh_interaction",
    "input_action",
  ]),
  top_input_actions: counted("count", ["input_action"]),
  camera_gestures: counted("gestures", ["camera_gesture"]),

  // --- performance ---------------------------------------------------------
  perf_summary: P50_FPS,
  perf_distribution: P50_FPS,
  perf_by_scene: P50_FPS,
  perf_by_device: P50_FPS,
  perf_daily: P50_FPS,
  perf_heatmap: {
    column: "avg_fps",
    eventTypes: ["frame_perf"],
    aggregate: { kind: "avg", column: "fps" },
    rollup: "mean",
  },
  fps_histogram: {
    column: "sessions",
    eventTypes: ["frame_perf"],
    aggregate: { kind: "sessions" },
    rollup: "sum",
    note:
      "Distinct sessions with perf samples, counted within each bucket; a session spanning two " +
      "buckets contributes to both.",
  },
  compile_stalls: {
    column: "total_ms",
    eventTypes: ["compile_stall"],
    aggregate: { kind: "sum", column: "visible_ms" },
    rollup: "sum",
  },
  resource_summary: {
    column: "max_js_heap_bytes",
    eventTypes: ["resource_sample"],
    aggregate: { kind: "max", column: "js_heap_bytes" },
    rollup: "mean",
    note: "Each bucket reports its own peak heap; the window value is the mean of those peaks.",
  },
  resource_percentiles: {
    column: "p95_js_heap_bytes",
    eventTypes: ["resource_sample"],
    aggregate: { kind: "quantile", column: "js_heap_bytes", q: 0.95 },
    rollup: "mean",
  },

  // --- errors / stability --------------------------------------------------
  stability_counts: counted("incidents", ["context_lost", "compile_stall"]),
  graphics_diagnostics: counted("incidents", ["graphics_diagnostic"]),
  error_heatmap: counted("count", ["runtime_error", "graphics_diagnostic"]),
  capability_changes: counted("changes", ["capability_change"]),
  rendering_technology: {
    column: "sessions",
    eventTypes: ["session_start"],
    aggregate: { kind: "sessions" },
    rollup: "sum",
  },

  // --- XR / AR -------------------------------------------------------------
  xr_locomotion: {
    column: "locomotion_ms",
    eventTypes: ["camera_gesture"],
    where: [{ kind: "in", column: "name", values: ["fly", "navigate"] }],
    aggregate: { kind: "sum", column: "visible_ms" },
    rollup: "sum",
  },
  xr_tracking_quality: {
    column: "degraded_ms",
    eventTypes: ["capability_change"],
    where: [{ kind: "eq", column: "name", value: "tracking" }],
    aggregate: { kind: "sum", column: "visible_ms" },
    rollup: "sum",
  },
  boundary_heatmap: counted("count", ["xr_boundary_proximity"]),
  ar_placement_time_to_place: counted("placements", ["ar_placement"]),
  ar_placement_attempts: counted("placements", ["ar_placement"]),
  ar_placement_surfaces: {
    column: "avg_scale",
    eventTypes: ["ar_placement"],
    aggregate: { kind: "avg", column: "ar_placement_scale" },
    rollup: "mean",
  },
};

/**
 * Every metric that has a portable bucket series, sorted — the list a `400`
 * quotes back when a caller asks for one that does not.
 */
export const BUCKETABLE_METRIC_IDS: readonly MetricId[] = (
  Object.keys(BUCKET_MEASURES) as MetricId[]
).sort();

/** The bucket measure for a metric, or `undefined` when it has no portable series. */
export function bucketMeasureFor(metric: string): BucketMeasure | undefined {
  return Object.prototype.hasOwnProperty.call(BUCKET_MEASURES, metric)
    ? BUCKET_MEASURES[metric as MetricId]
    : undefined;
}

/** Whether a metric id can be asked for a bucket series. */
export function isBucketableMetric(metric: string): boolean {
  return bucketMeasureFor(metric) != null;
}

/**
 * The metrics `movers` scans when the caller names none, in the order it scans
 * them, capped by {@link MOVERS_MAX_METRICS}.
 *
 * Curated rather than "every bucketable metric": each request costs one grouped
 * scan per metric, so an uncapped default would make a single `movers` call the
 * most expensive endpoint the collector serves. The list leads with the signals
 * a person actually asks "what changed?" about — traffic, performance, errors,
 * interaction — and covers each of them exactly once, so two entries never
 * report the same move twice under different names. Any other bucketable metric
 * is still reachable through the `metrics=` allowlist.
 */
export const MOVERS_DEFAULT_METRICS: readonly MetricId[] = [
  // traffic and reach
  "list_sessions",
  "fps_histogram",
  "rendering_technology",
  // performance
  "perf_summary",
  "perf_heatmap",
  "compile_stalls",
  "resource_percentiles",
  // errors and stability
  "error_heatmap",
  "stability_counts",
  "graphics_diagnostics",
  "capability_changes",
  // interaction
  "pointer_heatmap",
  "dead_clicks",
  "top_meshes",
  "mesh_interaction_kinds",
  "mesh_dwell",
  "hover_dwell",
  "top_input_actions",
  "camera_gestures",
  // attention and navigation
  "camera_heatmap",
  "gaze_heatmap",
  "scene_coverage",
  // XR / AR
  "xr_locomotion",
  "boundary_heatmap",
];

/**
 * The hard cap on how many metrics one `movers` request may scan.
 *
 * Each scanned metric is one grouped scan of `events` over the combined
 * reference+current window, so the cost of the endpoint is linear in this
 * number and bounded by it whatever the caller asks for. Enforced in two
 * places, both of which are visible to the caller: the route's `metrics=`
 * schema rejects a longer allowlist with a `400`, and
 * {@link MOVERS_DEFAULT_METRICS} is asserted to be no longer than this.
 */
export const MOVERS_MAX_METRICS = 24;
