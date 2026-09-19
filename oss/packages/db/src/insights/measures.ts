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
export type BucketValueColumn =
  "fps" | "visible_ms" | "js_heap_bytes" | "long_frames" | "ar_placement_scale";

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

// --- anomalies (#306): the optional split dimension --------------------------
//
// `anomalies` answers "what inside this metric accounts for the excess?" by
// re-running the *same* measure grouped by one promoted column. That column is
// declared here, per metric, for the same reason the rest of the measure is: a
// closed, compile-time vocabulary can never become an injection surface, and a
// metric whose excess has no honest single explanation declares none and reports
// `contributor: null` rather than inventing one.
//
// Exactly **one** dimension per metric, deliberately. Attribution across two
// dimensions is a different (and much more expensive) question — "was it mobile,
// or was it the lobby?" — and answering it badly is worse than not answering it.

/** The promoted dimensions a bucket series may be split by. A `DimensionId` subset. */
export type BucketSplitDimension = "scene" | "mesh" | "name" | "source" | "event_type";

/** The `events` column behind each split dimension. */
export const BUCKET_SPLIT_COLUMNS: Readonly<Record<BucketSplitDimension, string>> = {
  scene: "scene_id",
  mesh: "mesh",
  name: "name",
  source: "source",
  event_type: "event_type",
};

/** Whether an arbitrary string names a supported split dimension. */
export function isBucketSplitDimension(value: string): value is BucketSplitDimension {
  return Object.prototype.hasOwnProperty.call(BUCKET_SPLIT_COLUMNS, value);
}

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
  /**
   * The one dimension this series can be split by, for `anomalies`' contributor
   * attribution (#306). Absent means the metric's excess has no single promoted
   * column that explains it, and the contributor is reported as `null`.
   */
  readonly splitBy?: BucketSplitDimension;
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

/**
 * Declare the dimension a measure's excess can be attributed to (#306).
 *
 * A wrapper rather than an extra parameter, so the catalog below stays one
 * expression per metric and giving a metric attribution is a purely additive
 * edit to its own line.
 */
function split(measure: BucketMeasure, splitBy: BucketSplitDimension): BucketMeasure {
  return { ...measure, splitBy };
}

/** The median-FPS series shared by every metric whose primary is `p50_fps`. */
const P50_FPS: BucketMeasure = {
  column: "p50_fps",
  eventTypes: ["frame_perf"],
  aggregate: { kind: "quantile", column: "fps", q: 0.5 },
  rollup: "mean",
  // The only promoted dimension a frame rate can be attributed to: an FPS drop
  // confined to one scene is a scene problem, one spread across them is a build
  // problem. Device is the split a reader would ask for next, but it lives in
  // the `session_start` payload rather than on the frame, so it is not reachable
  // from a single grouped scan of `events` (#306).
  splitBy: "scene",
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
  list_sessions: split(counted("events", []), "event_type"),
  list_scenes: split(counted("events", []), "scene"),
  timeseries: split(counted("events", []), "event_type"),
  event_counts: split(counted("count", []), "event_type"),
  events_daily: split(counted("events", []), "event_type"),

  // --- attention / spatial -------------------------------------------------
  // Each counts exactly the events its heatmap bins, geometry guard included, so
  // the series total equals the sum of the heatmap's own bin counts.
  pointer_heatmap: split(
    counted("count", ["pointer_move", "pointer_click"], [geometry("screen", 2)]),
    "event_type",
  ),
  world_heatmap: split(
    counted("count", ["pointer_move", "pointer_click"], [geometry("hit_point", 3)]),
    "mesh",
  ),
  gaze_heatmap: split(counted("count", ["camera_sample"], [geometry("hit_point", 3)]), "mesh"),
  camera_heatmap: split(counted("count", ["camera_sample"], [geometry("direction", 3)]), "scene"),
  position_heatmap: split(counted("count", ["camera_sample"], [geometry("position", 3)]), "scene"),
  scene_coverage: split(counted("count", ["camera_sample"], [geometry("position", 3)]), "scene"),
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
  top_meshes: split(
    counted(
      "count",
      ["mesh_interaction", "pointer_click", "camera_sample"],
      [{ kind: "ne", column: "mesh", value: "" }],
    ),
    "mesh",
  ),
  mesh_sources: split(
    counted(
      "count",
      ["mesh_interaction", "pointer_click"],
      [{ kind: "ne", column: "mesh", value: "" }],
    ),
    "source",
  ),
  mesh_trend: split(
    counted(
      "count",
      ["mesh_interaction", "pointer_click"],
      [{ kind: "ne", column: "mesh", value: "" }],
    ),
    "mesh",
  ),
  mesh_interaction_kinds: split(
    counted("count", ["mesh_interaction"], [{ kind: "ne", column: "mesh", value: "" }]),
    "name",
  ),
  mesh_dwell: {
    column: "visible_ms",
    eventTypes: ["mesh_visibility"],
    where: [{ kind: "ne", column: "mesh", value: "" }],
    aggregate: { kind: "sum", column: "visible_ms" },
    rollup: "sum",
    splitBy: "mesh",
  },
  dead_clicks: split(
    counted(
      "dead_clicks",
      ["pointer_click"],
      [{ kind: "eq", column: "mesh", value: "" }],
      "Counts the clicks that hit nothing. The metric's own `total_clicks` denominator is not " +
        "part of the series — read `pointer_heatmap` alongside it for click volume.",
    ),
    "source",
  ),
  hover_dwell: {
    column: "dwell_ms",
    eventTypes: ["hover_dwell"],
    aggregate: { kind: "sum", column: "visible_ms" },
    rollup: "sum",
    splitBy: "mesh",
  },
  interaction_sources: split(
    counted("count", ["pointer_click", "pointer_move", "mesh_interaction", "input_action"]),
    "source",
  ),
  top_input_actions: split(counted("count", ["input_action"]), "name"),
  camera_gestures: split(counted("gestures", ["camera_gesture"]), "name"),

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
    splitBy: "scene",
  },
  fps_histogram: {
    column: "sessions",
    eventTypes: ["frame_perf"],
    aggregate: { kind: "sessions" },
    rollup: "sum",
    splitBy: "scene",
    note:
      "Distinct sessions with perf samples, counted within each bucket; a session spanning two " +
      "buckets contributes to both.",
  },
  compile_stalls: {
    column: "total_ms",
    eventTypes: ["compile_stall"],
    aggregate: { kind: "sum", column: "visible_ms" },
    rollup: "sum",
    splitBy: "name",
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
  stability_counts: split(counted("incidents", ["context_lost", "compile_stall"]), "event_type"),
  graphics_diagnostics: split(counted("incidents", ["graphics_diagnostic"]), "scene"),
  error_heatmap: split(counted("count", ["runtime_error", "graphics_diagnostic"]), "event_type"),
  capability_changes: split(counted("changes", ["capability_change"]), "name"),
  rendering_technology: {
    column: "sessions",
    eventTypes: ["session_start"],
    aggregate: { kind: "sessions" },
    rollup: "sum",
    splitBy: "scene",
  },

  // --- XR / AR -------------------------------------------------------------
  xr_locomotion: {
    column: "locomotion_ms",
    eventTypes: ["camera_gesture"],
    where: [{ kind: "in", column: "name", values: ["fly", "navigate"] }],
    aggregate: { kind: "sum", column: "visible_ms" },
    rollup: "sum",
    splitBy: "name",
  },
  xr_tracking_quality: {
    column: "degraded_ms",
    eventTypes: ["capability_change"],
    where: [{ kind: "eq", column: "name", value: "tracking" }],
    aggregate: { kind: "sum", column: "visible_ms" },
    rollup: "sum",
  },
  boundary_heatmap: split(counted("count", ["xr_boundary_proximity"]), "scene"),
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

// =========================================================================
// --- significance / scene health (#307) ----------------------------------
//
// `significance` and `scene_health` need two things the catalog above cannot
// express, and both are the *same* shape of need: a series that belongs to a
// metric but is not that metric's headline column.
//
// - `significance` runs a two-proportion test only when it can see a
//   **denominator** — the `rateOf` column the registry already declares beside
//   a rate. `dead_clicks` is `dead_clicks / total_clicks`; the catalog above
//   carries the numerator, and the denominator is a second series of the same
//   shape.
// - `scene_health` needs one series per factor, and three of its six factors
//   are ratios ("errors per session", "long frames per sampled window") while a
//   fourth wants the *tail* of the FPS distribution rather than its middle.
//
// Both are served by one additive mechanism: a metric may declare **named
// auxiliary measures** beside its main one. A variant is an ordinary
// {@link BucketMeasure} — the same closed predicate vocabulary, the same
// aggregates, rendered by the same `buildMetricBuckets` — so it costs no new
// SQL and no new parity surface beyond the aggregate shapes it introduces.
//
// The variant name is **never** caller input. `significance` picks
// `denominator` when the registry says the metric is a rate, and `scene_health`
// reads a fixed factor catalog; no querystring reaches this lookup. That is
// what keeps the "nothing a caller can influence becomes SQL text" property of
// `buckets.ts` intact.
//
// Two of the metrics below (`jank_rate`, `xr_abandonment`) have **no** main
// measure and are absent from {@link BUCKET_MEASURES} on purpose: their own
// endpoints aggregate per session first, or need an anti-join, so there is no
// faithful per-bucket form of *their headline column* and `baseline` / `movers`
// must keep rejecting them. A variant makes a different, honestly-named
// quantity available ("long frames per sampled window", "XR interactions per XR
// session") for the health factors that need one — it does not make the metric
// bucketable, and `isBucketableMetric` deliberately still says so.
// =========================================================================

/**
 * The named auxiliary series a metric may declare.
 *
 * - `denominator` — the `rateOf` column beside a rate numerator;
 * - `numerator` — the counted part of a ratio whose metric has no main measure;
 * - `p05` — the 5th percentile of a distribution whose main measure is its median.
 */
export type BucketVariant = "numerator" | "denominator" | "p05";

/** XR input sources (ADR 0011) — the same set `buildXrAbandonment` restricts to. */
const XR_SOURCES = ["xr-controller", "hand", "gaze", "transient"] as const;

/** Event channels that carry the input-source vocabulary, as `xr_abandonment` reads them. */
const XR_INTERACTION_CHANNELS = ["pointer_click", "pointer_move", "mesh_interaction"] as const;

/** Distinct sessions per bucket — the denominator of every "per session" factor. */
function perSessionDenominator(eventTypes: readonly string[], note: string): BucketMeasure {
  return {
    column: "sessions",
    eventTypes,
    aggregate: { kind: "sessions" },
    rollup: "sum",
    note,
  };
}

/**
 * Named auxiliary series, by metric. See the section header for why these are
 * separate from {@link BUCKET_MEASURES} rather than entries in it.
 */
export const BUCKET_MEASURE_VARIANTS: Readonly<
  Partial<Record<MetricId, Readonly<Partial<Record<BucketVariant, BucketMeasure>>>>>
> = {
  // The `rateOf` denominator of the dead-click rate: every click, not only the
  // ones that hit nothing. `dead_clicks / total_clicks` is then a genuine
  // proportion, which is what makes a two-proportion test legitimate.
  dead_clicks: {
    denominator: counted("total_clicks", ["pointer_click"]),
  },

  // The tail of the FPS distribution rather than its middle. Health asks "how
  // bad does it get here", and a scene whose median is 60 while its 5th
  // percentile is 12 is not a smooth scene — the median alone cannot say that.
  perf_summary: {
    p05: {
      column: "p50_fps",
      eventTypes: ["frame_perf"],
      aggregate: { kind: "quantile", column: "fps", q: 0.05 },
      rollup: "mean",
      note:
        "The 5th percentile of the bucket's raw `frame_perf` samples — the frame rate in the " +
        "worst twentieth of sampled windows, not the median the metric's own headline reports.",
    },
  },

  // `jank_rate`'s own endpoint computes a rate per session and then takes the
  // median of those (ADR 0028 §1), which no `GROUP BY` reproduces. This pair is
  // the *pooled* rate over the same raw material: long frames per sampled
  // window, across every session in the bucket. A different statistic, named as
  // one, and the only portable one.
  jank_rate: {
    numerator: {
      column: "total_long_frames",
      eventTypes: ["frame_perf"],
      aggregate: { kind: "sum", column: "long_frames" },
      rollup: "sum",
      note:
        "Long frames summed across every session in the bucket. The metric's own `median_rate` " +
        "is a per-session median, so the two agree in direction but not in value.",
    },
    denominator: counted(
      "sessions",
      ["frame_perf"],
      undefined,
      "Sampled perf windows in scope — the denominator the SDK's own rate is per.",
    ),
  },

  // Errors per session. The numerator is the metric's own count; the
  // denominator is sessions, because an error count with no traffic behind it
  // says nothing — twice the errors on three times the visitors is an
  // improvement.
  error_heatmap: {
    denominator: perSessionDenominator(
      ["session_start"],
      "Sessions started in the bucket — the denominator that turns an error count into a rate.",
    ),
  },

  // Exploration per session. A true voxel-coverage *percentage* needs the
  // scene's registered bounds (`scene_representation`) and has no portable
  // per-bucket form; positioned camera samples per session is the portable
  // proxy, and it is normalised against the project's own baseline rather than
  // read as an absolute.
  scene_coverage: {
    denominator: perSessionDenominator(
      ["camera_sample"],
      "Sessions that produced a camera sample in the bucket.",
    ),
  },

  // XR interactions per XR session. `xr_abandonment`'s own endpoint needs a
  // session-level anti-join; this pair is the portable inverse signal — a
  // headset session that interacts with nothing is the abandonment the metric
  // is looking for. Both sides are restricted to XR input sources, so the
  // factor is absent (rather than zero) in a project with no XR traffic.
  xr_abandonment: {
    numerator: counted("xr_interactions", XR_INTERACTION_CHANNELS, [
      { kind: "in", column: "source", values: XR_SOURCES },
    ]),
    denominator: {
      column: "session_id",
      eventTypes: XR_INTERACTION_CHANNELS,
      where: [{ kind: "in", column: "source", values: XR_SOURCES }],
      aggregate: { kind: "sessions" },
      rollup: "sum",
      note: "Distinct sessions that produced at least one XR-sourced interaction in the bucket.",
    },
  },
};

/**
 * The auxiliary series a metric declares under `variant`, or `undefined`.
 *
 * Kept separate from {@link bucketMeasureFor} so that "has a portable bucket
 * series" — the question `baseline` and `movers` validate a caller's `metric`
 * against — keeps meaning exactly what it meant before: a faithful per-bucket
 * form of the metric's *own* headline column.
 */
export function bucketVariantFor(
  metric: string,
  variant: BucketVariant,
): BucketMeasure | undefined {
  if (!Object.prototype.hasOwnProperty.call(BUCKET_MEASURE_VARIANTS, metric)) return undefined;
  return BUCKET_MEASURE_VARIANTS[metric as MetricId]?.[variant];
}

/**
 * The measure a bucket read resolves to: a metric's main series, or the named
 * auxiliary one. The single lookup `buildMetricBuckets` and
 * `evaluateBucketMeasure` share, so the SQL and the in-memory path cannot
 * resolve the same request differently.
 */
export function resolveBucketMeasure(
  metric: string,
  variant?: BucketVariant,
): BucketMeasure | undefined {
  return variant == null ? bucketMeasureFor(metric) : bucketVariantFor(metric, variant);
}
