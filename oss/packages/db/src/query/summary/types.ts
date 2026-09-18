/**
 * The public shapes of the three result envelopes (ADR 0051 §2, design sketch
 * §B.1). Types only — the functions that build them live in `summarize.ts`, the
 * Zod mirrors the collector serialises through in `schema.ts`.
 */

import type { ColumnUnit, MetricId } from "@uptimizr/metrics";

/**
 * The `format` querystring shared by every registry-served aggregate endpoint.
 *
 * - `full` — the bare rows exactly as they have always been returned. The
 *   default, and the mode the dashboard uses; its bytes must never change.
 * - `table` — the same rows, wrapped in a {@link TableMeta} envelope.
 * - `summary` — a bounded, self-describing digest ({@link ResultSummary}).
 */
export type ResultFormat = "full" | "table" | "summary";

/** Every `format` value, for a Zod enum / a tool schema. */
export const RESULT_FORMATS: readonly ResultFormat[] = ["full", "table", "summary"];

/** The requested time window, echoed back; `null` where the caller omitted it. */
export interface ResultRange {
  since: number | null;
  until: number | null;
}

/**
 * The filters that were actually applied, keyed by {@link
 * import("@uptimizr/metrics").FilterId}. `format` itself is never included — it
 * narrows nothing. Values are whatever the route's Zod schema produced (a
 * string, a number, a parsed `region` tuple…), so this is deliberately loose.
 */
export type AppliedFilters = Readonly<Record<string, unknown>>;

/**
 * How much data is behind the result, derived from the registry's column units
 * (see `sampleSizeOf`). `null` means the metric declares nothing that could
 * answer the question — never `0`, which would be a claim.
 */
export interface SampleSize {
  sessions: number | null;
  events: number | null;
}

/** The registry caps that bound the result. */
export interface ResultLimits {
  maxRows: number;
  maxSummaryRows: number;
}

/** The `meta` envelope `format=table` wraps the rows in. */
export interface TableMeta {
  metric: MetricId;
  range: ResultRange;
  filters: AppliedFilters;
  sampleSize: SampleSize;
  /** Number of rows in this response. */
  rows: number;
  /** Whether the row cap was reached, so more rows may exist. */
  truncated: boolean;
  limits: ResultLimits;
}

/** `format=table`: the same rows as `full`, plus the envelope. */
export interface TableResult<Row = unknown> {
  meta: TableMeta;
  rows: readonly Row[];
}

/** What `total` counts, so the number is self-describing. */
export interface SummaryMeasure {
  /** The column `total`, `value` and `weight` are read from. */
  column: string;
  /** Its registry unit, or `null` when the column declares none. */
  unit: ColumnUnit | null;
  /**
   * Whether values in this column may be added together. Shares are reported
   * only for additive measures — summing FPS or a ratio across rows would be a
   * lie, so `total` and every `share` are `null` when this is `false`.
   */
  additive: boolean;
}

/** A 95% Wilson score interval on a share. */
export interface ShareInterval {
  low: number;
  high: number;
}

/** The confidence note (sketch §B.1); present only when shares are proportions. */
export interface SummaryConfidence {
  kind: "wilson";
  level: number;
  note: string;
}

/** Filter values that would narrow a subsequent query to one summarised row. */
export type DrillHints = Readonly<Record<string, string>>;

/**
 * A complete, runnable `queryV1` document that narrows to one summarised row
 * (ADR 0051 §3, #304).
 *
 * {@link DrillHints} names the *filters*; this is the whole query with them
 * applied, so following a drill-down is a copy-paste rather than a
 * reconstruction — which is where a model reliably loses the range, the scene it
 * had already scoped to, or the `format` it was reading. Loosely typed because
 * `@uptimizr/db` does not depend on `@uptimizr/schema`; the collector puts a
 * parsed `QueryV1` in and a `QueryV1` comes out.
 */
export type DrillQuery = Readonly<Record<string, unknown>>;

/** One ranked row of a `kind: "ranked"` summary. */
export interface RankedRow {
  label: string;
  value: number | null;
  share: number | null;
  /** 95% Wilson interval on `share`; omitted when shares are not proportions. */
  shareInterval?: ShareInterval;
  /** Filters that would drill into this row; omitted when none apply. */
  drill?: DrillHints;
  /**
   * The same query, narrowed to this row — ready to run. Present only when the
   * caller told the summariser what the query was (`SummaryContext.query`) and
   * the row has drill filters.
   */
  drillQuery?: DrillQuery;
}

/** Everything the summary did not list individually. */
export interface RestBucket {
  rows: number;
  value: number | null;
  share: number | null;
}

/** Fields every summary carries, whatever its grain. */
export interface SummaryBase {
  metric: MetricId;
  range: ResultRange;
  filters: AppliedFilters;
  sampleSize: SampleSize;
  /** Sum of the measure across **all** rows; `null` when it cannot be summed. */
  total: number | null;
  /** What `total` measures; `null` when the metric declares no measure column. */
  measure: SummaryMeasure | null;
  confidence?: SummaryConfidence;
  /** One sentence, templated from column semantics only — never model-written. */
  reading: string;
  /** Registry caveats plus anything true only of this particular result. */
  caveats: readonly string[];
}

/** Leaderboard-shaped metrics: one row per mesh / scene / session / category. */
export interface RankedSummary extends SummaryBase {
  kind: "ranked";
  top: readonly RankedRow[];
  rest: RestBucket;
}

/** Which way a `bucket`-grain measure is moving across the range. */
export type TrendDirection = "up" | "down" | "flat";

/** The per-bucket digest of a `bucket`-grain metric. */
export interface SeriesDigest {
  /** The registry column the rows are ordered by (`axis: true`). */
  axis: string;
  /** Number of distinct buckets. */
  points: number;
  first: number | null;
  last: number | null;
  min: number | null;
  max: number | null;
  firstLabel: string | null;
  lastLabel: string | null;
  minLabel: string | null;
  maxLabel: string | null;
  trend: TrendDirection;
  /** Least-squares slope of the measure per bucket step. */
  slope: number | null;
}

/** Time series, histograms, funnels — anything ordered along one axis. */
export interface SeriesSummary extends SummaryBase {
  kind: "series";
  series: SeriesDigest;
}

/** One greedily-merged blob of adjacent occupied cells. */
export interface SpatialCluster {
  /** Weighted mean cell index per axis. */
  centroid: readonly number[];
  /** Inclusive bounding box of the cluster, in cell indices. */
  extent: { min: readonly number[]; max: readonly number[] };
  /** Occupied cells merged into it. */
  cells: number;
  /** Summed weight of those cells. */
  weight: number;
  share: number | null;
  drill?: DrillHints;
}

/** Everything the cluster list did not report individually. */
export interface ClusterRest {
  clusters: number;
  cells: number;
  weight: number | null;
  share: number | null;
}

/** Binned or voxelised metrics, summarised as hotspots rather than cells. */
export interface ClusterSummary extends SummaryBase {
  kind: "clusters";
  /** The registry columns (`unit: "index"`) that index the grid. */
  axes: readonly string[];
  /** Occupied (non-zero) cells in the result. */
  occupiedCells: number;
  /** Cells at or above this weight took part in the merge. */
  densityThreshold: number;
  clusters: readonly SpatialCluster[];
  rest: ClusterRest;
}

/** A rate a metric declares through `rateOf`, resolved against the row. */
export interface ResolvedRate {
  value: number | null;
  numerator: string;
  denominator: string;
}

/** Single-row metrics (`grain: "project"`): the row itself, plus its rates. */
export interface RecordSummary extends SummaryBase {
  kind: "record";
  record: Readonly<Record<string, string | number | boolean | null>>;
  rates: Readonly<Record<string, ResolvedRate>>;
}

/** `format=summary`: one of the four grain-driven shapes. */
export type ResultSummary = RankedSummary | SeriesSummary | ClusterSummary | RecordSummary;

/** What the caller knows about the request that produced the rows. */
export interface SummaryContext {
  /** The requested window; echoed into `range`. */
  range?: { since?: number | null; until?: number | null };
  /** Applied filter values; `format` is stripped for you. */
  filters?: Readonly<Record<string, unknown>>;
  /** The row cap that was in force, so `truncated` can be derived. */
  limit?: number;
  /**
   * The effective spatial cell size (ADR 0040 §1), when the collector resolved
   * one. Turns a cluster's cell-index extent into a world-space `region` drill
   * hint; without it a cluster reports indices only.
   */
  cellSize?: number;
  /**
   * The query that produced these rows, as a `queryV1` document. Given it, each
   * ranked row carries a `drillQuery`: the same query with one more filter.
   */
  query?: Readonly<Record<string, unknown>>;
  /** Extra caveats true of this result only, appended after the registry's. */
  caveats?: readonly string[];
  /** Override the cluster density threshold (default: mean weight per cell). */
  densityThreshold?: number;
  /** Override the row cap (default: the registry's `limits.maxSummaryRows`). */
  maxRows?: number;
}
