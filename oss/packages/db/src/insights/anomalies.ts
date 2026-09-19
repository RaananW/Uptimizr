/**
 * **`anomalies`** — "when did this go wrong, and what inside it went wrong?"
 * (ADR 0051 §4, design sketch §D row `anomalies`).
 *
 * `baseline` says what normal looks like and `movers` says that something
 * changed between two windows a caller had to choose. Neither names **a
 * bucket**. This primitive walks one metric's bucket series and returns the
 * buckets that do not belong in it, each labelled with what kind of departure it
 * is and — where the metric declares a dimension it can be split by — which
 * value inside the metric accounts for the excess.
 *
 * Pure, like the rest of `src/insights/`: it takes the rows `buildMetricBuckets`
 * produced and returns rows. No store, no request, no dialect, so DuckDB,
 * ClickHouse, Postgres and SQL Server cannot disagree about whether a Tuesday
 * was abnormal.
 *
 * ## Three kinds, two detectors
 *
 * | `kind`  | Detector | The shape it catches |
 * | ------- | -------- | -------------------- |
 * | `spike` | robust z vs the trailing window | one bucket far above what came before |
 * | `drop`  | the same, below | one bucket far below it |
 * | `shift` | CUSUM over the whole series | a level that moved and *stayed* moved |
 *
 * The third is not a refinement of the first two, it is the case they
 * structurally cannot see: a release that costs 6 FPS every day from Tuesday
 * onward is never more than a MAD or two off on any single day, so no point
 * detector will ever flag it, and yet it is the finding that matters most. Both
 * detectors are driven by the *same* `sensitivity` dial and measured in the same
 * unit (MADs of the series' own spread), so the two halves of a result are
 * comparable rather than two unrelated alarms sharing an endpoint.
 *
 * ## The denominator: a scaled MAD, with a floor
 *
 * `sensitivity` is a **threshold**, not a ranking key, so the unit it counts has
 * to be calibrated or the default is meaningless. The MAD of normally
 * distributed data is about 0.674σ, so a raw `|z| > 3` on MADs is really "beyond
 * 2σ" — a two-sided tail of roughly 4% *per bucket*, which over a 28-day window
 * reports one or two perfectly ordinary days every time it is called. That is
 * exactly the experience that makes people switch anomaly detection off.
 *
 * The spread is therefore `max(MAD × {@link MAD_TO_SIGMA}, 1% × |median|)`: the
 * MAD rescaled into standard deviations, so `sensitivity: 3` means what a reader
 * assumes it means, and then floored the way `movers` floors it. The floor is
 * what stops a metric that sat at exactly 60 FPS for a fortnight — trailing MAD
 * of 0 — from reporting a 59.9 FPS day as an infinite departure.
 *
 * `movers` reports the **unscaled** ratio, because there it ranks rather than
 * thresholds and a constant factor changes no ordering. The two `z` columns
 * therefore differ by that constant, which the registry entries both say.
 *
 * ## Cost is bounded, and declared
 *
 * The detection itself is one bucket read — the same grouped scan every insight
 * makes. Attribution costs **at most {@link ANOMALY_MAX_CONTRIBUTOR_SCANS} extra
 * grouped scans per request**, no matter how many buckets were anomalous:
 * adjacent findings are merged into windows, the windows are ranked by how
 * extreme they are, and only the top few are re-read. A metric with no declared
 * split dimension pays for none.
 */

import { MIN_SPREAD_FRACTION } from "./movers.js";
import { MAD_TO_SIGMA, median, medianAbsoluteDeviation, round } from "./stats.js";
import { cusumChangePoints, rollingRobustStats, type ChangePoint } from "./changepoint.js";
import type { MetricBucketRow } from "./buckets.js";
import {
  BUCKET_SECONDS,
  bucketMeasureFor,
  type BucketGrain,
  type BucketSplitDimension,
} from "./measures.js";

/** Default `sensitivity`: a bucket must be more than three MADs out. */
export const DEFAULT_ANOMALY_SENSITIVITY = 3;

/** Smallest `sensitivity` a caller may ask for. */
export const MIN_ANOMALY_SENSITIVITY = 1;

/**
 * Largest `sensitivity` a caller may ask for.
 *
 * Bounded at both ends on purpose. Below 1 every bucket is an anomaly and the
 * answer is noise; above 10 nothing short of a total outage is, and a caller who
 * wants that has asked the wrong question — they want a threshold alert, which
 * is stage 3's `subscriptions`, not a detector.
 */
export const MAX_ANOMALY_SENSITIVITY = 10;

/**
 * How many buckets of history each bucket is judged against, per grain.
 *
 * A fortnight at day grain: long enough for the median to be stable, short
 * enough that a month-old regime does not keep flagging today. A week at hour
 * grain, which is 168 buckets — the shortest window that contains every hour of
 * every weekday, so a quiet Sunday 03:00 is compared against a distribution that
 * has seen quiet nights rather than against Tuesday lunchtime.
 */
export const ANOMALY_TRAILING_BUCKETS: Readonly<Record<BucketGrain, number>> = {
  day: 14,
  hour: 168,
};

/**
 * Trailing values a bucket needs before it can be judged at all.
 *
 * Under five, the median and the MAD are describing the accident of which four
 * buckets happened to exist. Buckets with less history than this are reported as
 * nothing rather than as findings — which is why a brand-new project reads
 * "no anomalies" instead of "every day is an anomaly".
 */
export const ANOMALY_MIN_TRAILING = 5;

/**
 * The hard cap on extra grouped scans spent on attribution, per request.
 *
 * Contributor attribution re-reads the series grouped by one dimension over an
 * anomalous window. Adjacent anomalous buckets are one window, and only the
 * three most extreme windows are re-read, so the endpoint's cost is
 * `1 + min(windows, 3)` grouped scans whatever the data looks like. A caller who
 * wants attribution on a quieter finding narrows `since`/`until` around it; that
 * is cheaper for the store than lifting the cap would be.
 */
export const ANOMALY_MAX_CONTRIBUTOR_SCANS = 3;

/** Decimals an anomaly's numbers are rounded to before they leave the API. */
export const ANOMALY_PRECISION = 6;

/** What kind of departure a row reports. */
export type AnomalyKind = "spike" | "drop" | "shift";

/** Which value inside the metric accounts for the excess. */
export interface AnomalyContributor {
  /** The dimension the metric declared it can be split by. */
  dimension: BucketSplitDimension;
  /** The value holding the largest share of the excess; `''` is "unattributed". */
  value: string;
  /**
   * That value's share of the total same-signed excess, `0..1`. `null` when the
   * excess could not be apportioned (every split value moved the other way).
   */
  share: number | null;
}

/** One anomalous bucket. */
export interface AnomalyRow {
  /** The registry metric the series is of. */
  metric: string;
  /** The scene it was scoped to; `''` when the series spans every scene. */
  scene: string;
  /** Bucket start, epoch milliseconds (UTC, aligned to the grain). */
  bucketStart: number;
  /** The observed value — for a `shift`, the level that held *after* the change. */
  value: number | null;
  /** What was expected — the trailing median, or for a `shift` the level before it. */
  expected: number | null;
  /** Robust z: `(value − expected) / max(MAD, 1% × |median|)`. Signed. */
  z: number | null;
  kind: AnomalyKind;
  /** The dimension value behind the excess, or `null` when none can be named. */
  contributor: AnomalyContributor | null;
  /** The bucket's own denominator — events, or distinct sessions. */
  sampleSize: number;
}

/** How to score a series. */
export interface DetectAnomaliesOptions {
  /** Time grain of the series; decides the trailing-window length. */
  bucket: BucketGrain;
  /** How many MADs out a bucket must be. Defaults to {@link DEFAULT_ANOMALY_SENSITIVITY}. */
  sensitivity?: number;
}

/** A bucket-aligned half-open span of the series, `[since, until)`. */
export interface AnomalyWindow {
  since: number;
  until: number;
}

/** Clamp a caller's `sensitivity` into the supported range. */
export function clampSensitivity(value: number | undefined): number {
  if (value == null || !Number.isFinite(value)) return DEFAULT_ANOMALY_SENSITIVITY;
  return Math.min(MAX_ANOMALY_SENSITIVITY, Math.max(MIN_ANOMALY_SENSITIVITY, value));
}

/**
 * The dimension `anomalies` would attribute this metric's excess to, or `null`.
 *
 * `null` for a metric that declares none, and also for a `scene`-split metric on
 * a request that is already scoped to one scene: the split would return a single
 * value with a share of 1, which is not an explanation, and the scan that
 * produced it would be wasted.
 */
export function contributorDimensionFor(
  metric: string,
  opts: { scene?: string } = {},
): BucketSplitDimension | null {
  const splitBy = bucketMeasureFor(metric)?.splitBy;
  if (splitBy == null) return null;
  if (splitBy === "scene" && opts.scene != null && opts.scene.length > 0) return null;
  return splitBy;
}

/**
 * The spread a departure is measured in: the MAD rescaled to a standard
 * deviation ({@link MAD_TO_SIGMA}), floored at {@link MIN_SPREAD_FRACTION} of the
 * level. `null` when there is no spread to speak of.
 *
 * The rescaling is what makes `sensitivity` a calibrated dial (see the module
 * doc); the floor is `movers`' own, so a flat window behaves identically in both
 * primitives.
 */
function flooredSpread(centre: number | null, mad: number | null): number | null {
  if (centre == null || mad == null || !Number.isFinite(mad)) return null;
  return Math.max(mad * MAD_TO_SIGMA, Math.abs(centre) * MIN_SPREAD_FRACTION);
}

/** A finite, bucket-ordered series from the store's rows. */
function seriesOf(
  rows: readonly MetricBucketRow[],
): { bucket: number; value: number; sample: number }[] {
  return [...rows]
    .filter((row) => row.value != null && Number.isFinite(row.value))
    .sort((a, b) => a.bucket - b.bucket)
    .map((row) => ({
      bucket: row.bucket,
      value: row.value as number,
      sample: Number.isFinite(row.sample_size) ? row.sample_size : 0,
    }));
}

/**
 * Score one metric's bucket series and return its anomalous buckets, ordered by
 * bucket, `contributor` still `null`.
 *
 * Point findings come first in time order, then the change-points, and a bucket
 * that is both a spike and the start of a shift is reported twice — deliberately:
 * "Tuesday was the worst day" and "Tuesday is when it stopped recovering" are two
 * different facts, and collapsing them loses the second one.
 */
export function detectAnomalies(
  metric: string,
  scene: string | undefined,
  rows: readonly MetricBucketRow[],
  opts: DetectAnomaliesOptions,
): AnomalyRow[] {
  const series = seriesOf(rows);
  const sensitivity = clampSensitivity(opts.sensitivity);
  const out: AnomalyRow[] = [];
  if (series.length === 0) return out;

  const values = series.map((point) => point.value);

  // --- point detection: each bucket against the ones just before it ---------
  const trailing = rollingRobustStats(
    values,
    ANOMALY_TRAILING_BUCKETS[opts.bucket],
    ANOMALY_MIN_TRAILING,
  );
  for (const [index, point] of series.entries()) {
    const stats = trailing[index];
    if (stats == null || stats.median == null) continue;
    // The same floored spread `movers` divides by, so a `z` of 4 means the same
    // thing in both primitives — and taken from the trailing statistics already
    // computed, so scoring a bucket stays O(1) on top of the rolling pass.
    const spread = flooredSpread(stats.median, stats.mad);
    if (spread == null || !(spread > 0)) continue;
    const z = (point.value - stats.median) / spread;
    if (Math.abs(z) <= sensitivity) continue;
    out.push({
      metric,
      scene: scene ?? "",
      bucketStart: point.bucket,
      value: round(point.value, ANOMALY_PRECISION),
      expected: round(stats.median, ANOMALY_PRECISION),
      z: round(z, ANOMALY_PRECISION),
      kind: z > 0 ? "spike" : "drop",
      contributor: null,
      sampleSize: point.sample,
    });
  }

  // --- change-points: a level that moved and stayed moved ------------------
  // The spread is the whole series', so a shift's z is in the same MAD unit as a
  // spike's; the *reference level* each segment is judged against is the level
  // it started at, which the segmenting in `cusumChangePoints` re-estimates.
  const spread = flooredSpread(median(values), medianAbsoluteDeviation(values));
  for (const change of cusumChangePoints(
    values,
    spread,
    sensitivity,
    ANOMALY_TRAILING_BUCKETS[opts.bucket],
  )) {
    const point = series[change.index];
    if (point == null) continue;
    out.push(shiftRow(metric, scene, point, change, spread));
  }

  return out.sort((a, b) => a.bucketStart - b.bucketStart || kindOrder(a.kind) - kindOrder(b.kind));
}

/** Point findings before the change-point that starts at the same bucket. */
function kindOrder(kind: AnomalyKind): number {
  return kind === "shift" ? 1 : 0;
}

/** One `shift` row: the change-point bucket, carrying the pre and post levels. */
function shiftRow(
  metric: string,
  scene: string | undefined,
  point: { bucket: number; sample: number },
  change: ChangePoint,
  spread: number | null,
): AnomalyRow {
  const delta = change.after != null && change.before != null ? change.after - change.before : null;
  return {
    metric,
    scene: scene ?? "",
    bucketStart: point.bucket,
    value: round(change.after, ANOMALY_PRECISION),
    expected: round(change.before, ANOMALY_PRECISION),
    // The size of the *level change*, in the same MAD unit as a spike's z — not
    // the CUSUM statistic, which is an accumulation and would not be comparable.
    z:
      delta == null || spread == null || !(spread > 0)
        ? null
        : round(delta / spread, ANOMALY_PRECISION),
    kind: "shift",
    contributor: null,
    sampleSize: point.sample,
  };
}

/**
 * Merge anomalous buckets into the windows a contributor scan has to cover, most
 * extreme first, capped at {@link ANOMALY_MAX_CONTRIBUTOR_SCANS}.
 *
 * Adjacent findings — a three-day outage is three rows — share one window and
 * therefore one scan. Each window is widened backwards by the trailing length so
 * the same scan also carries the history each split value's own "expected" is
 * computed from; without that the attribution would compare a value against
 * nothing and name whichever dimension happens to be biggest.
 */
export function contributorWindows(
  rows: readonly AnomalyRow[],
  opts: { bucket: BucketGrain; seriesUntil: number },
): AnomalyWindow[] {
  const width = BUCKET_SECONDS[opts.bucket] * 1000;
  const trailing = ANOMALY_TRAILING_BUCKETS[opts.bucket] * width;
  const ordered = [...rows].sort((a, b) => a.bucketStart - b.bucketStart);

  const groups: { since: number; until: number; score: number }[] = [];
  for (const row of ordered) {
    const score = row.z == null ? 0 : Math.abs(row.z);
    const last = groups[groups.length - 1];
    // A `shift` is a statement about everything from its bucket onward, so its
    // window runs to the end of the series; a point finding is one bucket.
    const until = row.kind === "shift" ? opts.seriesUntil : row.bucketStart + width;
    if (last != null && row.bucketStart <= last.until) {
      last.until = Math.max(last.until, until);
      last.score = Math.max(last.score, score);
    } else {
      groups.push({ since: row.bucketStart, until, score });
    }
  }

  return groups
    .sort((a, b) => b.score - a.score || a.since - b.since)
    .slice(0, ANOMALY_MAX_CONTRIBUTOR_SCANS)
    .map((group) => ({ since: group.since - trailing, until: group.until }))
    .sort((a, b) => a.since - b.since);
}

/** Whether an anomalous bucket falls inside a contributor window. */
export function inContributorWindow(row: AnomalyRow, window: AnomalyWindow): boolean {
  return row.bucketStart >= window.since && row.bucketStart < window.until;
}

/**
 * Name the dimension value that accounts for one row's excess.
 *
 * `splitRows` are the same measure re-read grouped by `dimension` over the row's
 * contributor window. For each value the excess is `observed − prior`, where
 * `prior` is that value's median over the buckets *before* the finding and
 * `observed` is its value in the anomalous bucket (or, for a `shift`, its median
 * from the change-point onward — the same before/after comparison the row
 * itself reports, done one dimension value at a time).
 *
 * The winner is the largest excess **with the same sign as the row's own**: a
 * spike is explained by what went up, and a value that happened to fall during
 * an error spike is not a contributor to it. `share` is that value's fraction of
 * the summed same-signed excess, so the shares of all contributing values add to
 * 1 and a reported share of 0.9 means what a reader thinks it means.
 *
 * Returns `null` when nothing can be named: no split rows, or an excess of zero,
 * or every split value moving against the finding.
 */
export function attributeContributor(
  row: AnomalyRow,
  dimension: BucketSplitDimension,
  splitRows: readonly MetricBucketRow[],
): AnomalyContributor | null {
  if (row.value == null || row.expected == null) return null;
  const direction = Math.sign(row.value - row.expected);
  if (direction === 0) return null;

  const byValue = new Map<string, { bucket: number; value: number }[]>();
  for (const split of splitRows) {
    if (split.value == null || !Number.isFinite(split.value)) continue;
    const key = split.dimension_value ?? "";
    const list = byValue.get(key);
    if (list == null) byValue.set(key, [{ bucket: split.bucket, value: split.value }]);
    else list.push({ bucket: split.bucket, value: split.value });
  }
  if (byValue.size === 0) return null;

  const excesses: { value: string; excess: number }[] = [];
  for (const [key, points] of byValue) {
    const prior = median(points.filter((p) => p.bucket < row.bucketStart).map((p) => p.value)) ?? 0;
    const observed =
      row.kind === "shift"
        ? median(points.filter((p) => p.bucket >= row.bucketStart).map((p) => p.value))
        : (points.find((p) => p.bucket === row.bucketStart)?.value ?? null);
    // A split value that vanished in the anomalous bucket contributes its own
    // absence: for a drop that is the whole explanation.
    const excess = (observed ?? 0) - prior;
    if (Math.sign(excess) === direction) excesses.push({ value: key, excess });
  }
  if (excesses.length === 0) return null;

  let total = 0;
  for (const entry of excesses) total += entry.excess;
  const winner = excesses.reduce((best, entry) =>
    Math.abs(entry.excess) > Math.abs(best.excess) ? entry : best,
  );
  return {
    dimension,
    value: winner.value,
    share: total === 0 ? null : round(winner.excess / total, ANOMALY_PRECISION),
  };
}
