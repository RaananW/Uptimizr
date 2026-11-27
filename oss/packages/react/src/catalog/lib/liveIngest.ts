/**
 * The bookkeeping a live-followed session replay does on each streamed event,
 * kept free of rendering so it can be tested against whole event streams.
 *
 * - {@link createLiveFrontier} decides whether a streamed event is new. The
 *   stream's connect-time backfill overlaps what the replay already loaded, so
 *   an event at or before the newest loaded one may be a repeat. One action
 *   emits several events in the same millisecond (a click is `pointer_down`,
 *   `pointer_up`, `pointer_click` and `mesh_interaction`, all with one `ts`), so
 *   the check compares identities, not just timestamps.
 * - {@link createLiveRayScheduler} decides when a streamed click plays. Live
 *   events arrive in SDK batches, seconds after they happened, so a click plays
 *   when it arrives rather than at its own (already past) time. Several clicks
 *   in one batch would then all pulse at once, their rays overlapping under one
 *   glow, so each plays at the later of "now" and the previous click's play time
 *   plus their real gap. Clicks in a batch keep their spacing, and the schedule
 *   never falls behind the live edge.
 */
import { liveEventKey } from "./liveEventKey";

/** The fields of a streamed event the bookkeeping reads. */
export interface LiveEventLike {
  type: string;
  ts?: unknown;
  [key: string]: unknown;
}

/** See {@link createLiveFrontier}. */
export interface LiveFrontier {
  /**
   * Whether `ev` is new and should be drawn. Records it, so the same event
   * arriving again is rejected. An event without a finite `ts` is rejected.
   */
  accept(ev: LiveEventLike): boolean;
}

/**
 * Track the newest event the replay holds. `loaded` is the replay's history,
 * sorted by `ts` ascending; only its newest millisecond matters.
 */
export function createLiveFrontier(loaded: readonly LiveEventLike[]): LiveFrontier {
  const last = loaded[loaded.length - 1];
  let frontierTs = typeof last?.ts === "number" ? last.ts : -Infinity;
  let seen = new Set<string>();
  for (let i = loaded.length - 1; i >= 0 && loaded[i]!.ts === frontierTs; i--) {
    seen.add(liveEventKey(loaded[i]!));
  }
  return {
    accept(ev) {
      const ts = typeof ev.ts === "number" ? ev.ts : NaN;
      if (!Number.isFinite(ts) || ts < frontierTs) return false;
      const key = liveEventKey(ev);
      if (ts === frontierTs) {
        if (seen.has(key)) return false;
      } else {
        frontierTs = ts;
        seen = new Set();
      }
      seen.add(key);
      return true;
    },
  };
}

/** See {@link createLiveRayScheduler}. */
export interface LiveRayScheduler {
  /** The replay time a click that happened at session time `at` starts to play. */
  click(at: number): number;
  /**
   * The replay time a pick at `at` starts to play. A pick in the same
   * millisecond as the click before it is that click's pick, and plays with it.
   */
  pick(at: number): number;
}

/**
 * Schedule streamed clicks and picks. `now` returns the replay's current
 * playhead, in the same session-relative milliseconds as `at`.
 */
export function createLiveRayScheduler(now: () => number): LiveRayScheduler {
  let last: { at: number; playAt: number; shownAt: number } | null = null;
  const click = (at: number): number => {
    const current = now();
    const playAt =
      last && at >= last.at ? Math.max(current, last.playAt + (at - last.at)) : current;
    const shownAt = Math.max(at, playAt);
    last = { at, playAt, shownAt };
    return shownAt;
  };
  return {
    click,
    pick(at) {
      return last && last.at === at ? last.shownAt : click(at);
    },
  };
}

/**
 * How many separate pulses rays starting at `starts` make: a start less than
 * `minGapMs` after the previous one joins its pulse, as their glows overlap.
 */
export function countSeparatePulses(starts: readonly number[], minGapMs: number): number {
  const sorted = [...starts].sort((a, b) => a - b);
  let pulses = 0;
  let last = -Infinity;
  for (const t of sorted) {
    if (t - last >= minGapMs) pulses++;
    last = t;
  }
  return pulses;
}
