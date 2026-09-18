/**
 * **Rolling robust statistics and change-point detection** (ADR 0051 §4,
 * design sketch §D row `anomalies`).
 *
 * Two generic, series-shaped algorithms that `anomalies.ts` composes, kept in
 * their own module for the same reason `stats.ts` exists: they are pure
 * functions of `readonly number[]` with no notion of a metric, a bucket, a store
 * or a dialect, and they are unit-tested against hand-built series rather than
 * against a query result.
 *
 * ## Why these two, and not a model
 *
 * A self-hosted collector has one project's history and no training budget, so
 * an anomaly detector here has to work on a few dozen buckets, explain itself in
 * one number, and never need tuning per metric. Two classical methods do exactly
 * that, and they answer *different* questions — which is why both are here:
 *
 * - {@link rollingRobustStats} answers **"is this bucket unlike the ones just
 *   before it?"** — a single surprising day. It is a *point* detector.
 * - {@link cusumChangePoints} answers **"did the level move and stay moved?"** —
 *   a regression that is only 1.5 MADs deep and so never trips a point detector,
 *   but that persists for a fortnight. It is a *sequential* detector, and it is
 *   the one that catches the shape a release regression actually has.
 *
 * Both are robust by construction: the centre is a median and the scale is a
 * median absolute deviation, so one catastrophic bucket in the trailing window
 * cannot widen the tolerance until nothing is ever abnormal again.
 */

import { median, medianAbsoluteDeviation } from "./stats.js";

/**
 * The trailing centre and spread for one index of a series.
 *
 * `null` in both fields means the index had too little history to be judged —
 * never `0`, which would claim a perfectly flat past.
 */
export interface RollingRobustPoint {
  /** Median of the trailing window; `null` when it held too few values. */
  median: number | null;
  /** Median absolute deviation of the same window; `null` alongside a null median. */
  mad: number | null;
  /** How many values the trailing window actually carried. */
  count: number;
}

/**
 * The trailing median and MAD for every index of `values`.
 *
 * The window for index `i` is `values[i - window .. i - 1]` — **the point itself
 * is excluded**, which is the whole point. Including it drags the median toward
 * the very value being judged and inflates the MAD by the deviation being
 * measured, so a big enough spike partly hides itself. Excluding it makes the
 * comparison "against what came before", which is what a reader means by
 * "unusual".
 *
 * Indices with fewer than `minCount` trailing values report `null`: the first
 * days of a project are not evidence about the first days of a project, and a
 * detector that flags them produces a page of findings on every new install.
 *
 * Non-finite entries are skipped (they never enter a window and are never
 * scored), so a sparse series behaves like the shorter series it really is.
 */
export function rollingRobustStats(
  values: readonly number[],
  window: number,
  minCount: number,
): RollingRobustPoint[] {
  const out: RollingRobustPoint[] = [];
  const width = Math.max(1, Math.floor(window));
  const floor = Math.max(1, Math.floor(minCount));
  // The trailing values in a plain array: the windows are tens to a few hundred
  // entries and a median needs them sorted anyway, so an incremental structure
  // would add ordering bugs to buy nothing measurable.
  const trailing: number[] = [];
  for (const value of values) {
    if (trailing.length < floor) {
      out.push({ median: null, mad: null, count: trailing.length });
    } else {
      const centre = median(trailing);
      out.push({
        median: centre,
        mad: medianAbsoluteDeviation(trailing),
        count: trailing.length,
      });
    }
    if (Number.isFinite(value)) {
      trailing.push(value);
      if (trailing.length > width) trailing.shift();
    }
  }
  return out;
}

/**
 * Slack ("allowance") of the tabular CUSUM, in MAD units.
 *
 * The accumulator only grows once a deviation exceeds this, so ordinary
 * bucket-to-bucket noise cancels instead of drifting upward forever. Half a MAD
 * is the textbook choice — it is the shift size the chart is tuned to detect
 * fastest — and keeping it a constant rather than a parameter is deliberate:
 * `sensitivity` already moves the decision threshold, and two dials that both
 * mean "how eager" would be impossible for a caller to reason about.
 */
export const CUSUM_SLACK = 0.5;

/**
 * The decision threshold, as a multiple of `sensitivity`.
 *
 * The alarm fires when the accumulated excess passes
 * `sensitivity × CUSUM_DECISION_FACTOR` MADs. At the default `sensitivity` of 3
 * that is 6 MADs of *accumulated* excess — reachable by four consecutive buckets
 * two MADs off, or by a dozen buckets barely off, but not by noise. It keeps the
 * one dial monotone: a higher `sensitivity` means fewer findings for the point
 * detector and for the change-point detector alike.
 */
export const CUSUM_DECISION_FACTOR = 2;

/**
 * Why each deviation is clamped to ±`sensitivity` before it is accumulated.
 *
 * A textbook CUSUM alarms on a single large outlier: one bucket ten MADs out
 * contributes 9.5 on its own and trips any reasonable threshold, so every spike
 * would also be reported as a level shift and `kind` would stop meaning
 * anything. Winsorising at exactly the point detector's own threshold fixes
 * that by construction: a bucket the point detector already calls a `spike`
 * contributes at most `sensitivity − k`, so **no single bucket can raise a
 * change-point alarm** at the default settings — it takes three saturated
 * buckets in a row, or a longer run of smaller ones. That is precisely the
 * difference between "a bad Tuesday" and "it has been worse since Tuesday",
 * which is the distinction `kind` exists to make.
 */
function winsorise(deviation: number, limit: number): number {
  return Math.max(-limit, Math.min(limit, deviation));
}

/** A detected level shift in a series. */
export interface ChangePoint {
  /** Index at which the shift began — the last point before the drift started. */
  index: number;
  /** Direction of the shift. */
  direction: "up" | "down";
  /** Median of the segment before the change-point. */
  before: number | null;
  /** Median of the segment from the change-point to the next one (or the end). */
  after: number | null;
  /** Accumulated excess, in MADs, at the bucket that raised the alarm. */
  score: number;
}

/**
 * Two-sided tabular CUSUM over `values`, segmented so several level changes in
 * one series are found rather than one.
 *
 * ```
 * eᵢ  = clip((xᵢ − reference) / spread, ±sensitivity)
 * S⁺ᵢ = max(0, S⁺ᵢ₋₁ + eᵢ − k)      S⁻ᵢ = max(0, S⁻ᵢ₋₁ − eᵢ − k)
 * ```
 *
 * Three decisions make this a *change-point* detector rather than a chart:
 *
 * 1. **The reference is the level the segment started at** — the median of its
 *    first `referenceLength` values — not the median of the whole series. With a
 *    whole-series centre, a series that steps up halfway sits *above* its own
 *    median for the entire second half and *below* it for the entire first, so
 *    the accumulator starts drifting at index 0 and the alarm names the wrong
 *    bucket. Measuring against where the series began is what makes "it moved"
 *    a statement about a moment.
 * 2. **An alarm is reported where the accumulator last left zero**, not where it
 *    crossed the threshold. A CUSUM crosses several buckets after the level
 *    actually moved — that lag is how it earns its sensitivity — and reporting
 *    the crossing would put the finding on the wrong day.
 * 3. **After an alarm the series is re-segmented from the change-point**, with
 *    the reference re-estimated over the new regime. Without that, a shifted
 *    series keeps deviating from the old reference forever and alarms again
 *    every few buckets; with it, a level that moves and moves back reports
 *    exactly two change-points.
 *
 * `spread` is supplied by the caller (`anomalies.ts` passes the same floored MAD
 * the point detector uses, so both halves of the primitive are measured in one
 * unit). A non-positive or missing `spread` means there is nothing to detect and
 * the result is empty.
 */
export function cusumChangePoints(
  values: readonly number[],
  spread: number | null,
  sensitivity: number,
  referenceLength: number,
): ChangePoint[] {
  const out: ChangePoint[] = [];
  if (spread == null || !(spread > 0) || values.length < 2) return out;
  const threshold = Math.max(0, sensitivity) * CUSUM_DECISION_FACTOR;
  if (!(threshold > 0)) return out;
  const reference = Math.max(2, Math.floor(referenceLength));

  let from = 0;
  while (from < values.length) {
    const segment = values.slice(from);
    const alarm = firstAlarm(
      segment,
      median(segment.slice(0, Math.min(reference, segment.length))),
      spread,
      threshold,
      sensitivity,
    );
    if (alarm == null) break;
    const at = from + alarm.index;
    out.push({
      index: at,
      direction: alarm.direction,
      before: null,
      after: null,
      score: alarm.score,
    });
    // Strictly forward, so a pathological series cannot loop here.
    from = at + 1;
  }

  // Levels are filled in once the segment boundaries are known: `before` is the
  // regime that ended at the change-point and `after` the one that began there,
  // each closed by its neighbour rather than running to the end of the series.
  for (const [position, change] of out.entries()) {
    const previous = position === 0 ? 0 : (out[position - 1] as ChangePoint).index;
    const next =
      position === out.length - 1 ? values.length : (out[position + 1] as ChangePoint).index;
    change.before = median(values.slice(previous, change.index));
    change.after = median(values.slice(change.index, next));
  }
  return out;
}

/** Where one segment first departs from its own opening level, if it does. */
function firstAlarm(
  values: readonly number[],
  reference: number | null,
  spread: number,
  threshold: number,
  sensitivity: number,
): { index: number; direction: "up" | "down"; score: number } | null {
  if (reference == null) return null;
  let up = 0;
  let down = 0;
  let upStart = 0;
  let downStart = 0;
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index] as number;
    if (!Number.isFinite(value)) continue;
    const deviation = winsorise((value - reference) / spread, sensitivity);
    if (up === 0) upStart = index;
    if (down === 0) downStart = index;
    up = Math.max(0, up + deviation - CUSUM_SLACK);
    down = Math.max(0, down - deviation - CUSUM_SLACK);
    if (up > threshold) return { index: upStart, direction: "up", score: up };
    if (down > threshold) return { index: downStart, direction: "down", score: down };
  }
  return null;
}
