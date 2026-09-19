/**
 * **Insight statistics** (ADR 0051 §4, design sketch §D).
 *
 * The descriptive statistics the insight primitives are built from, in pure
 * TypeScript: no SQL, no dialect, no I/O. That is the whole design rule of
 * `src/insights/` — the *series* is portable (one dialect-authored bucket query,
 * parity-tested on all four engines) and the *statistics over it* are computed
 * once, here, so DuckDB, ClickHouse, Postgres and SQL Server cannot disagree
 * about what "the median" or "the MAD" means.
 *
 * Every function is total and deterministic:
 *
 * - it takes a plain `readonly number[]` and returns a `number` or `null`;
 * - `null` always means *"not defined for this input"* (an empty series, a
 *   single point where a slope needs two), never `0` — a zero mean is a claim
 *   about the data, absence is not (the same rule the registry row schemas
 *   follow);
 * - non-finite inputs are rejected up front rather than silently poisoning a
 *   result with `NaN`.
 *
 * Robust statistics (median, MAD) are used rather than mean/standard deviation
 * wherever a value is ranked or compared, because a scene's bucket series is
 * routinely dominated by one outlier day — a launch, a bot sweep, a broken
 * deploy — and a standard deviation computed across it makes every subsequent
 * change look insignificant.
 */

// `leastSquaresSlope` is the same statistic the `format=summary` series envelope
// already reports (design sketch §B.1), so it is reused rather than re-derived:
// `baseline.slope` and a `format=summary` trend on the same series must agree to
// the last bit, and the only way to guarantee that is to run the same code.
export { leastSquaresSlope, trendOf } from "../query/summary/stats.js";

/**
 * Floor added to the MAD in the denominator of {@link robustZ}.
 *
 * A reference window that never varied has `mad = 0`, and dividing by it would
 * be `Infinity`/`NaN`. Adding a small epsilon keeps the score finite and keeps
 * its *ordering* meaningful: against a perfectly flat reference, any change at
 * all is genuinely unprecedented and should rank above a change of the same size
 * against a noisy one. What stops that from flooding the top of a `movers` list
 * is the `minSample` gate, not the epsilon — a flat-zero series with two events
 * behind it reports `aboveMinSample: false` and is ranked below every gated
 * mover (see `movers.ts`).
 */
export const ROBUST_Z_EPSILON = 1e-9;

/** Scale factor making the MAD a consistent estimator of σ for normal data. */
export const MAD_TO_SIGMA = 1.4826;

/** The finite values of `values`, in a fresh array. */
function finite(values: readonly number[]): number[] {
  const out: number[] = [];
  for (const value of values) if (Number.isFinite(value)) out.push(value);
  return out;
}

/** The finite values of `values`, ascending, in a fresh array. */
function sortedFinite(values: readonly number[]): number[] {
  return finite(values).sort((a, b) => a - b);
}

/** The arithmetic mean of the finite values; `null` when there are none. */
export function mean(values: readonly number[]): number | null {
  const sample = finite(values);
  if (sample.length === 0) return null;
  let total = 0;
  for (const value of sample) total += value;
  return total / sample.length;
}

/**
 * The `q`-quantile (`0..1`) by **linear interpolation between order statistics**
 * — the "R type 7" / `numpy.percentile` default, and the same definition the
 * dialects' own `quantile()` uses closely enough for the tolerances the parity
 * harness applies.
 *
 * `null` when the series is empty or `q` is outside `0..1`. `q = 0` and `q = 1`
 * return the min and max exactly.
 */
export function quantile(values: readonly number[], q: number): number | null {
  if (!Number.isFinite(q) || q < 0 || q > 1) return null;
  const sample = sortedFinite(values);
  if (sample.length === 0) return null;
  if (sample.length === 1) return sample[0] as number;
  const position = q * (sample.length - 1);
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  const low = sample[lower] as number;
  if (lower === upper) return low;
  const high = sample[upper] as number;
  return low + (high - low) * (position - lower);
}

/** The median (the 0.5 quantile); `null` on an empty series. */
export function median(values: readonly number[]): number | null {
  return quantile(values, 0.5);
}

/**
 * The **median absolute deviation**: `median(|x − median(x)|)`.
 *
 * The robust counterpart of the standard deviation, and the spread every
 * insight primitive compares against. Unlike σ it has a breakdown point of 50%,
 * so a single catastrophic day in a 28-day window widens it by nothing at all
 * instead of tripling it. Reported **unscaled** (raw median deviation, not
 * multiplied by {@link MAD_TO_SIGMA}) because it is used as a denominator for a
 * *ranking* score rather than as a σ estimate; a caller that wants σ multiplies.
 *
 * `null` on an empty series; `0` on a constant one, which is a true statement
 * about the data rather than a missing value.
 */
export function medianAbsoluteDeviation(values: readonly number[]): number | null {
  const sample = finite(values);
  if (sample.length === 0) return null;
  const centre = median(sample);
  if (centre == null) return null;
  return median(sample.map((value) => Math.abs(value - centre)));
}

/**
 * The **robust z-score** of a change: `delta / (mad + ε)`.
 *
 * "How many typical bucket-to-bucket deviations is this move?" — the ranking
 * score for `movers` (design sketch §D). Returns `0` for a zero delta whatever
 * the spread (nothing moved, so nothing is surprising), and `null` when `delta`
 * or `mad` is missing or non-finite, so a metric with no reference series is
 * reported as unranked rather than as a confident zero.
 *
 * A negative `mad` is impossible by construction and is treated as missing.
 */
export function robustZ(
  delta: number | null,
  mad: number | null,
  epsilon: number = ROBUST_Z_EPSILON,
): number | null {
  if (delta == null || !Number.isFinite(delta)) return null;
  if (mad == null || !Number.isFinite(mad) || mad < 0) return null;
  if (delta === 0) return 0;
  return delta / (mad + epsilon);
}

/**
 * Relative change from `previous` to `current`, as a ratio (`0.25` is +25%).
 *
 * `null` when either side is missing or when `previous` is zero — a percentage
 * change from nothing is undefined, and reporting `Infinity` (or, worse,
 * `100%`) would be a claim the data does not support. The absolute `delta` is
 * always available alongside it, which is the honest number in that case.
 */
export function relativeChange(current: number | null, previous: number | null): number | null {
  if (current == null || previous == null) return null;
  if (!Number.isFinite(current) || !Number.isFinite(previous) || previous === 0) return null;
  return (current - previous) / Math.abs(previous);
}

/** The sum of the finite values; `null` when there are none (never `0`). */
export function sum(values: readonly number[]): number | null {
  const sample = finite(values);
  if (sample.length === 0) return null;
  let total = 0;
  for (const value of sample) total += value;
  return total;
}

/**
 * Round a computed statistic to a fixed number of decimals.
 *
 * Applied at the API edge only. Two engines can differ in the last bits of a
 * floating-point division, and an agent comparing a `z` of `3.0000000000000004`
 * with one of `3` should not see a difference — so every derived number the
 * insight endpoints emit is rounded to a declared precision, which also keeps
 * the JSON (and the tokens an agent pays for it) small.
 */
export function round(value: number | null, decimals = 6): number | null {
  if (value == null || !Number.isFinite(value)) return null;
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}
