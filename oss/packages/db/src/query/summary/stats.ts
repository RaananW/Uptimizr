/**
 * The two small statistics a summary needs: an interval on a share, and the
 * slope of an ordered series. Both are pure, closed-form and deterministic —
 * a summary must say the same thing every time it is asked.
 */

import type { ShareInterval, TrendDirection } from "./types.js";

/** z for a two-sided 95% normal interval. */
export const Z_95 = 1.959963984540054;

/**
 * **Wilson score interval** on a proportion.
 *
 * Used instead of the textbook normal approximation because a summary's shares
 * are routinely extreme: a mesh with 3 clicks out of 9,130 has `p̂ ≈ 0.0003`,
 * where `p̂ ± z·√(p̂(1-p̂)/n)` happily reaches below zero. Wilson stays inside
 * `[0, 1]` and behaves at small `n`, which is exactly the regime an agent is
 * most likely to over-read.
 *
 * Returns `null` when the proportion is not defined (no trials, or a count
 * outside `0..trials` — which happens whenever the "total" is not really the
 * denominator of the row, e.g. a truncated top-N list).
 */
export function wilsonInterval(
  successes: number,
  trials: number,
  z: number = Z_95,
): ShareInterval | null {
  if (!Number.isFinite(successes) || !Number.isFinite(trials)) return null;
  if (trials <= 0 || successes < 0 || successes > trials) return null;
  const p = successes / trials;
  const z2 = z * z;
  const denominator = 1 + z2 / trials;
  const centre = (p + z2 / (2 * trials)) / denominator;
  const margin = (z / denominator) * Math.sqrt((p * (1 - p)) / trials + z2 / (4 * trials * trials));
  return { low: Math.max(0, centre - margin), high: Math.min(1, centre + margin) };
}

/** The least-squares slope of `values` against their index; `null` under 2 points. */
export function leastSquaresSlope(values: readonly number[]): number | null {
  const n = values.length;
  if (n < 2) return null;
  const meanX = (n - 1) / 2;
  let meanY = 0;
  for (const value of values) meanY += value;
  meanY /= n;
  let covariance = 0;
  let variance = 0;
  for (let i = 0; i < n; i++) {
    const dx = i - meanX;
    covariance += dx * ((values[i] as number) - meanY);
    variance += dx * dx;
  }
  return variance === 0 ? null : covariance / variance;
}

/**
 * Classify a slope as a direction.
 *
 * "Flat" is deliberately generous: the total drift across the series has to
 * exceed 5% of the series' mean magnitude before it is called a trend, so
 * ordinary sampling noise on a short range does not get reported as a move.
 */
export function trendOf(values: readonly number[], slope: number | null): TrendDirection {
  if (slope == null || values.length < 2) return "flat";
  let magnitude = 0;
  for (const value of values) magnitude += Math.abs(value);
  magnitude /= values.length;
  const drift = Math.abs(slope) * (values.length - 1);
  if (magnitude === 0) return drift === 0 ? "flat" : slope > 0 ? "up" : "down";
  if (drift < 0.05 * magnitude) return "flat";
  return slope > 0 ? "up" : "down";
}
