import {
  ANOMALY_MIN_TRAILING,
  ANOMALY_TRAILING_BUCKETS,
  BUCKET_SECONDS,
  bucketMeasureFor,
  computeBaseline,
  computeMover,
  detectAnomalies,
  floorToBucket,
  inWindow,
  isBucketableMetric,
  rollupWindow,
  summarizeRows,
  type BucketGrain,
  type MetricBucketOptions,
  type MetricBucketRow,
  type SubscriptionRecord,
} from "@uptimizr/db";
import { parseDurationMs, type ComparisonOp, type SubscriptionFiring } from "@uptimizr/schema";
import type { MetricDefinition } from "@uptimizr/metrics";

/**
 * **Subscription predicate evaluation** (#311, ADR 0051 §6 / sketch §F.2).
 *
 * Everything that decides whether a standing question is answered "yes" right
 * now lives here, and it is a pure function of *rows* — the only I/O is the one
 * injected {@link BucketReader}, which is the same
 * `store.metricBuckets(projectId, …)` the insight routes call. That keeps the
 * whole predicate vocabulary unit-testable without a database, a timer or a
 * server, and keeps the four stores interchangeable: the series a predicate sees
 * is the parity-tested portable bucket series, not per-dialect SQL of its own.
 *
 * ## Why the window is not snapped the way the insight routes snap theirs
 *
 * `baseline`, `movers` and `anomalies` floor `until` to the last **complete**
 * bucket, because they compare periods and a partial period reads as a collapse
 * every morning. A subscription is the opposite question — *is something wrong
 * right now* — so its window ends at the instant of evaluation and its final
 * bucket is deliberately partial. `since` is still floored, so the series the
 * store returns is bucket-aligned and every row is attributed exactly once.
 *
 * ## Why `threshold.column` must be the metric's headline column
 *
 * The portable series reproduces exactly one column per metric — the registry's
 * `comparable.primary` (`perf_summary` → `p50_fps`). Comparing any other column
 * would mean running the metric's own endpoint handler, which is per-metric code
 * the scheduler would have to re-enter, and would drag five dialects' quantile
 * semantics into an alert threshold. Asking for another column is a `400` that
 * *names* the right one — see {@link thresholdColumnFor}.
 */

/** The one store read a predicate may issue, injected so tests need no store. */
export type BucketReader = (opts: MetricBucketOptions) => Promise<MetricBucketRow[]>;

/** Live presence, injected the same way (the `presence` predicate's only input). */
export type PresenceReader = () => number;

/** What an evaluation needs besides the subscription itself. */
export interface EvaluateDeps {
  readBuckets: BucketReader;
  /** Concurrent live sessions; only read by the `presence` predicate. */
  activeSessions?: PresenceReader;
  /** Injected clock. Defaults to `Date.now`. */
  now?: () => number;
}

/** The half-open window an evaluation measured. */
export interface EvaluationWindow {
  since: number;
  until: number;
}

/**
 * The outcome of one evaluation.
 *
 * A non-firing evaluation still carries its numbers and a `reason`: that is what
 * `POST /api/v1/subscriptions/:id/test` answers with, and "it did not fire
 * because the window held 12 samples and `minSample` is 20" is the difference
 * between a subscription an operator can tune and one they delete.
 */
export interface EvaluationResult {
  fired: boolean;
  /** Human-readable account of the outcome, firing or not. */
  reason: string;
  window: EvaluationWindow;
  /** The observed value the predicate judged, when there is a single one. */
  value: number | null;
  /** What it was judged against — a level, an expectation, a previous window. */
  expected: number | null;
  /** The window's denominator: events, or distinct sessions. */
  sampleSize: number;
  /** The dimension value behind the outcome (`new_value`, attributed anomaly). */
  dimensionValue: string | null;
  /** The bucket series the evaluation read, for the delivery summary. */
  series: readonly MetricBucketRow[];
  /** Grain the series was read at. */
  bucket: BucketGrain;
}

/** Windows up to this long default to hourly buckets; longer ones to daily. */
const HOURLY_WINDOW_CEILING_MS = 7 * 86_400_000;

/** Resolve the series grain: the declared one, else hourly for short windows. */
export function bucketFor(sub: SubscriptionRecord): BucketGrain {
  if (sub.evaluate.bucket != null) return sub.evaluate.bucket;
  const windowMs = parseDurationMs(sub.evaluate.window) ?? HOURLY_WINDOW_CEILING_MS;
  return windowMs <= HOURLY_WINDOW_CEILING_MS ? "hour" : "day";
}

/**
 * The window one evaluation measures: `[floor(now − window), now)`.
 *
 * `since` is floored so the series is bucket-aligned; `until` is not, so the
 * partial bucket containing *this minute* is included. See the module note.
 */
export function resolveWindow(
  windowMs: number,
  bucket: BucketGrain,
  now: number,
): EvaluationWindow {
  const width = BUCKET_SECONDS[bucket] * 1000;
  const since = floorToBucket(now - Math.max(windowMs, width), bucket);
  return { since, until: now };
}

/** Compare two numbers with a subscription's operator. */
export function compare(left: number, op: ComparisonOp, right: number): boolean {
  switch (op) {
    case "<":
      return left < right;
    case "<=":
      return left <= right;
    case ">":
      return left > right;
    case ">=":
      return left >= right;
    case "==":
      return left === right;
    case "!=":
      return left !== right;
  }
}

/** Sum the denominators of a window's rows. */
function sampleOf(rows: readonly MetricBucketRow[]): number {
  let total = 0;
  for (const row of rows) total += Number(row.sample_size) || 0;
  return total;
}

/** The non-null values of a window's rows, in bucket order. */
function valuesOf(rows: readonly MetricBucketRow[]): number[] {
  return rows.filter((row) => row.value != null).map((row) => Number(row.value));
}

/** Round to the precision the firing payload reports numbers at. */
function round(value: number | null): number | null {
  return value == null || !Number.isFinite(value) ? null : Math.round(value * 1e6) / 1e6;
}

/**
 * The column a `threshold` predicate on `metric` may name — its registry
 * `comparable.primary`, or `null` when the metric declares none.
 */
export function thresholdColumnFor(metric: MetricDefinition): string | null {
  return metric.comparable?.primary ?? null;
}

/** Whether a metric can back a store-evaluated subscription at all. */
export function isSubscribableMetric(metricId: string): boolean {
  return isBucketableMetric(metricId);
}

/** The effective `minSample` for a threshold: the predicate's, else the registry's. */
function minSampleFor(sub: SubscriptionRecord, metric: MetricDefinition): number {
  if (sub.predicate.kind === "threshold" && sub.predicate.minSample != null) {
    return sub.predicate.minSample;
  }
  return metric.comparable?.minSample ?? 1;
}

/** A not-fired result carrying the numbers the caller still wants to see. */
function quiet(
  reason: string,
  window: EvaluationWindow,
  bucket: BucketGrain,
  series: readonly MetricBucketRow[],
  extra: Partial<EvaluationResult> = {},
): EvaluationResult {
  return {
    fired: false,
    reason,
    window,
    value: null,
    expected: null,
    sampleSize: sampleOf(series),
    dimensionValue: null,
    series,
    bucket,
    ...extra,
  };
}

/**
 * Evaluate one subscription now.
 *
 * Every predicate kind but `presence` issues **one** bucket read; `movers` and
 * `new_value` cover both their windows with a single spanning scan, the same
 * trick `movers` itself uses, so both windows are guaranteed to have seen one
 * snapshot of the data.
 */
export async function evaluateSubscription(
  deps: EvaluateDeps,
  sub: SubscriptionRecord,
  metric: MetricDefinition,
): Promise<EvaluationResult> {
  const now = (deps.now ?? Date.now)();
  const bucket = bucketFor(sub);
  const windowMs = parseDurationMs(sub.evaluate.window) ?? 3_600_000;
  const window = resolveWindow(windowMs, bucket, now);
  const scene = sub.filters.scene;

  const read = (opts: Partial<MetricBucketOptions>): Promise<MetricBucketRow[]> =>
    deps.readBuckets({
      metric: metric.id,
      bucket,
      since: window.since,
      until: window.until,
      scene,
      ...opts,
    } as MetricBucketOptions);

  switch (sub.predicate.kind) {
    case "presence": {
      const active = deps.activeSessions?.() ?? 0;
      const fired = compare(active, sub.predicate.op, sub.predicate.value);
      return {
        fired,
        reason: `${active} live session(s); predicate is presence ${sub.predicate.op} ${sub.predicate.value}`,
        window: { since: now, until: now },
        value: active,
        expected: sub.predicate.value,
        sampleSize: active,
        dimensionValue: null,
        series: [],
        bucket,
      };
    }

    case "threshold": {
      const rows = await read({});
      const values = valuesOf(rows);
      const sampleSize = sampleOf(rows);
      const minSample = minSampleFor(sub, metric);
      if (sampleSize < minSample) {
        return quiet(
          `window held ${sampleSize} sample(s), below minSample ${minSample}`,
          window,
          bucket,
          rows,
        );
      }
      const rollup = bucketMeasureFor(metric.id)?.rollup ?? "mean";
      const value = rollupWindow(values, rollup);
      if (value == null) {
        return quiet(`no value for ${metric.id} in the window`, window, bucket, rows);
      }
      const fired = compare(value, sub.predicate.op, sub.predicate.value);
      const column = sub.predicate.column;
      return {
        fired,
        reason: fired
          ? `${metric.id}.${column} is ${round(value)} — ${sub.predicate.op} ${sub.predicate.value} over ${sub.evaluate.window}`
          : `${metric.id}.${column} is ${round(value)}, which is not ${sub.predicate.op} ${sub.predicate.value}`,
        window,
        value: round(value),
        expected: sub.predicate.value,
        sampleSize,
        dimensionValue: null,
        series: rows,
        bucket,
      };
    }

    case "movers": {
      // One spanning scan covering the current window and the equal one before
      // it, split in TypeScript — half the reads, and one snapshot of the data.
      const reference = { since: window.since - windowMs, until: window.since };
      const rows = await read({ since: reference.since });
      const current = rows.filter((row) => inWindow(row.bucket, window));
      const previous = rows.filter((row) => inWindow(row.bucket, reference));
      const sampleSize = sampleOf(current);
      const minSample = minSampleFor(sub, metric);
      if (sampleSize < minSample) {
        return quiet(
          `window held ${sampleSize} sample(s), below minSample ${minSample}`,
          window,
          bucket,
          current,
        );
      }
      const mover = computeMover({
        metric: metric.id,
        direction: metric.comparable?.direction ?? "neutral",
        minSample,
        rollup: bucketMeasureFor(metric.id)?.rollup ?? "sum",
        current,
        reference: previous,
      });
      // `deltaPct` is a signed *fraction* of the reference level; the predicate
      // is declared in percent, which is what an operator writes down.
      const pct = mover.deltaPct == null ? null : mover.deltaPct * 100;
      if (pct == null) {
        return quiet(`no comparable previous window for ${metric.id}`, window, bucket, current, {
          value: mover.current,
        });
      }
      const wanted = sub.predicate.direction ?? "any";
      const directionOk = wanted === "any" ? true : wanted === "up" ? pct > 0 : pct < 0;
      const fired = directionOk && Math.abs(pct) >= sub.predicate.pct;
      return {
        fired,
        reason: fired
          ? `${metric.id} moved ${round(pct)}% versus the previous ${sub.evaluate.window} (threshold ±${sub.predicate.pct}%)`
          : `${metric.id} moved ${round(pct)}%, inside the ±${sub.predicate.pct}% threshold`,
        window,
        value: mover.current,
        expected: mover.previous,
        sampleSize,
        dimensionValue: null,
        series: current,
        bucket,
      };
    }

    case "anomaly": {
      // Anomaly detection needs trailing history to know what "normal" was, so
      // the read extends back over the primitive's own trailing window. Only
      // buckets inside the *evaluation* window can fire — the history is context,
      // not findings, or every restart would re-alert on last week.
      const trailing = ANOMALY_TRAILING_BUCKETS[bucket];
      const width = BUCKET_SECONDS[bucket] * 1000;
      const historySince = floorToBucket(window.since - trailing * width, bucket);
      const rows = await read({ since: historySince });
      if (rows.length < ANOMALY_MIN_TRAILING + 1) {
        return quiet(
          `only ${rows.length} bucket(s) of history; anomalies need more than ${ANOMALY_MIN_TRAILING}`,
          window,
          bucket,
          rows.filter((row) => inWindow(row.bucket, window)),
        );
      }
      const anomalies = detectAnomalies(metric.id, scene, rows, {
        bucket,
        sensitivity: sub.predicate.sensitivity,
      }).filter((row) => inWindow(row.bucketStart, window));
      const inside = rows.filter((row) => inWindow(row.bucket, window));
      if (anomalies.length === 0) {
        return quiet(`no anomalous ${bucket} bucket for ${metric.id}`, window, bucket, inside);
      }
      // The most extreme finding inside the window is the one worth waking
      // someone for; the rest are in the same episode.
      const worst = anomalies.reduce((a, b) => (Math.abs(b.z ?? 0) > Math.abs(a.z ?? 0) ? b : a));
      return {
        fired: true,
        reason:
          `${metric.id} was ${worst.kind} at ${new Date(worst.bucketStart).toISOString()}: ` +
          `${round(worst.value)} against an expected ${round(worst.expected)} (robust z ${round(worst.z)})`,
        window,
        value: worst.value,
        expected: worst.expected,
        sampleSize: sampleOf(inside),
        dimensionValue: worst.contributor?.value ?? null,
        series: inside,
        bucket,
      };
    }

    case "new_value": {
      // Same spanning-scan trick as `movers`, grouped by the watched dimension:
      // a value present in the current window and absent from the one before it
      // is new. Bounded by construction — one grouped read, no retained state.
      const reference = { since: window.since - windowMs, until: window.since };
      const rows = await read({ since: reference.since, groupBy: sub.predicate.dimension });
      const seen = new Set<string>();
      for (const row of rows) {
        if (inWindow(row.bucket, reference) && row.dimension_value != null) {
          seen.add(row.dimension_value);
        }
      }
      const fresh: string[] = [];
      for (const row of rows) {
        if (!inWindow(row.bucket, window)) continue;
        const value = row.dimension_value;
        // `''` is the store's "unattributed", not a value anyone named — firing
        // on it would report "a new scene appeared" for every unlabelled event.
        if (value == null || value === "" || seen.has(value)) continue;
        if (!fresh.includes(value)) fresh.push(value);
      }
      const inside = rows.filter((row) => inWindow(row.bucket, window));
      if (fresh.length === 0) {
        return quiet(
          `no unseen ${sub.predicate.dimension} value in the window`,
          window,
          bucket,
          inside,
        );
      }
      const first = fresh[0] as string;
      return {
        fired: true,
        reason:
          `new ${sub.predicate.dimension} ${JSON.stringify(first)}` +
          (fresh.length > 1 ? ` (and ${fresh.length - 1} more)` : "") +
          ` on ${metric.id}`,
        window,
        value: fresh.length,
        expected: seen.size,
        sampleSize: sampleOf(inside),
        dimensionValue: first,
        series: inside,
        bucket,
      };
    }
  }
}

/** Shape an evaluation into the firing record stored and delivered. */
export function toFiring(
  sub: SubscriptionRecord,
  result: EvaluationResult,
  at: number,
): SubscriptionFiring {
  return {
    subscriptionId: sub.id,
    name: sub.name,
    metric: sub.metric,
    predicate: sub.predicate.kind,
    at,
    window: { since: result.window.since, until: result.window.until },
    value: result.value,
    expected: result.expected,
    sampleSize: result.sampleSize,
    scene: sub.filters.scene ?? null,
    reason: result.reason,
    dimensionValue: result.dimensionValue,
  };
}

/**
 * The bounded `format=summary` block a webhook carries alongside the firing
 * (sketch §F.3: "so the receiver can act without a second call").
 *
 * It is the registry's own summary of `insight_baseline` over exactly the window
 * that fired — a real registry metric with real declared units and caveats,
 * rather than a hand-rolled bag of numbers. That is deliberate: the receiver
 * reads the same envelope it would get from `GET /api/v1/insights/baseline`, so
 * anything that can already render one can render this.
 *
 * `null` when the predicate read no series (`presence`) or the summariser
 * declines the rows.
 */
export function summaryFor(
  sub: SubscriptionRecord,
  result: EvaluationResult,
): Record<string, unknown> | null {
  if (result.series.length === 0) return null;
  const baseline = computeBaseline(sub.metric, sub.filters.scene, result.series);
  const summary = summarizeRows(
    "insight_baseline",
    [baseline as unknown as Record<string, unknown>],
    {
      range: { since: result.window.since, until: result.window.until },
      filters: {
        metric: sub.metric,
        scene: sub.filters.scene,
        bucket: result.bucket,
        window: sub.evaluate.window,
      },
    },
  );
  return summary == null ? null : (summary as unknown as Record<string, unknown>);
}
