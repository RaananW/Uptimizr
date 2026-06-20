import type { AnyEvent } from "@uptimizr/schema";
import { DEFAULT_SCENE_ID } from "@uptimizr/schema";

/**
 * In-process live event bus + presence tracker (ADR 0032 §1, §2, §3a, §6).
 *
 * The collector is a single process (DuckDB single-writer, ADR 0020), so every
 * ingested event passes through one place. The ingest route publishes each
 * enriched, validated event here; live consumers (SSE endpoints, ADR §3) read
 * from it. This is the OSS fan-out source — a multi-instance scale tier
 * supplies its own shared-bus implementation behind the same interface
 * (ADR 0004/0020) without touching `oss/**`.
 *
 * Nothing here is persisted: presence is a rolling in-memory view and the
 * per-session backfill ring is bounded. Privacy: the roster exposed to clients
 * is non-identifying (no geo/UA/visitorId — ADR §3a); `visitorId` is used only
 * internally to count distinct active visitors.
 */

/** Coarse, non-identifying recency bucket for a live session (ADR §3a). */
export type ActivityLevel = "active" | "recent" | "idle";

/** A single non-identifying roster entry surfaced to clients (ADR §3a). */
export interface PresenceRosterItem {
  sessionId: string;
  sceneId: string;
  /** Server receive time of the session's first seen event (epoch ms). */
  startedAt: number;
  /** Server receive time of the session's most recent event (epoch ms). */
  lastSeen: number;
  /** Coarse recency bucket derived from `lastSeen`. */
  activity: ActivityLevel;
}

/** Aggregate live snapshot for a project (ADR §3). */
export interface PresenceSnapshot {
  /** Distinct live sessions within the window. */
  activeSessions: number;
  /** Distinct live visitors within the window. */
  activeVisitors: number;
  /** Non-identifying roster, most-recently-active first. */
  sessions: PresenceRosterItem[];
}

/** Options for a live subscription (used by the SSE endpoints — ADR §3). */
export interface LiveSubscribeOptions {
  projectId: string;
  /** Restrict to one session (live-follow tail); omit for the project firehose. */
  sessionId?: string;
  /** Optional event-type allow-list. */
  types?: ReadonlySet<string>;
  /** Per-subscriber bounded queue size; overrides the bus default. */
  queueLimit?: number;
}

/**
 * A bounded, drop-oldest async stream of events (ADR §6). A slow consumer loses
 * its oldest buffered events (counted in {@link dropped}); it never back-pressures
 * ingest or grows memory without bound.
 */
export interface LiveSubscriber extends AsyncIterable<AnyEvent> {
  /** Close the subscription and release it from the bus. Idempotent. */
  close(): void;
  /** Count of events dropped due to a full queue. */
  readonly dropped: number;
}

export interface LiveBus {
  /** Publish enriched, validated events (called from the ingest route). */
  publish(events: readonly AnyEvent[]): void;
  /** Current aggregate + roster snapshot for a project (ADR §3). */
  presence(projectId: string): PresenceSnapshot;
  /** Recent buffered events for one session, oldest first (connect-time backfill). */
  recentForSession(projectId: string, sessionId: string): AnyEvent[];
  /** Open a bounded live subscription (ADR §6). */
  subscribe(options: LiveSubscribeOptions): LiveSubscriber;
  /** Number of open subscriptions (for connection caps — ADR §6). */
  readonly subscriberCount: number;
  /** Release timers/subscribers. */
  stop(): void;
}

export interface CreateLiveBusOptions {
  /** Liveness window in ms (ADR §1, default 30_000). Must be ≥ SDK flush cadence. */
  windowMs?: number;
  /** Per-session backfill ring size (ADR §3, default 200). */
  backfillRingSize?: number;
  /** Default per-subscriber queue size (ADR §6, default 1_000). */
  subscriberQueueLimit?: number;
  /** Clock injection for tests; defaults to `Date.now`. */
  now?: () => number;
}

interface PresenceEntry {
  projectId: string;
  sessionId: string;
  visitorId: string;
  sceneId: string;
  startedAt: number;
  lastSeen: number;
}

const SUBKEY = "\u0000";
const key = (projectId: string, sessionId: string): string => `${projectId}${SUBKEY}${sessionId}`;

class Subscriber implements LiveSubscriber {
  private readonly queue: AnyEvent[] = [];
  private waiting: ((r: IteratorResult<AnyEvent>) => void) | null = null;
  private closed = false;
  public dropped = 0;

  constructor(
    private readonly queueLimit: number,
    private readonly onClose: (s: Subscriber) => void,
  ) {}

  /** Internal: enqueue an event, dropping the oldest when full (ADR §6). */
  push(event: AnyEvent): void {
    if (this.closed) return;
    if (this.waiting) {
      const resolve = this.waiting;
      this.waiting = null;
      resolve({ value: event, done: false });
      return;
    }
    this.queue.push(event);
    if (this.queue.length > this.queueLimit) {
      this.queue.shift();
      this.dropped += 1;
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.waiting) {
      const resolve = this.waiting;
      this.waiting = null;
      resolve({ value: undefined, done: true });
    }
    this.onClose(this);
  }

  [Symbol.asyncIterator](): AsyncIterator<AnyEvent> {
    return {
      next: (): Promise<IteratorResult<AnyEvent>> => {
        const next = this.queue.shift();
        if (next !== undefined) return Promise.resolve({ value: next, done: false });
        if (this.closed) return Promise.resolve({ value: undefined, done: true });
        return new Promise((resolve) => {
          this.waiting = resolve;
        });
      },
      return: (): Promise<IteratorResult<AnyEvent>> => {
        this.close();
        return Promise.resolve({ value: undefined, done: true });
      },
    };
  }
}

/** Create the default in-process live bus (ADR 0032 §2). */
export function createLiveBus(options: CreateLiveBusOptions = {}): LiveBus {
  const windowMs = options.windowMs ?? 30_000;
  const backfillRingSize = options.backfillRingSize ?? 200;
  const defaultQueueLimit = options.subscriberQueueLimit ?? 1_000;
  const now = options.now ?? Date.now;

  /** presenceKey -> entry */
  const presence = new Map<string, PresenceEntry>();
  /** presenceKey -> bounded ring of recent events */
  const rings = new Map<string, AnyEvent[]>();
  const subscribers = new Set<Subscriber>();

  function isLive(entry: PresenceEntry, at: number): boolean {
    return at - entry.lastSeen <= windowMs;
  }

  function prune(at: number): void {
    for (const [k, entry] of presence) {
      if (!isLive(entry, at)) {
        presence.delete(k);
        rings.delete(k);
      }
    }
  }

  function activityOf(lastSeen: number, at: number): ActivityLevel {
    const age = at - lastSeen;
    if (age <= 3_000) return "active";
    if (age <= 15_000) return "recent";
    return "idle";
  }

  function track(event: AnyEvent, at: number): void {
    const sessionId = event.sessionId;
    const k = key(event.projectId, sessionId);

    if (event.type === "session_end") {
      presence.delete(k);
      rings.delete(k);
      return;
    }

    const existing = presence.get(k);
    if (existing) {
      existing.lastSeen = at;
      if (event.sceneId) existing.sceneId = event.sceneId;
      if (event.visitorId) existing.visitorId = event.visitorId;
    } else {
      presence.set(k, {
        projectId: event.projectId,
        sessionId,
        visitorId: event.visitorId ?? sessionId,
        sceneId: event.sceneId ?? DEFAULT_SCENE_ID,
        startedAt: at,
        lastSeen: at,
      });
    }

    const ring = rings.get(k);
    if (ring) {
      ring.push(event);
      if (ring.length > backfillRingSize) ring.shift();
    } else {
      rings.set(k, [event]);
    }
  }

  function matches(sub: LiveSubscribeOptions, event: AnyEvent): boolean {
    if (event.projectId !== sub.projectId) return false;
    if (sub.sessionId && event.sessionId !== sub.sessionId) return false;
    if (sub.types && !sub.types.has(event.type)) return false;
    return true;
  }

  const optionsBySub = new WeakMap<Subscriber, LiveSubscribeOptions>();

  return {
    publish(events) {
      if (events.length === 0) return;
      const at = now();
      for (const event of events) {
        track(event, at);
        for (const sub of subscribers) {
          const opts = optionsBySub.get(sub);
          if (opts && matches(opts, event)) sub.push(event);
        }
      }
    },

    presence(projectId) {
      const at = now();
      prune(at);
      const visitors = new Set<string>();
      const sessions: PresenceRosterItem[] = [];
      for (const entry of presence.values()) {
        if (entry.projectId !== projectId) continue;
        visitors.add(entry.visitorId);
        sessions.push({
          sessionId: entry.sessionId,
          sceneId: entry.sceneId,
          startedAt: entry.startedAt,
          lastSeen: entry.lastSeen,
          activity: activityOf(entry.lastSeen, at),
        });
      }
      sessions.sort((a, b) => b.lastSeen - a.lastSeen);
      return { activeSessions: sessions.length, activeVisitors: visitors.size, sessions };
    },

    recentForSession(projectId, sessionId) {
      const ring = rings.get(key(projectId, sessionId));
      return ring ? [...ring] : [];
    },

    subscribe(subOptions) {
      const sub = new Subscriber(subOptions.queueLimit ?? defaultQueueLimit, (s) => {
        subscribers.delete(s);
        optionsBySub.delete(s);
      });
      optionsBySub.set(sub, subOptions);
      subscribers.add(sub);
      return sub;
    },

    get subscriberCount() {
      return subscribers.size;
    },

    stop() {
      for (const sub of [...subscribers]) sub.close();
      presence.clear();
      rings.clear();
    },
  };
}
