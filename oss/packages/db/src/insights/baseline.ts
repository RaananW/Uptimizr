/**
 * **`baseline`** — "what is normal for this scene?" (ADR 0051 §4, sketch §D).
 *
 * Reduces a metric's per-bucket series to the handful of numbers that let a
 * reader (or an agent) judge a single later observation without re-deriving the
 * distribution: where the series sits (`mean`, `median`), how much it normally
 * moves (`mad`), what its ordinary range looks like (`p10`, `p90`), and whether
 * it is drifting (`slope`).
 *
 * Pure: it takes the rows `buildMetricBuckets` produced and returns one row. It
 * never sees a store, a request or a dialect, so the same series produces the
 * same baseline on every engine — which is the point of computing statistics in
 * TypeScript rather than in five dialects' SQL.
 */

import {
  leastSquaresSlope,
  mean,
  median,
  medianAbsoluteDeviation,
  quantile,
  round,
} from "./stats.js";
import type { MetricBucketRow } from "./buckets.js";

/**
 * What `baseline` reports. One row per request.
 *
 * Every statistic is nullable and `null` means *"not defined for this series"* —
 * an empty window, or fewer than two buckets for a slope. A brand-new project
 * reads `null`, never `0`.
 */
export interface BaselineRow {
  /** The registry metric the series is of. */
  metric: string;
  /** The scene it was scoped to; `''` when the baseline spans every scene. */
  scene: string;
  /** How many buckets carried a value. */
  buckets: number;
  mean: number | null;
  median: number | null;
  /** Median absolute deviation — the typical bucket-to-bucket swing. */
  mad: number | null;
  p10: number | null;
  p90: number | null;
  /** Least-squares slope against the bucket index: change per bucket. */
  slope: number | null;
  /** Events (or sessions, for a session-valued metric) behind the whole series. */
  sampleSize: number;
}

/** How many decimals a baseline statistic is rounded to before it leaves the API. */
export const BASELINE_PRECISION = 6;

/**
 * Reduce a bucket series to its baseline.
 *
 * Buckets whose `value` is `null` (an aggregate over no rows) are excluded from
 * every statistic but still counted in `sampleSize`, because their events did
 * happen — they simply did not produce a value for this measure.
 */
export function computeBaseline(
  metric: string,
  scene: string | undefined,
  rows: readonly MetricBucketRow[],
): BaselineRow {
  const values: number[] = [];
  let sampleSize = 0;
  // Ordered by bucket, so the slope is a slope against *time* rather than
  // against whatever order the driver happened to return rows in.
  for (const row of [...rows].sort((a, b) => a.bucket - b.bucket)) {
    sampleSize += Number.isFinite(row.sample_size) ? row.sample_size : 0;
    if (row.value != null && Number.isFinite(row.value)) values.push(row.value);
  }

  return {
    metric,
    scene: scene ?? "",
    buckets: values.length,
    mean: round(mean(values), BASELINE_PRECISION),
    median: round(median(values), BASELINE_PRECISION),
    mad: round(medianAbsoluteDeviation(values), BASELINE_PRECISION),
    p10: round(quantile(values, 0.1), BASELINE_PRECISION),
    p90: round(quantile(values, 0.9), BASELINE_PRECISION),
    slope: round(leastSquaresSlope(values), BASELINE_PRECISION),
    sampleSize,
  };
}
