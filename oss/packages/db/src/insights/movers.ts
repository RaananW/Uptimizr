/**
 * **`movers`** — "what changed since last week?" (ADR 0051 §4, sketch §D).
 *
 * For every comparable metric in scope, compares the current window against a
 * reference window and ranks the differences by a **robust z-score**:
 * `delta / (MAD of the reference bucket series + ε)`. The MAD is what makes the
 * ranking trustworthy — a metric that swings by 30% every day has to move far
 * more than one that never moves before it is called a mover, and no threshold
 * has to be configured per metric to say so.
 *
 * Pure: it takes, per metric, the bucket series that `buildMetricBuckets`
 * produced over the combined window, plus the registry's comparison semantics,
 * and returns the ranked rows. No store, no request, no dialect.
 *
 * ## Small samples are reported, never silently dropped
 *
 * A delta computed from eleven events is not evidence, but hiding it is its own
 * failure mode: an agent asked "did anything change?" would be told "no" when
 * the honest answer is "nothing with enough data behind it". So every metric
 * keeps its row and carries `aboveMinSample`, and the *ranking* is what enforces
 * the gate — gated movers sort above every ungated one, so the top of the list
 * is always the part worth reading (the acceptance criterion "movers never
 * reports a delta below `minSample` as meaningful").
 */

import { median, medianAbsoluteDeviation, relativeChange, robustZ, round } from "./stats.js";
import type { MetricBucketRow } from "./buckets.js";
import type { BucketRollup } from "./measures.js";

/** Everything `rankMovers` needs about one metric. */
export interface MoverInput {
  /** Registry metric id. */
  metric: string;
  /** `comparable.direction` — whether a rise is good, bad or merely a fact. */
  direction: "up" | "down" | "neutral";
  /** `comparable.minSample` — the denominator below which a delta is not evidence. */
  minSample: number;
  /** How the metric's bucket values combine into a window value. */
  rollup: BucketRollup;
  /** Buckets inside the current range. */
  current: readonly MetricBucketRow[];
  /** Buckets inside the reference range. */
  reference: readonly MetricBucketRow[];
}

/** One ranked mover. */
export interface MoverRow {
  metric: string;
  /**
   * The dimension value this move is attributed to, or `null`.
   *
   * Always `null` in v1: movers are computed at the scene (or project) level.
   * The per-dimension attribution — "the drop is almost all on mobile" — is the
   * `contributor` work that arrives with `anomalies` (ADR 0051 §4); the column
   * exists now so that adding it later is not a breaking change to the row.
   */
  dimensionValue: string | null;
  /** The metric's primary column over the current range. */
  current: number | null;
  /** The same over the reference range. */
  previous: number | null;
  /** `current − previous`. */
  delta: number | null;
  /** `delta / |previous|`; `null` when `previous` is zero or missing. */
  deltaPct: number | null;
  /** Robust z: `delta / (MAD of the reference bucket series + ε)`. */
  z: number | null;
  direction: "up" | "down" | "neutral";
  /** Whether the current range cleared the metric's `minSample`. */
  aboveMinSample: boolean;
  /** The current range's denominator — what `aboveMinSample` was decided on. */
  sampleSize: number;
}

/** Decimals a mover's numbers are rounded to before they leave the API. */
export const MOVERS_PRECISION = 6;

/**
 * Floor on the reference spread, as a fraction of the reference level.
 *
 * A short reference window routinely has a MAD of exactly 0 — a single bucket
 * always does, and so does any window whose buckets happen to be equal. Dividing
 * by it (well, by `0 + ε`) is finite but useless: every such metric scores in the
 * billions, and since they all divide by the same tiny constant their *relative*
 * order degenerates into a comparison of raw deltas across incompatible units —
 * 37 sessions ranked against 17.8 FPS.
 *
 * So the spread a mover divides by is the MAD **or** 1% of the reference level,
 * whichever is larger: a metric sitting at 60 FPS is never treated as having
 * less than 0.6 FPS of ordinary variation. That keeps `z` readable, keeps the
 * ranking a comparison of proportional moves, and costs nothing where the MAD is
 * genuinely informative — a real MAD is almost always well above 1% of the
 * level, so the floor simply does not bind.
 *
 * A reference that is flat *at zero* has no level either, so it falls through to
 * the epsilon in {@link robustZ} and scores very large. That is the honest
 * reading — the first event of its kind is unprecedented — and `aboveMinSample`
 * is what stops it being reported as a finding.
 */
export const MIN_SPREAD_FRACTION = 0.01;

/**
 * The spread a change is measured against: the reference series' MAD, floored at
 * {@link MIN_SPREAD_FRACTION} of its level. `null` when the reference is empty.
 */
export function referenceSpread(values: readonly number[]): number | null {
  const mad = medianAbsoluteDeviation(values);
  if (mad == null) return null;
  const centre = median(values) ?? 0;
  return Math.max(mad, Math.abs(centre) * MIN_SPREAD_FRACTION);
}

/** The finite values of a bucket series, in bucket order. */
function valuesOf(rows: readonly MetricBucketRow[]): number[] {
  return [...rows]
    .sort((a, b) => a.bucket - b.bucket)
    .map((row) => row.value)
    .filter((value): value is number => value != null && Number.isFinite(value));
}

/** The denominator behind a window: the sum of its buckets' sample sizes. */
function sampleOf(rows: readonly MetricBucketRow[]): number {
  let total = 0;
  for (const row of rows) if (Number.isFinite(row.sample_size)) total += row.sample_size;
  return total;
}

/**
 * Collapse a window's buckets into the one number the metric's primary column
 * means over that window.
 *
 * Additive quantities sum; levels (an FPS median, a heap percentile) average,
 * because adding two days' median FPS together produces a number that means
 * nothing — the same rule the `format=summary` series envelope applies.
 * `null` when the window carried no value at all.
 */
export function rollupWindow(values: readonly number[], rollup: BucketRollup): number | null {
  if (values.length === 0) return null;
  let total = 0;
  for (const value of values) total += value;
  return rollup === "sum" ? total : total / values.length;
}

/** Compute one metric's mover row, unranked. */
export function computeMover(input: MoverInput): MoverRow {
  const currentValues = valuesOf(input.current);
  const referenceValues = valuesOf(input.reference);
  const current = rollupWindow(currentValues, input.rollup);
  const previous = rollupWindow(referenceValues, input.rollup);
  const delta = current != null && previous != null ? current - previous : null;
  // The spread is taken over the **reference** bucket series: "how unusual is
  // this move compared with how this metric normally behaved" — using the
  // current window's own spread would let a newly-volatile metric hide its own
  // change inside its new volatility.
  const mad = referenceSpread(referenceValues);
  const sampleSize = sampleOf(input.current);

  return {
    metric: input.metric,
    dimensionValue: null,
    current: round(current, MOVERS_PRECISION),
    previous: round(previous, MOVERS_PRECISION),
    delta: round(delta, MOVERS_PRECISION),
    deltaPct: round(relativeChange(current, previous), MOVERS_PRECISION),
    z: round(robustZ(delta, mad), MOVERS_PRECISION),
    direction: input.direction,
    aboveMinSample: sampleSize >= input.minSample,
    sampleSize,
  };
}

/**
 * Order two rows "most notable first": gated movers before ungated ones, then by
 * the magnitude of `z`, then by metric id so the order is a function of the row
 * set rather than of the order the metrics happened to be scanned in.
 */
function byNotability(a: MoverRow, b: MoverRow): number {
  if (a.aboveMinSample !== b.aboveMinSample) return a.aboveMinSample ? -1 : 1;
  const left = a.z == null ? -1 : Math.abs(a.z);
  const right = b.z == null ? -1 : Math.abs(b.z);
  if (left !== right) return right - left;
  return a.metric < b.metric ? -1 : a.metric > b.metric ? 1 : 0;
}

/**
 * Rank a set of metrics into the top `limit` risers and the top `limit` fallers.
 *
 * A metric appears at most once — the sign of its `z` decides which half it
 * belongs to. Metrics whose `z` could not be computed (no reference data, so no
 * spread to compare against) are reported at the end of whichever half their
 * `delta` points at, and last of all when even that is unknown, rather than
 * being dropped: "we could not tell" is a different answer from "nothing
 * changed".
 */
export function rankMovers(inputs: readonly MoverInput[], limit: number): MoverRow[] {
  const rows = inputs.map(computeMover);
  const up: MoverRow[] = [];
  const down: MoverRow[] = [];
  const unknown: MoverRow[] = [];
  for (const row of rows) {
    const signal = row.z ?? row.delta;
    if (signal == null || signal === 0) unknown.push(row);
    else if (signal > 0) up.push(row);
    else down.push(row);
  }
  up.sort(byNotability);
  down.sort(byNotability);
  unknown.sort(byNotability);
  const capped = Math.max(0, limit);
  // Risers first, then fallers, then the flat/undetermined tail — the tail is
  // capped too, so the response stays bounded even when nothing moved.
  return [...up.slice(0, capped), ...down.slice(0, capped), ...unknown.slice(0, capped)];
}
