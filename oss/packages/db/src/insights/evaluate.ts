/**
 * The in-memory evaluator for a {@link BucketMeasure} (ADR 0051 §4).
 *
 * `buildMetricBuckets` renders a measure to SQL for the four persistent stores.
 * The collector also ships an in-memory store — the one the playground and the
 * end-to-end harness boot without a database — which has no SQL to run. Rather
 * than let the insight endpoints go dark there (an empty series reads as "no
 * data", which is a different and misleading claim), the same declarative
 * measure is evaluated directly over events here.
 *
 * Pure, and deliberately the *same shape* as the SQL: one pass that groups by
 * bucket, then one aggregate per bucket, using the same closed predicate
 * vocabulary. `src/__tests__/insights.test.ts` runs both paths over the same
 * rows so the two cannot drift.
 */

import {
  bucketMeasureFor,
  BUCKET_SECONDS,
  type BucketGrain,
  type BucketMeasure,
  type BucketPredicate,
} from "./measures.js";
import type { MetricBucketRow } from "./buckets.js";
import { quantile } from "./stats.js";

/**
 * The promoted event columns a measure can read — the in-memory mirror of the
 * `events` table's column set. A store maps its own event representation into
 * this once, and the evaluator never sees the store's shape.
 */
export interface BucketEventLike {
  /** Event time, epoch milliseconds. */
  ts: number;
  event_type: string;
  scene_id: string;
  session_id: string;
  mesh?: string;
  name?: string;
  source?: string;
  fps?: number;
  visible_ms?: number;
  js_heap_bytes?: number;
  position?: readonly number[];
  direction?: readonly number[];
  hit_point?: readonly number[];
  screen?: readonly number[];
  /** `ar_placement.scale`, the one measure value that lives in the payload. */
  ar_placement_scale?: number;
}

/** Scope an evaluation the way the SQL's `WHERE` clause does. */
export interface EvaluateBucketOptions {
  metric: string;
  bucket?: BucketGrain;
  since?: number;
  until?: number;
  scene?: string;
}

/** The vector columns a geometry predicate can guard. */
const VECTORS = ["position", "direction", "hit_point", "screen"] as const;

/** Whether an event satisfies one predicate from the closed vocabulary. */
function matches(event: BucketEventLike, predicate: BucketPredicate): boolean {
  switch (predicate.kind) {
    case "eq":
      return (event[predicate.column] ?? "") === predicate.value;
    case "ne":
      return (event[predicate.column] ?? "") !== predicate.value;
    case "in":
      return predicate.values.includes(event[predicate.column] ?? "");
    case "geometry": {
      const column = VECTORS.find((name) => name === predicate.column);
      const vector = column == null ? undefined : event[column];
      return Array.isArray(vector) && vector.length === predicate.arity;
    }
  }
}

/** The numeric value a measure's aggregate reads off one event. */
function valueOf(event: BucketEventLike, measure: BucketMeasure): number | null {
  if (measure.aggregate.kind === "count" || measure.aggregate.kind === "sessions") return null;
  const raw = event[measure.aggregate.column];
  if (typeof raw !== "number" || !Number.isFinite(raw)) return null;
  // `js_heap_bytes` of 0 means "not reported" — excluded from averages and
  // percentiles, kept for a max. Mirrors `valueColumnExpr` in `buckets.ts`.
  if (
    measure.aggregate.column === "js_heap_bytes" &&
    raw === 0 &&
    measure.aggregate.kind !== "max"
  ) {
    return null;
  }
  return raw;
}

/**
 * Evaluate a metric's bucket series over events held in memory.
 *
 * Returns the same rows `buildMetricBuckets` would: ascending by bucket, with
 * buckets that matched nothing simply absent. Throws for a metric with no
 * portable bucket form, exactly as the builder does.
 */
export function evaluateBucketMeasure(
  events: Iterable<BucketEventLike>,
  opts: EvaluateBucketOptions,
): MetricBucketRow[] {
  const measure = bucketMeasureFor(opts.metric);
  if (measure == null) {
    throw new Error(`metric '${opts.metric}' has no portable bucket series`);
  }
  const width = BUCKET_SECONDS[opts.bucket ?? "day"] * 1000;
  const types = measure.eventTypes.length > 0 ? new Set(measure.eventTypes) : null;
  const buckets = new Map<number, { values: number[]; count: number; sessions: Set<string> }>();

  for (const event of events) {
    if (!Number.isFinite(event.ts)) continue;
    if (opts.since != null && event.ts < opts.since) continue;
    if (opts.until != null && event.ts >= opts.until) continue;
    if (opts.scene != null && opts.scene.length > 0 && event.scene_id !== opts.scene) continue;
    if (types != null && !types.has(event.event_type)) continue;
    if ((measure.where ?? []).some((predicate) => !matches(event, predicate))) continue;

    const start = Math.floor(event.ts / width) * width;
    let entry = buckets.get(start);
    if (entry == null) {
      entry = { values: [], count: 0, sessions: new Set() };
      buckets.set(start, entry);
    }
    entry.count += 1;
    entry.sessions.add(event.session_id);
    const value = valueOf(event, measure);
    if (value != null) entry.values.push(value);
  }

  const rows: MetricBucketRow[] = [];
  for (const [start, entry] of buckets) {
    rows.push({
      bucket: start,
      value: aggregate(entry, measure),
      sample_size: measure.aggregate.kind === "sessions" ? entry.sessions.size : entry.count,
    });
  }
  return rows.sort((a, b) => a.bucket - b.bucket);
}

/** Apply a measure's aggregate to one bucket's accumulated values. */
function aggregate(
  entry: { values: number[]; count: number; sessions: Set<string> },
  measure: BucketMeasure,
): number | null {
  switch (measure.aggregate.kind) {
    case "count":
      return entry.count;
    case "sessions":
      return entry.sessions.size;
    case "sum": {
      if (entry.values.length === 0) return null;
      let total = 0;
      for (const value of entry.values) total += value;
      return total;
    }
    case "avg": {
      if (entry.values.length === 0) return null;
      let total = 0;
      for (const value of entry.values) total += value;
      return total / entry.values.length;
    }
    case "max":
      return entry.values.length === 0 ? null : Math.max(...entry.values);
    case "quantile":
      return quantile(entry.values, measure.aggregate.q);
  }
}
