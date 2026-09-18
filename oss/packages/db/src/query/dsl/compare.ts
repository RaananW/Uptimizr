/**
 * **`compare`: what changed** (ADR 0051 §3/§4, design sketch §C.2).
 *
 * The first of the three things an agent cannot do today. A model asked "is the
 * statue getting less attention than last week?" currently runs two queries,
 * eyeballs two lists of different lengths in different orders, and reports a
 * difference it computed in prose — which is where the arithmetic goes wrong,
 * every time.
 *
 * `compare` runs the *same* validated spec twice — once with the query's own
 * range and segment, once with the comparison's — and joins the two results
 * **here, in TypeScript**, on the dimension key. Not in SQL: a self-join over
 * two windows would have to be written per dialect, would double the parity
 * surface, and would make the "one SQL path" property of the DSL false. The join
 * is a `Map` over at most `limits.maxRows` rows on each side.
 *
 * Everything in this module is pure: rows in, rows out. It never runs a query —
 * the collector does that twice and hands both results here.
 *
 * ## Which rows are joined
 *
 * On the **key columns**: the output columns of the grouping dimensions (the
 * query's, or the metric's own grain). A `bucket`-grain metric's axis is
 * deliberately *not* a key — two ranges have different buckets, so joining on
 * them would produce two disjoint sets and zero matches. Its buckets are
 * collapsed per key instead, and the per-bucket values feed
 * {@link import("./significance.js").welchT} as two samples, which is the one
 * place a t-test on this data is honest.
 *
 * A key present on one side only is still a row: `previous: null` is an arrival
 * and `current: null` a disappearance, and both are usually the answer.
 *
 * ## Significance, only where it is earned
 *
 * For a count or session measure the row's share of its window is a proportion,
 * so a pooled two-proportion z answers "is this share different" — and that is
 * computed only when both windows clear the metric's `comparable.minSample`.
 * For anything else (`fps`, a ratio, a duration average) the field is **absent**
 * rather than guessed, and a caveat says why. An agent that is handed a p-value
 * will quote it; handing it one that the data cannot support is worse than
 * handing it none.
 */

import { getMetric, type MetricDefinition, type MetricId } from "@uptimizr/metrics";
import {
  axisColumn,
  columnsOf,
  labelColumn,
  measureColumn,
  numberAt,
  sampleSizeOf,
} from "../summary/columns.js";
import { formatNumber, formatShare } from "../summary/format.js";
import { isAdditiveUnit } from "../summary/format.js";
import type { AppliedFilters, ResultRange, SampleSize, SummaryMeasure } from "../summary/types.js";
import {
  sampleOf,
  twoProportionZ,
  welchT,
  type MeanSignificance,
  type Significance,
} from "./significance.js";

/** A row as it leaves a store. */
type Row = Readonly<Record<string, unknown>>;

/** What the second run varied: the time window, or the slice. */
export type ComparisonBasis = "range" | "segment";

/** One side of a comparison, described well enough to be quoted on its own. */
export interface ComparisonSide {
  range: ResultRange;
  /** The dimensions held fixed on this side, when the basis is `segment`. */
  segment: AppliedFilters;
  /** Rows the store returned before the join. */
  rows: number;
  /** Sum of the measure across those rows; `null` when it cannot be summed. */
  total: number | null;
  sampleSize: SampleSize;
}

/** One joined row: the same key, measured twice. */
export interface ComparisonRow {
  /** The dimension values that identify this row, keyed by output column. */
  key: Readonly<Record<string, string>>;
  /** The row's label — its key columns joined, so a reading can name it. */
  label: string;
  current: number | null;
  previous: number | null;
  /** `current - previous`; `null` when either side is missing. */
  delta: number | null;
  /** `delta / previous`; `null` when `previous` is missing, zero or negative. */
  deltaPct: number | null;
  /** Present only where the registry justifies a test — see the module doc. */
  significance?: Significance;
}

/** The envelope a `compare` query answers with. */
export interface ComparisonMeta {
  metric: MetricId;
  basis: ComparisonBasis;
  /** The columns the two sides were joined on. */
  keys: readonly string[];
  measure: SummaryMeasure | null;
  current: ComparisonSide;
  previous: ComparisonSide;
  /** Rows in the joined result. */
  rows: number;
  /** Whether either side hit its row cap, so a key may be missing from one. */
  truncated: boolean;
  /**
   * Welch's t over the two windows' per-bucket values — present only for a
   * `bucket`-grain metric whose measure is a mean, which is the only shape here
   * that really is two samples.
   */
  overall?: MeanSignificance;
  caveats: readonly string[];
}

/** `format=table` on a comparison: the envelope plus the joined rows. */
export interface ComparisonResult {
  meta: ComparisonMeta;
  rows: readonly ComparisonRow[];
}

/** `format=summary` on a comparison: the biggest movers, with a reading. */
export interface MoversSummary {
  kind: "movers";
  metric: MetricId;
  basis: ComparisonBasis;
  measure: SummaryMeasure | null;
  current: ComparisonSide;
  previous: ComparisonSide;
  /** The rows that moved most, by absolute delta. Bounded by `maxSummaryRows`. */
  top: readonly ComparisonRow[];
  /** Rows the digest did not list individually. */
  rest: { rows: number; delta: number | null };
  overall?: MeanSignificance;
  /** One sentence, templated from column semantics only — never model-written. */
  reading: string;
  caveats: readonly string[];
}

/** What the caller knows about the two runs that produced the rows. */
export interface ComparisonContext {
  basis: ComparisonBasis;
  /** The output columns the two sides are joined on. */
  keys: readonly string[];
  currentRange: ResultRange;
  previousRange: ResultRange;
  currentSegment?: Readonly<Record<string, string>>;
  previousSegment?: Readonly<Record<string, string>>;
  /** The row cap in force, so `truncated` can be derived. */
  limit?: number;
  /** Extra caveats true of this comparison only. */
  caveats?: readonly string[];
  /** Cap on the movers digest; defaults to the registry's `maxSummaryRows`. */
  maxRows?: number;
}

/** A key's identity as one string, so it can index a `Map`. */
function keyOf(row: Row, keys: readonly string[]): string {
  return keys.map((column) => `${column}=${String(row[column] ?? "")}`).join("\u0000");
}

/** The key columns' values, as the row reports them. */
function keyValues(row: Row, keys: readonly string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const column of keys) out[column] = String(row[column] ?? "");
  return out;
}

/** What `total` counts, and whether it may be summed at all. */
function measureOf(metric: MetricDefinition): SummaryMeasure | null {
  const column = measureColumn(metric);
  if (column == null) return null;
  const [name, semantics] = column;
  return { column: name, unit: semantics.unit ?? null, additive: isAdditiveUnit(semantics.unit) };
}

/** One side's rows, collapsed to one value per key. */
function collapse(
  rows: readonly Row[],
  keys: readonly string[],
  column: string | undefined,
  additive: boolean,
): Map<string, { key: Record<string, string>; value: number | null }> {
  const out = new Map<string, { key: Record<string, string>; sum: number; count: number }>();
  for (const row of rows) {
    const id = keyOf(row, keys);
    const value = column == null ? null : numberAt(row, column);
    const bucket = out.get(id) ?? { key: keyValues(row, keys), sum: 0, count: 0 };
    if (value != null) {
      bucket.sum += value;
      bucket.count += 1;
    }
    out.set(id, bucket);
  }
  return new Map(
    [...out].map(([id, bucket]) => [
      id,
      {
        key: bucket.key,
        // Several rows collapse into one key only for a `bucket`-grain metric,
        // whose axis is not a join key. Counts add; means average, for the same
        // reason the series summary averages them.
        value: bucket.count === 0 ? null : additive ? bucket.sum : bucket.sum / bucket.count,
      },
    ]),
  );
}

/** Per-bucket values of one side, for the Welch sample. */
function bucketValues(
  metric: MetricDefinition,
  rows: readonly Row[],
  column: string | undefined,
  additive: boolean,
): readonly number[] {
  const axis = axisColumn(metric)?.[0];
  if (axis == null || column == null) return [];
  const buckets = new Map<string, { sum: number; count: number }>();
  for (const row of rows) {
    const value = numberAt(row, column);
    if (value == null) continue;
    const id = String(row[axis] ?? "");
    const bucket = buckets.get(id) ?? { sum: 0, count: 0 };
    bucket.sum += value;
    bucket.count += 1;
    buckets.set(id, bucket);
  }
  return [...buckets.values()].map((bucket) => (additive ? bucket.sum : bucket.sum / bucket.count));
}

/** Sum a column over rows, or `null` when nothing was measurable. */
function totalOf(rows: readonly Row[], column: string | undefined): number | null {
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
 * The dimension output columns two sides of a comparison are joined on.
 *
 * Deliberately the *dimensions*, not "every non-numeric column": a metric's row
 * can carry descriptive text (a scene name next to a scene id) that is not part
 * of its identity, and joining on it would split a key in two whenever the
 * description changed between the two windows.
 */
export function comparisonKeys(metric: MetricDefinition, columns: readonly string[]): string[] {
  // Only a real `axis: true` column is excluded. `axisColumn` falls back to the
  // label for metrics that declare none, and the label is exactly what a
  // leaderboard comparison must join on — dropping it would collapse every mesh
  // into one unkeyed row.
  const axis = columnsOf(metric).find(([, semantics]) => semantics.axis === true)?.[0];
  return columns.filter((column) => column !== axis);
}

/**
 * Join two runs of the same spec into one comparison.
 *
 * `current` and `previous` are the rows each run produced, already coerced by
 * the store edge. Neither array is mutated, and nothing here reads a clock or a
 * store.
 */
export function compareRows(
  metric: MetricId | MetricDefinition,
  current: readonly Row[],
  previous: readonly Row[],
  ctx: ComparisonContext,
): ComparisonResult | null {
  const definition = typeof metric === "string" ? getMetric(metric) : metric;
  if (definition == null) return null;

  const measure = measureOf(definition);
  const column = measure?.column;
  const additive = measure?.additive === true;
  const keys = [...ctx.keys];

  const currentTotal = totalOf(current, column);
  const previousTotal = totalOf(previous, column);
  const currentByKey = collapse(current, keys, column, additive);
  const previousByKey = collapse(previous, keys, column, additive);

  // A proportion test needs a denominator that means something: a count or a
  // session count, present on both sides, and past the metric's own minimum.
  const minSample = definition.comparable?.minSample ?? 0;
  const proportional =
    (measure?.unit === "count" || measure?.unit === "sessions") &&
    currentTotal != null &&
    previousTotal != null &&
    currentTotal >= minSample &&
    previousTotal >= minSample &&
    currentTotal > 0 &&
    previousTotal > 0;

  const ids = new Set([...currentByKey.keys(), ...previousByKey.keys()]);
  const rows: ComparisonRow[] = [];
  for (const id of ids) {
    const left = currentByKey.get(id);
    const right = previousByKey.get(id);
    const key = left?.key ?? right?.key ?? {};
    const currentValue = left?.value ?? null;
    const previousValue = right?.value ?? null;
    const delta =
      currentValue != null && previousValue != null ? currentValue - previousValue : null;
    const significance =
      proportional && currentValue != null && previousValue != null
        ? twoProportionZ(
            { successes: currentValue, trials: currentTotal },
            { successes: previousValue, trials: previousTotal },
          )
        : null;
    rows.push({
      key,
      label: keys.map((name) => String(key[name] ?? "")).join(" · "),
      current: currentValue,
      previous: previousValue,
      delta,
      deltaPct:
        delta != null && previousValue != null && previousValue > 0 ? delta / previousValue : null,
      ...(significance != null ? { significance } : {}),
    });
  }

  // Biggest absolute movement first, then alphabetically, so the order is a
  // function of the data rather than of iteration order.
  rows.sort((a, b) => {
    const left = Math.abs(a.delta ?? 0);
    const right = Math.abs(b.delta ?? 0);
    if (left !== right) return right - left;
    return a.label < b.label ? -1 : a.label > b.label ? 1 : 0;
  });

  const overall =
    definition.grain === "bucket" && measure != null && !measure.additive
      ? welchOf(definition, current, previous, column, additive)
      : null;

  const cap = ctx.limit ?? definition.limits.maxRows;
  const truncated = Number.isFinite(cap) && (current.length >= cap || previous.length >= cap);

  const caveats = [...definition.caveats, ...(ctx.caveats ?? [])];
  if (!proportional) {
    caveats.push(
      measure?.unit === "count" || measure?.unit === "sessions"
        ? `Neither window reaches the ${minSample}-${measure.unit === "sessions" ? "session" : "event"} ` +
            "minimum this metric declares, so no significance is reported — read the deltas as " +
            "direction only."
        : "This metric's measure is not a count, so a row's share of the window is not a " +
            "proportion and no significance test applies. The deltas are still exact.",
    );
  }
  if (truncated) {
    caveats.push(
      `One or both windows hit the ${cap}-row cap, so a key missing from a side may be truncated ` +
        "rather than absent.",
    );
  }
  if (keys.length === 0) {
    caveats.push(
      "This metric has no dimension key, so the comparison is a single total per window.",
    );
  }

  return {
    meta: {
      metric: definition.id,
      basis: ctx.basis,
      keys,
      measure,
      current: {
        range: ctx.currentRange,
        segment: { ...(ctx.currentSegment ?? {}) },
        rows: current.length,
        total: currentTotal,
        sampleSize: sampleSizeOf(definition, current),
      },
      previous: {
        range: ctx.previousRange,
        segment: { ...(ctx.previousSegment ?? {}) },
        rows: previous.length,
        total: previousTotal,
        sampleSize: sampleSizeOf(definition, previous),
      },
      rows: rows.length,
      truncated,
      ...(overall != null ? { overall } : {}),
      caveats,
    },
    rows,
  };
}

/** Welch's t over the two windows' per-bucket values. */
function welchOf(
  metric: MetricDefinition,
  current: readonly Row[],
  previous: readonly Row[],
  column: string | undefined,
  additive: boolean,
): MeanSignificance | null {
  const left = sampleOf(bucketValues(metric, current, column, additive));
  const right = sampleOf(bucketValues(metric, previous, column, additive));
  if (left == null || right == null) return null;
  return welchT(left, right);
}

/**
 * The headline when one side has no rows at all.
 *
 * "The two windows cannot be totalled" would be true and useless: what actually
 * happened is that one of them is empty, and saying which is the whole answer —
 * a metric that appeared or disappeared between two windows is the single most
 * interesting thing a comparison can report.
 */
function emptySideHeadline(title: string, measure: string, meta: ComparisonMeta): string {
  const side = meta.basis === "range" ? "window" : "segment";
  if (meta.current.total != null) {
    return (
      `${title}: \`${measure}\` totalled ${formatNumber(meta.current.total)} in this ${side}, ` +
      `and the comparison ${side} has no rows at all — everything here is new.`
    );
  }
  if (meta.previous.total != null) {
    return (
      `${title}: this ${side} has no rows at all, against ${formatNumber(meta.previous.total)} ` +
      `in the comparison ${side} — everything there has gone.`
    );
  }
  return `${title}: neither ${side} has any \`${measure}\` to compare.`;
}

/** How a delta reads in prose. */
function movement(delta: number | null): string {
  if (delta == null) return "changed";
  if (delta > 0) return "rose";
  if (delta < 0) return "fell";
  return "held";
}

/**
 * Turn a comparison into the bounded `format=summary` digest: the rows that
 * moved most, and one sentence that says what happened.
 *
 * The sentence is templated from the registry's column semantics — the measure's
 * name and unit, the metric's `comparable.direction` — and never written by a
 * model, so two identical results always read identically.
 */
export function summarizeComparison(
  metric: MetricId | MetricDefinition,
  comparison: ComparisonResult,
  ctx: { maxRows?: number } = {},
): MoversSummary | null {
  const definition = typeof metric === "string" ? getMetric(metric) : metric;
  if (definition == null) return null;
  const cap = Math.max(0, ctx.maxRows ?? definition.limits.maxSummaryRows);
  const top = comparison.rows.slice(0, cap);
  const restRows = comparison.rows.slice(cap);
  const restDelta = restRows.reduce<number | null>(
    (sum, row) => (row.delta == null ? sum : (sum ?? 0) + row.delta),
    null,
  );

  const { meta } = comparison;
  const measureName = meta.measure?.column ?? "the measure";
  const totalDelta =
    meta.current.total != null && meta.previous.total != null
      ? meta.current.total - meta.previous.total
      : null;
  const totalPct =
    totalDelta != null && meta.previous.total != null && meta.previous.total > 0
      ? totalDelta / meta.previous.total
      : null;

  const window =
    meta.basis === "range" ? "against the comparison window" : "against the comparison segment";
  const headline =
    totalDelta == null
      ? emptySideHeadline(definition.title, measureName, meta)
      : `${definition.title}: \`${measureName}\` ${movement(totalDelta)} from ` +
        `${formatNumber(meta.previous.total)} to ${formatNumber(meta.current.total)} ` +
        `(${totalDelta >= 0 ? "+" : ""}${formatNumber(totalDelta)}` +
        `${totalPct == null ? "" : `, ${totalPct >= 0 ? "+" : ""}${formatShare(totalPct)}`}) ${window}.`;

  const biggest = top[0];
  const mover =
    biggest == null || biggest.delta == null || biggest.label.length === 0
      ? ""
      : ` Biggest mover: ${labelNoun(definition)} \`${biggest.label}\`, ` +
        `${formatNumber(biggest.previous)} → ${formatNumber(biggest.current)} ` +
        `(${biggest.delta >= 0 ? "+" : ""}${formatNumber(biggest.delta)})` +
        `${
          biggest.significance?.test === "two-proportion-z"
            ? biggest.significance.significant
              ? `, significant at p = ${formatPValue(biggest.significance.pValue)}`
              : `, not significant (p = ${formatPValue(biggest.significance.pValue)})`
            : ""
        }.`;

  const trend =
    meta.overall == null
      ? ""
      : ` Across buckets, the mean moved ${formatNumber(meta.overall.previous)} → ` +
        `${formatNumber(meta.overall.current)} (Welch t = ${formatNumber(meta.overall.t)}, ` +
        `p = ${formatPValue(meta.overall.pValue)}).`;

  return {
    kind: "movers",
    metric: definition.id,
    basis: meta.basis,
    measure: meta.measure,
    current: meta.current,
    previous: meta.previous,
    top,
    rest: { rows: restRows.length, delta: restDelta },
    ...(meta.overall != null ? { overall: meta.overall } : {}),
    reading: `${headline}${mover}${trend}`,
    caveats: meta.caveats,
  };
}

/** What one row of this metric is called, for the reading sentence. */
function labelNoun(metric: MetricDefinition): string {
  return labelColumn(metric)?.[0] ?? metric.grain;
}

/** A p-value at three decimals, or `< 0.001` when it is smaller than that. */
function formatPValue(p: number): string {
  if (!Number.isFinite(p)) return "n/a";
  return p < 0.001 ? "< 0.001" : p.toFixed(3);
}
