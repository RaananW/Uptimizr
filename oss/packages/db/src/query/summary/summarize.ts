/**
 * **Agent-shaped result envelopes** (ADR 0051 §2, design sketch §B.1).
 *
 * `summarizeRows(metric, rows, ctx)` and `tableResult(metric, rows, ctx)` are
 * the two functions the collector calls to turn an aggregation's rows into the
 * `table` and `summary` envelopes. They are pure, registry-driven and
 * browser-safe: no store, no I/O, no `node:` import — everything they know about
 * a metric comes from its {@link MetricDefinition}.
 *
 * ## Which summary a metric gets
 *
 * The `grain` decides, because the grain is what makes a row *mean* something:
 *
 * | grain                      | shape       | what it reports                              |
 * | -------------------------- | ----------- | -------------------------------------------- |
 * | `bucket`                   | `series`    | first/last/min/max, trend and slope           |
 * | `bin`, `voxel`             | `clusters`  | greedily merged hotspots (`cluster.ts`)       |
 * | `project` (or no `label`)  | `record`    | the single row, plus its `rateOf` rates       |
 * | everything else            | `ranked`    | top rows by the measure, with a `rest` bucket |
 *
 * A metric that cannot produce its grain's shape (a `bin` metric that declares
 * too few `index` columns, say) falls back to `ranked`, so every metric always
 * gets *a* summary.
 *
 * ## Shares are only claimed where they are true
 *
 * `total` and every `share` are reported only when the measure's unit is
 * additive (`format.ts`). Summing FPS or a ratio across meshes produces a number
 * that means nothing, and a share derived from it would be worse than no share
 * at all — so those come back `null` and the `reading` says why.
 *
 * ## Bounded, always
 *
 * `top` and `clusters` are capped at the registry's `limits.maxSummaryRows`.
 * That is the whole point of the envelope: a 500-bin heatmap must cost the same
 * number of tokens as a 5-bin one.
 */

import { getMetric, type MetricDefinition, type MetricId } from "@uptimizr/metrics";
import { clusterCells, type GridCell } from "./cluster.js";
import {
  axisColumn,
  columnsOf,
  type Column,
  gridColumns,
  labelColumn,
  measureColumn,
  numberAt,
  sampleSizeOf,
  sumColumn,
  weightColumn,
} from "./columns.js";
import { isAdditiveUnit } from "./format.js";
import { labelClusters } from "./labels.js";
import { readingFor, type UnreadSummary } from "./reading.js";
import { leastSquaresSlope, trendOf, wilsonInterval, Z_95 } from "./stats.js";
import type {
  AppliedFilters,
  ClusterSummary,
  DrillHints,
  RankedRow,
  RankedSummary,
  RecordSummary,
  ResolvedRate,
  ResultLimits,
  ResultRange,
  ResultSummary,
  SeriesSummary,
  SpatialCluster,
  SummaryBase,
  SummaryConfidence,
  SummaryContext,
  SummaryMeasure,
  TableResult,
} from "./types.js";

/** A row as it leaves a store: a flat bag of scalars. */
export type ResultRow = Readonly<Record<string, unknown>>;

/**
 * Filters a summarised row can be narrowed by. Restricted to the filters the
 * metric itself accepts, so every hint is directly actionable — a hint an
 * endpoint would silently ignore is worse than no hint.
 */
const DRILL_FILTERS = ["scene", "session", "mesh", "source"] as const;

/** Resolve an id or a definition to a definition. */
function resolve(metric: MetricId | MetricDefinition): MetricDefinition | undefined {
  return typeof metric === "string" ? getMetric(metric) : metric;
}

/** The requested window, normalised to `null` where the caller omitted it. */
function rangeOf(ctx: SummaryContext): ResultRange {
  return { since: ctx.range?.since ?? null, until: ctx.range?.until ?? null };
}

/**
 * Applied filters with `format` and anything unset stripped. Iterates the
 * metric's **declared** filter and path-parameter ids (a closed registry
 * allowlist) rather than the keys of the request object, so an unexpected key
 * can never become a property of the envelope.
 */
function filtersOf(metric: MetricDefinition, ctx: SummaryContext): AppliedFilters {
  const out: Record<string, unknown> = {};
  const source = ctx.filters ?? {};
  const declared = [...metric.filters, ...(metric.endpoint?.pathParams ?? [])];
  for (const id of declared) {
    if (id === "format") continue;
    const value = Object.hasOwn(source, id) ? source[id] : undefined;
    if (value === undefined || value === null) continue;
    out[id] = value;
  }
  return out;
}

function limitsOf(metric: MetricDefinition): ResultLimits {
  return { maxRows: metric.limits.maxRows, maxSummaryRows: metric.limits.maxSummaryRows };
}

/** Whether the row cap was reached, so more rows may exist behind it. */
function isTruncated(
  metric: MetricDefinition,
  rows: readonly ResultRow[],
  ctx: SummaryContext,
): boolean {
  const cap = ctx.limit ?? metric.limits.maxRows;
  return Number.isFinite(cap) && rows.length >= cap;
}

/** What `total` counts, and whether it may be summed at all. */
function measureOf(column: Column | undefined): SummaryMeasure | null {
  if (column == null) return null;
  const [name, semantics] = column;
  return { column: name, unit: semantics.unit ?? null, additive: isAdditiveUnit(semantics.unit) };
}

/** Registry caveats plus the ones that are only true of *this* result. */
function caveatsFor(
  metric: MetricDefinition,
  rows: readonly ResultRow[],
  ctx: SummaryContext,
  extra: readonly string[] = [],
): string[] {
  const caveats = [...metric.caveats, ...extra, ...(ctx.caveats ?? [])];
  if (rows.length === 0) {
    caveats.push(
      "No rows matched the selected range and filters — read this as 'no data', not as zero.",
    );
  }
  if (isTruncated(metric, rows, ctx)) {
    caveats.push(
      `Rows were capped at ${ctx.limit ?? metric.limits.maxRows}; totals and shares below describe ` +
        "the returned rows only, not the whole range.",
    );
  }
  return caveats;
}

/** Filters that would narrow a subsequent query to this row. */
function drillFor(metric: MetricDefinition, row: ResultRow): DrillHints | undefined {
  const hints: Record<string, string> = {};
  for (const filter of DRILL_FILTERS) {
    if (!metric.filters.includes(filter)) continue;
    const column = [filter, `${filter}_id`].find(
      (candidate) => candidate in metric.columns && candidate in row,
    );
    if (column == null) continue;
    const value = row[column];
    if (typeof value === "string" && value.length > 0) hints[filter] = value;
  }
  return Object.keys(hints).length > 0 ? hints : undefined;
}

/** The Wilson note, present only when the shares really are proportions. */
function confidenceFor(
  measure: SummaryMeasure | null,
  total: number | null,
): SummaryConfidence | undefined {
  if (measure == null || !measure.additive || total == null || total <= 0) return undefined;
  if (measure.unit !== "count" && measure.unit !== "sessions") return undefined;
  const noun = measure.unit === "sessions" ? "sessions" : "events";
  return {
    kind: "wilson",
    level: 0.95,
    note:
      `Shares are proportions of ${total} ${noun}; each \`shareInterval\` is a 95% Wilson score ` +
      "interval, which stays inside 0..1 at the small counts a long tail produces.",
  };
}

// --- table ----------------------------------------------------------------

/**
 * `format=table`: the same rows as `full`, wrapped in a `meta` envelope that
 * says what they are, what was asked for, how much data is behind them and
 * whether the row cap hid any.
 */
export function tableResult<Row extends ResultRow>(
  metric: MetricId | MetricDefinition,
  rows: readonly Row[],
  ctx: SummaryContext = {},
): TableResult<Row> | null {
  const definition = resolve(metric);
  if (definition == null) return null;
  return {
    meta: {
      metric: definition.id,
      range: rangeOf(ctx),
      filters: filtersOf(definition, ctx),
      sampleSize: sampleSizeOf(definition, rows),
      rows: rows.length,
      truncated: isTruncated(definition, rows, ctx),
      limits: limitsOf(definition),
    },
    rows,
  };
}

// --- summary --------------------------------------------------------------

/** Fields every summary shares, computed once. */
function baseOf(
  metric: MetricDefinition,
  rows: readonly ResultRow[],
  ctx: SummaryContext,
  measure: SummaryMeasure | null,
  total: number | null,
  extraCaveats: readonly string[] = [],
): Omit<SummaryBase, "reading"> {
  const confidence = confidenceFor(measure, total);
  return {
    metric: metric.id,
    range: rangeOf(ctx),
    filters: filtersOf(metric, ctx),
    sampleSize: sampleSizeOf(metric, rows),
    total,
    measure,
    ...(confidence != null ? { confidence } : {}),
    caveats: caveatsFor(metric, rows, ctx, extraCaveats),
  };
}

function rankedSummary(
  metric: MetricDefinition,
  rows: readonly ResultRow[],
  ctx: SummaryContext,
  cap: number,
): UnreadSummary<RankedSummary> {
  const measureCol = measureColumn(metric);
  const labelCol = labelColumn(metric);
  const measure = measureOf(measureCol);
  const total = measure?.additive === true ? sumColumn(rows, measureCol?.[0]) : null;

  // Rank by the measure, highest first; ties fall back to the label so the order
  // is a function of the row *set* rather than of what the store happened to emit.
  const ordered = [...rows].sort((a, b) => {
    const left = measureCol == null ? null : numberAt(a, measureCol[0]);
    const right = measureCol == null ? null : numberAt(b, measureCol[0]);
    if (left !== right) {
      if (left == null) return 1;
      if (right == null) return -1;
      return right - left;
    }
    const leftLabel = labelCol == null ? "" : String(a[labelCol[0]] ?? "");
    const rightLabel = labelCol == null ? "" : String(b[labelCol[0]] ?? "");
    return leftLabel < rightLabel ? -1 : leftLabel > rightLabel ? 1 : 0;
  });

  const listed = ordered.slice(0, cap);
  // A Wilson interval is only meaningful where the share really is a proportion
  // of a count — the same condition that decides whether `confidence` is present.
  const proportional = confidenceFor(measure, total) != null;
  const top: RankedRow[] = listed.map((row) => {
    const value = measureCol == null ? null : numberAt(row, measureCol[0]);
    const share = total != null && total > 0 && value != null ? value / total : null;
    const interval =
      proportional && value != null && total != null ? wilsonInterval(value, total, Z_95) : null;
    const drill = drillFor(metric, row);
    return {
      label: labelCol == null ? "" : String(row[labelCol[0]] ?? ""),
      value,
      share,
      ...(interval != null ? { shareInterval: interval } : {}),
      ...(drill != null ? { drill } : {}),
    };
  });

  const listedValue = measureCol == null ? null : sumColumn(listed, measureCol[0]);
  const restValue = total != null && listedValue != null ? total - listedValue : null;
  return {
    ...baseOf(metric, rows, ctx, measure, total),
    kind: "ranked",
    top,
    rest: {
      rows: Math.max(0, rows.length - listed.length),
      value: restValue,
      share: total != null && total > 0 && restValue != null ? restValue / total : null,
    },
  };
}

function seriesSummary(
  metric: MetricDefinition,
  rows: readonly ResultRow[],
  ctx: SummaryContext,
): UnreadSummary<SeriesSummary> | null {
  const axis = axisColumn(metric);
  const measureCol = measureColumn(metric);
  if (axis == null || measureCol == null) return null;
  const measure = measureOf(measureCol);

  // Collapse every row sharing a bucket. Additive measures sum (`mesh_trend` is
  // one row per mesh *and* bucket); non-additive ones average, because adding
  // two days' median FPS together would be meaningless.
  const buckets = new Map<string, { key: unknown; sum: number; count: number }>();
  for (const row of rows) {
    const key = row[axis[0]];
    const value = numberAt(row, measureCol[0]);
    if (value == null) continue;
    const id = typeof key === "number" ? `n:${key}` : `s:${String(key ?? "")}`;
    const bucket = buckets.get(id);
    if (bucket) {
      bucket.sum += value;
      bucket.count += 1;
    } else {
      buckets.set(id, { key, sum: value, count: 1 });
    }
  }

  const points = [...buckets.values()]
    .map((bucket) => ({
      key: bucket.key,
      value: measure?.additive === true ? bucket.sum : bucket.sum / bucket.count,
    }))
    .sort((a, b) => {
      if (typeof a.key === "number" && typeof b.key === "number") return a.key - b.key;
      const left = String(a.key ?? "");
      const right = String(b.key ?? "");
      return left < right ? -1 : left > right ? 1 : 0;
    });

  const values = points.map((point) => point.value);
  const slope = leastSquaresSlope(values);
  const lowest = points.reduce<(typeof points)[number] | undefined>(
    (best, point) => (best == null || point.value < best.value ? point : best),
    undefined,
  );
  const highest = points.reduce<(typeof points)[number] | undefined>(
    (best, point) => (best == null || point.value > best.value ? point : best),
    undefined,
  );
  const first = points[0];
  const last = points[points.length - 1];
  const total = measure?.additive === true ? sumColumn(rows, measureCol[0]) : null;

  const labelOf = (point: { key: unknown } | undefined): string | null =>
    point == null ? null : point.key == null ? null : String(point.key);

  return {
    ...baseOf(metric, rows, ctx, measure, total),
    kind: "series",
    series: {
      axis: axis[0],
      points: points.length,
      first: first?.value ?? null,
      last: last?.value ?? null,
      min: lowest?.value ?? null,
      max: highest?.value ?? null,
      firstLabel: labelOf(first),
      lastLabel: labelOf(last),
      minLabel: labelOf(lowest),
      maxLabel: labelOf(highest),
      trend: trendOf(values, slope),
      slope,
    },
  };
}

function clusterSummary(
  metric: MetricDefinition,
  rows: readonly ResultRow[],
  ctx: SummaryContext,
  cap: number,
): UnreadSummary<ClusterSummary> | null {
  const axes = gridColumns(metric, metric.grain === "voxel" ? 3 : 2);
  const weightCol = weightColumn(metric);
  if (axes == null || weightCol == null) return null;
  const measure = measureOf(weightCol);
  if (measure == null || !measure.additive) return null;

  const cells: GridCell[] = [];
  for (const row of rows) {
    const coords = axes.map(([name]) => numberAt(row, name));
    if (coords.some((coordinate) => coordinate == null)) continue;
    const weight = numberAt(row, weightCol[0]);
    if (weight == null) continue;
    cells.push({ coords: coords as number[], weight });
  }

  const result = clusterCells(cells, {
    densityThreshold: ctx.densityThreshold,
    maxClusters: cap,
  });
  const total = result.totalWeight > 0 ? result.totalWeight : null;

  // A cluster's world-space box, when the collector told us the effective cell
  // size and the metric accepts a `region` drill-down (ADR 0040 §4).
  const canDrillRegion =
    ctx.cellSize != null &&
    ctx.cellSize > 0 &&
    axes.length === 3 &&
    metric.filters.includes("region");
  const boxed: SpatialCluster[] = result.clusters.map((cluster) => {
    if (!canDrillRegion) return cluster;
    const size = ctx.cellSize as number;
    const box = [
      ...cluster.extent.min.map((value) => value * size),
      ...cluster.extent.max.map((value) => (value + 1) * size),
    ];
    return { ...cluster, drill: { region: box.join(",") } };
  });

  // Spatial labelling (ADR 0051 §2, sketch §B.2): when the collector handed us
  // the scene's regions and proxy boxes, each hotspot is named — the region it
  // falls in and the mesh it sits on — and a containing region upgrades the
  // `drill.region` hint from an ad-hoc box to the region's own id.
  const labelled =
    ctx.scene != null && ctx.cellSize != null
      ? labelClusters(boxed, {
          axes: axes.map(([name]) => name),
          cellSize: ctx.cellSize,
          scene: ctx.scene,
        })
      : null;
  const clusters = labelled?.clusters ?? boxed;

  const extraCaveats =
    result.occupiedCells > 0
      ? [
          `Hotspots are merged from cells at or above a density threshold of ` +
            `${result.densityThreshold} (the mean weight per occupied cell); looser cells are ` +
            "reported in `rest` rather than clustered.",
          labelled?.labelled === true
            ? "Cluster coordinates are grid indices, not world coordinates — multiply by the " +
              "effective `cellSize` to place them (ADR 0040 §1). `region` / `nearestMesh` label " +
              "each hotspot against the scene registry; `distance` is in world units and `0` " +
              "means the mesh box contains the hotspot."
            : "Cluster coordinates are grid indices, not world coordinates — multiply by the " +
              "effective `cellSize` to place them (ADR 0040 §1). Spatial labelling (nearest " +
              "mesh, named region) is not part of this envelope.",
          ...(labelled?.caveats ?? []),
        ]
      : [];

  return {
    ...baseOf(metric, rows, ctx, measure, total, extraCaveats),
    kind: "clusters",
    axes: axes.map(([name]) => name),
    occupiedCells: result.occupiedCells,
    densityThreshold: result.densityThreshold,
    clusters,
    rest: {
      clusters: result.rest.clusters,
      cells: result.rest.cells,
      weight: total == null ? null : result.rest.weight,
      share: total != null && total > 0 ? result.rest.weight / total : null,
    },
  };
}

function recordSummary(
  metric: MetricDefinition,
  rows: readonly ResultRow[],
  ctx: SummaryContext,
): UnreadSummary<RecordSummary> {
  const row = rows[0];
  const measureCol = measureColumn(metric);
  const measure = measureOf(measureCol);

  const record: Record<string, string | number | boolean | null> = {};
  if (row != null) {
    for (const [name] of columnsOf(metric)) {
      if (!(name in row)) continue;
      const value = row[name];
      record[name] =
        value == null
          ? null
          : typeof value === "number" || typeof value === "string" || typeof value === "boolean"
            ? value
            : null;
    }
  }

  // Every column that declares itself a rate of another one, resolved against
  // the row — the numbers a reader would otherwise have to divide by hand.
  const rates: Record<string, ResolvedRate> = {};
  for (const [name, semantics] of columnsOf(metric)) {
    if (semantics.rateOf == null || row == null) continue;
    const numerator = numberAt(row, name);
    const denominator = numberAt(row, semantics.rateOf);
    rates[name] = {
      value:
        numerator != null && denominator != null && denominator > 0
          ? numerator / denominator
          : null,
      numerator: name,
      denominator: semantics.rateOf,
    };
  }

  const total = row == null || measureCol == null ? null : numberAt(row, measureCol[0]);
  const extra =
    rows.length > 1
      ? [`Only the first of ${rows.length} rows is summarised; read \`format=table\` for the rest.`]
      : [];
  return {
    ...baseOf(metric, rows, ctx, measure, total, extra),
    kind: "record",
    record,
    rates,
  };
}

/**
 * Summarise a metric's rows into the bounded `format=summary` envelope.
 *
 * `metric` may be a registry id or a resolved definition; an unknown id returns
 * `null` so a caller can fall back to the raw rows rather than fail a request.
 * `rows` must be the rows the store produced, already numerically coerced
 * (every store runner does that at its edge — ADR 0051 §2).
 */
export function summarizeRows(
  metric: MetricId | MetricDefinition,
  rows: readonly ResultRow[],
  ctx: SummaryContext = {},
): ResultSummary | null {
  const definition = resolve(metric);
  if (definition == null) return null;
  const cap = Math.max(0, ctx.maxRows ?? definition.limits.maxSummaryRows);

  let summary: UnreadSummary | null = null;
  if (definition.grain === "bucket") {
    summary = seriesSummary(definition, rows, ctx);
  } else if (definition.grain === "bin" || definition.grain === "voxel") {
    summary = clusterSummary(definition, rows, ctx, cap);
  } else if (definition.grain === "project" || labelColumn(definition) == null) {
    summary = recordSummary(definition, rows, ctx);
  }
  // Leaderboards, and the fallback for any metric that cannot produce its
  // grain's shape (too few `index` columns, no axis, a non-additive weight).
  summary ??= rankedSummary(definition, rows, ctx, cap);

  return { ...summary, reading: readingFor(definition, summary) } as ResultSummary;
}
