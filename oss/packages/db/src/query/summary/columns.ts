/**
 * Registry column lookups shared by the summariser.
 *
 * Everything the summary does — what to rank by, what to call a row, which
 * columns index a grid, how big the sample is — is read out of the metric's
 * `columns` semantics rather than hard-coded per metric. That is the whole point
 * of the registry: a new aggregation gets a usable summary for free the moment
 * it declares what its columns mean.
 */

import type { ColumnSemantics, MetricDefinition } from "@uptimizr/metrics";
import type { SampleSize } from "./types.js";

/** A column name paired with its declared semantics. */
export type Column = readonly [name: string, semantics: ColumnSemantics];

/** Every declared column, in declaration order. */
export function columnsOf(metric: MetricDefinition): Column[] {
  return Object.entries(metric.columns) as Column[];
}

/** The column a metric is ranked by (`measure: true`), if it declares one. */
export function measureColumn(metric: MetricDefinition): Column | undefined {
  return columnsOf(metric).find(([, semantics]) => semantics.measure);
}

/** The column that names a row (`label: true`), if it declares one. */
export function labelColumn(metric: MetricDefinition): Column | undefined {
  return columnsOf(metric).find(([, semantics]) => semantics.label);
}

/**
 * The ordered column of a `bucket`-grain metric (`axis: true`), falling back to
 * the label column so a metric that has not declared an axis still summarises.
 */
export function axisColumn(metric: MetricDefinition): Column | undefined {
  return columnsOf(metric).find(([, semantics]) => semantics.axis) ?? labelColumn(metric);
}

/** The first column declared with a given unit, in declaration order. */
export function firstColumnWithUnit(metric: MetricDefinition, unit: string): Column | undefined {
  return columnsOf(metric).find(([, semantics]) => semantics.unit === unit);
}

/**
 * The grid-index columns of a binned or voxelised metric: the first `axes`
 * columns declared with `unit: "index"`, in declaration order.
 *
 * Declaration order is the rule, and it is what makes the choice explainable:
 * `position_heatmap` indexes on `gx`/`gz` and skips its world-space `avg_y`,
 * `flow_links` clusters on the view-direction grid it leads with, and
 * `click_rays` clusters on the click-time standpoint voxel (`cam_v*`) it
 * declares first. Returns `undefined` when the metric declares too few.
 */
export function gridColumns(metric: MetricDefinition, axes: number): Column[] | undefined {
  const indexed = columnsOf(metric).filter(([, semantics]) => semantics.unit === "index");
  return indexed.length >= axes ? indexed.slice(0, axes) : undefined;
}

/**
 * The column a spatial cluster weighs its cells by: the first `count` column if
 * the metric declares one, else the measure. `perf_heatmap` measures `avg_fps`
 * but counts `samples` — clustering by an average would weigh a one-sample
 * voxel the same as a thousand-sample one.
 */
export function weightColumn(metric: MetricDefinition): Column | undefined {
  return firstColumnWithUnit(metric, "count") ?? measureColumn(metric);
}

/** A row's value for a column, when it is a finite number; `null` otherwise. */
export function numberAt(row: Readonly<Record<string, unknown>>, column: string): number | null {
  const value = row[column];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * Sum a column across rows. `null` when the column is absent from every row or
 * every value is null — a metric that reports nothing must not report `0`.
 */
export function sumColumn(
  rows: readonly Readonly<Record<string, unknown>>[],
  column: string | undefined,
): number | null {
  if (column == null) return null;
  let total = 0;
  let seen = false;
  for (const row of rows) {
    const value = numberAt(row, column);
    if (value == null) continue;
    seen = true;
    total += value;
  }
  return seen ? total : null;
}

/**
 * How much data is behind a result, derived entirely from column units.
 *
 * - `sessions` — the number of rows when one row *is* a session
 *   (`grain: "session"`), otherwise the sum of the first column declared
 *   `unit: "sessions"`. When rows can share a session (a per-mesh breakdown,
 *   say) that sum is an upper bound, not a distinct count; the caveats say so.
 * - `events` — the sum of the first column declared `unit: "count"`. Declaration
 *   order matters: registry rows lead with the denominator (`total_clicks`
 *   before `dead_clicks`, `samples` before the percentiles computed from them).
 *
 * `null` means the metric declares nothing that could answer the question.
 */
export function sampleSizeOf(
  metric: MetricDefinition,
  rows: readonly Readonly<Record<string, unknown>>[],
): SampleSize {
  const sessions =
    metric.grain === "session"
      ? rows.length
      : sumColumn(rows, firstColumnWithUnit(metric, "sessions")?.[0]);
  return { sessions, events: sumColumn(rows, firstColumnWithUnit(metric, "count")?.[0]) };
}
