/**
 * **Window resolution** for the insight primitives (ADR 0051 §4, sketch §D).
 *
 * Both primitives take a time range the way the rest of the query surface does
 * (`since` / `until`, epoch ms, lower-inclusive and upper-exclusive) and both
 * add a shorthand on top — `window` days for `baseline`, an implicit "previous
 * equal window" reference for `movers`. This module is the single place those
 * shorthands become concrete milliseconds, so the route stays thin and the rules
 * are unit-testable without a server.
 *
 * ## Windows are snapped to bucket boundaries
 *
 * Every resolved bound is floored to the bucket grain. Two reasons, and both are
 * about not lying to the reader:
 *
 * 1. **No partial buckets.** A range ending "now" would otherwise end mid-day,
 *    and today's third-of-a-day of traffic would be compared against whole days
 *    — which reads as a collapse in every count metric, every morning. Flooring
 *    `until` ends the window at the last *complete* bucket instead.
 * 2. **Exact attribution.** A bucket is attributed to the window its **start**
 *    falls in. With snapped bounds that is exact: every bucket lies wholly
 *    inside one window, so no event is counted twice or split.
 *
 * The snapped bounds are echoed back in the response envelope (`format=table`
 * and `format=summary` both carry `range`), so a caller can always see the
 * window that was actually measured.
 */

import { BUCKET_SECONDS, type BucketGrain } from "./measures.js";

/** Milliseconds in a day — the unit `baseline`'s `window` parameter counts in. */
export const DAY_MS = 86_400_000;

/** Default `baseline` window, in days. */
export const DEFAULT_BASELINE_WINDOW_DAYS = 28;

/** Largest `baseline` window a caller may ask for, in days. */
export const MAX_BASELINE_WINDOW_DAYS = 365;

/** Default `movers` range when the caller gives none, in days. */
export const DEFAULT_MOVERS_RANGE_DAYS = 7;

/** A resolved, bucket-aligned half-open window `[since, until)`. */
export interface ResolvedWindow {
  since: number;
  until: number;
}

/** Floor an epoch-ms instant to the start of its bucket. */
export function floorToBucket(epochMs: number, bucket: BucketGrain): number {
  const width = BUCKET_SECONDS[bucket] * 1000;
  return Math.floor(epochMs / width) * width;
}

/**
 * Resolve `baseline`'s window.
 *
 * `until` defaults to the last complete bucket before `now`; `since` defaults to
 * `window` days before that. An explicit `since` wins over `window` — the
 * shorthand only fills in a bound the caller left out, so the two can never
 * disagree about what was measured.
 *
 * The result is always non-empty: a range whose snapped bounds collapse (a
 * `window` shorter than one bucket, or an inverted pair) is widened to the
 * single bucket ending at `until`, so `baseline` answers with one bucket rather
 * than with nothing.
 */
export function resolveBaselineWindow(opts: {
  since?: number;
  until?: number;
  windowDays?: number;
  bucket: BucketGrain;
  now: number;
}): ResolvedWindow {
  const width = BUCKET_SECONDS[opts.bucket] * 1000;
  const until = floorToBucket(opts.until ?? opts.now, opts.bucket);
  const days = opts.windowDays ?? DEFAULT_BASELINE_WINDOW_DAYS;
  const since = floorToBucket(opts.since ?? until - days * DAY_MS, opts.bucket);
  return since >= until ? { since: until - width, until } : { since, until };
}

/**
 * Resolve `movers`' current range and its reference.
 *
 * The range defaults to the last {@link DEFAULT_MOVERS_RANGE_DAYS} complete
 * days. The reference defaults to **the equal window immediately before it**,
 * which is what makes "what changed this week" mean week-on-week without the
 * caller having to do date arithmetic. Either reference bound may be pinned
 * explicitly; `refUntil` alone still implies an equal-length reference ending
 * there.
 */
export function resolveMoversWindows(opts: {
  since?: number;
  until?: number;
  refSince?: number;
  refUntil?: number;
  bucket: BucketGrain;
  now: number;
}): { range: ResolvedWindow; reference: ResolvedWindow } {
  const width = BUCKET_SECONDS[opts.bucket] * 1000;
  const until = floorToBucket(opts.until ?? opts.now, opts.bucket);
  const sinceRaw = floorToBucket(
    opts.since ?? until - DEFAULT_MOVERS_RANGE_DAYS * DAY_MS,
    opts.bucket,
  );
  const since = sinceRaw >= until ? until - width : sinceRaw;
  const span = until - since;

  const refUntil = floorToBucket(opts.refUntil ?? since, opts.bucket);
  const refSinceRaw = floorToBucket(opts.refSince ?? refUntil - span, opts.bucket);
  const refSince = refSinceRaw >= refUntil ? refUntil - width : refSinceRaw;

  return { range: { since, until }, reference: { since: refSince, until: refUntil } };
}

/**
 * The single range a bucket query has to cover to serve both windows.
 *
 * `movers` issues **one** bucket scan per metric rather than two, and splits the
 * rows in TypeScript — halving the query count, and guaranteeing that both
 * windows saw the same snapshot of the data even if events land mid-request.
 */
export function spanningWindow(a: ResolvedWindow, b: ResolvedWindow): ResolvedWindow {
  return { since: Math.min(a.since, b.since), until: Math.max(a.until, b.until) };
}

/** Whether a bucket start falls inside a half-open window. */
export function inWindow(bucketStart: number, window: ResolvedWindow): boolean {
  return bucketStart >= window.since && bucketStart < window.until;
}
