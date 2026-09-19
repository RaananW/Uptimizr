import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AnyEvent } from "@uptimizr/schema";
import type { MetricBucketRow, SubscriptionEventInput, SubscriptionRecord } from "@uptimizr/db";
import type { CollectorConfig } from "../config.js";
import type { CollectorStore } from "../store.js";
import { createLiveBus, type LiveBus } from "../liveBus.js";
import { createSubscriptionStream } from "../subscriptions/stream.js";
import {
  BUS_MIN_INTERVAL_MS,
  createSubscriptionScheduler,
  type SubscriptionScheduler,
} from "../subscriptions/scheduler.js";

/**
 * The scheduler (#311, sketch §F.2) under fake timers.
 *
 * What is asserted here is not "does it evaluate" — `subscriptionsEvaluate`
 * covers that — but the four properties that make a hundred standing
 * subscriptions safe to run inside an ingestion server: a bounded concurrency,
 * one evaluation in flight per subscription, cooldown before delivery, and no
 * timer surviving `stop()`.
 */

const MINUTE = 60_000;

const config = {
  subscriptions: true,
  subscriptionsMaxConcurrent: 4,
  webhookAllowedHosts: [],
  liveMaxConnections: 200,
} as unknown as CollectorConfig;

const log = { warn: () => {}, info: () => {} };

function record(overrides: Partial<SubscriptionRecord> = {}): SubscriptionRecord {
  return {
    id: "sub_1",
    projectId: "p1",
    name: "test",
    metric: "perf_summary",
    filters: {},
    evaluate: { every: "1m", window: "1h", bucket: "hour" },
    predicate: { kind: "threshold", column: "p50_fps", op: "<", value: 40, minSample: 1 },
    cooldown: "1h",
    delivery: [{ kind: "sse" }],
    enabled: true,
    createdAt: new Date(0),
    updatedAt: new Date(0),
    lastFiredAt: null,
    lastError: null,
    failures: 0,
    ...overrides,
  };
}

interface Harness {
  store: CollectorStore;
  /** Resolves the next pending `metricBuckets` call; used to hold reads open. */
  release: () => void;
  reads: number;
  firings: SubscriptionEventInput[];
  outcomes: { id: string; failures?: number }[];
}

/**
 * A store whose `metricBuckets` can be held open, so a test can observe how many
 * evaluations are genuinely concurrent.
 */
function makeStore(
  subscriptions: SubscriptionRecord[],
  options: { hold?: boolean; rows?: MetricBucketRow[] } = {},
): Harness {
  const pending: (() => void)[] = [];
  const state: Harness = {
    reads: 0,
    firings: [],
    outcomes: [],
    release: () => {
      for (const resolve of pending.splice(0)) resolve();
    },
    store: {} as CollectorStore,
  };
  const rows = options.rows ?? [{ bucket: 0, value: 10, sample_size: 100 }];

  state.store = {
    listEnabledSubscriptions: async () => subscriptions.filter((s) => s.enabled),
    listSubscriptions: async () => subscriptions,
    getSubscription: async (_p: string, id: string) =>
      subscriptions.find((s) => s.id === id) ?? null,
    metricBuckets: async () => {
      state.reads += 1;
      if (options.hold) await new Promise<void>((resolve) => pending.push(resolve));
      return rows;
    },
    recordSubscriptionEvent: async (entry: SubscriptionEventInput) => {
      state.firings.push(entry);
    },
    recordSubscriptionOutcome: async (_p: string, id: string, outcome: { failures?: number }) => {
      state.outcomes.push({ id, failures: outcome.failures });
    },
    getWebhookSecret: async () => null,
  } as unknown as CollectorStore;

  return state;
}

function build(
  harness: Harness,
  liveBus: LiveBus,
  overrides: Partial<CollectorConfig> = {},
): SubscriptionScheduler {
  return createSubscriptionScheduler({
    store: harness.store,
    config: { ...config, ...overrides } as CollectorConfig,
    liveBus,
    stream: createSubscriptionStream(),
    log,
    // Deterministic phase: every subscription's first evaluation lands at t+0.
    jitter: () => 0,
  });
}

describe("subscription scheduler", () => {
  let bus: LiveBus;
  let scheduler: SubscriptionScheduler | null = null;

  beforeEach(() => {
    vi.useFakeTimers();
    bus = createLiveBus();
  });

  afterEach(() => {
    scheduler?.stop();
    scheduler = null;
    bus.stop();
    // The real assertion of "stops cleanly": nothing is left to run.
    expect(vi.getTimerCount()).toBe(0);
    vi.useRealTimers();
  });

  it("schedules every enabled subscription and skips the disabled ones", async () => {
    const subs = [record({ id: "a" }), record({ id: "b" }), record({ id: "c", enabled: false })];
    const harness = makeStore(subs);
    scheduler = build(harness, bus);

    await scheduler.reload();
    expect(scheduler.scheduledCount).toBe(2);
  });

  it("evaluates on the declared interval, after a jittered first run", async () => {
    const harness = makeStore([record()]);
    scheduler = build(harness, bus);
    await scheduler.reload();

    expect(harness.reads).toBe(0);
    await vi.advanceTimersByTimeAsync(0);
    expect(harness.reads).toBe(1);

    await vi.advanceTimersByTimeAsync(MINUTE);
    expect(harness.reads).toBe(2);
    await vi.advanceTimersByTimeAsync(2 * MINUTE);
    expect(harness.reads).toBe(4);
  });

  it("never runs more than the configured number of evaluations at once", async () => {
    const subs = Array.from({ length: 100 }, (_, i) => record({ id: `sub_${i}` }));
    const harness = makeStore(subs, { hold: true });
    scheduler = build(harness, bus, { subscriptionsMaxConcurrent: 4 });
    await scheduler.reload();

    expect(scheduler.scheduledCount).toBe(100);
    // Every one of the hundred timers fires at t+0 (jitter is pinned to 0), so
    // this is the worst case the cap exists for.
    await vi.advanceTimersByTimeAsync(0);
    expect(scheduler.inFlight).toBe(4);
    expect(harness.reads).toBe(4);

    // Ticks that arrive while the pool is full are dropped, not queued.
    await vi.advanceTimersByTimeAsync(MINUTE);
    expect(scheduler.inFlight).toBe(4);
    expect(harness.reads).toBe(4);

    harness.release();
    await vi.advanceTimersByTimeAsync(0);
    expect(scheduler.inFlight).toBe(0);
  });

  it("keeps at most one evaluation in flight per subscription", async () => {
    const harness = makeStore([record()], { hold: true });
    scheduler = build(harness, bus);
    await scheduler.reload();

    await vi.advanceTimersByTimeAsync(0);
    expect(harness.reads).toBe(1);
    // Three more ticks while the first read is still open.
    await vi.advanceTimersByTimeAsync(3 * MINUTE);
    expect(harness.reads).toBe(1);

    harness.release();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(MINUTE);
    expect(harness.reads).toBe(2);
  });

  it("records a firing once per cooldown, not once per tick", async () => {
    const harness = makeStore([record({ cooldown: "1h" })]);
    scheduler = build(harness, bus);
    await scheduler.reload();

    await vi.advanceTimersByTimeAsync(0);
    expect(harness.firings).toHaveLength(1);

    // Ten more minutes of ticks, all inside the cooldown.
    await vi.advanceTimersByTimeAsync(10 * MINUTE);
    expect(harness.reads).toBeGreaterThan(5);
    expect(harness.firings).toHaveLength(1);

    // Past the cooldown it fires again.
    await vi.advanceTimersByTimeAsync(60 * MINUTE);
    expect(harness.firings).toHaveLength(2);
  });

  it("fires on every tick when the cooldown is explicitly none", async () => {
    const harness = makeStore([record({ cooldown: "0s" })]);
    scheduler = build(harness, bus);
    await scheduler.reload();

    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(2 * MINUTE);
    expect(harness.firings).toHaveLength(3);
  });

  it("does not deliver on a dry run", async () => {
    const sub = record();
    const harness = makeStore([sub]);
    scheduler = build(harness, bus);
    await scheduler.reload();

    const result = await scheduler.runOnce(sub, { deliver: false });
    expect(result?.fired).toBe(true);
    expect(harness.firings).toHaveLength(0);
    expect(harness.outcomes).toHaveLength(0);
  });

  it("answers `null` from runOnce while an evaluation is already in flight", async () => {
    const sub = record();
    const harness = makeStore([sub], { hold: true });
    scheduler = build(harness, bus);
    await scheduler.reload();

    await vi.advanceTimersByTimeAsync(0);
    expect(await scheduler.runOnce(sub)).toBeNull();
    harness.release();
    await vi.advanceTimersByTimeAsync(0);
  });

  it("reschedules only when the cadence changed", async () => {
    const subs = [record({ id: "a" })];
    const harness = makeStore(subs);
    scheduler = build(harness, bus);
    await scheduler.reload();
    await vi.advanceTimersByTimeAsync(0);
    expect(harness.reads).toBe(1);

    // A reload with an unchanged cadence keeps the timer's phase, so the next
    // evaluation still lands one interval after the last one.
    await scheduler.reload();
    await vi.advanceTimersByTimeAsync(MINUTE);
    expect(harness.reads).toBe(2);

    subs[0] = record({ id: "a", evaluate: { every: "5m", window: "1h", bucket: "hour" } });
    await scheduler.reload();
    await vi.advanceTimersByTimeAsync(0);
    expect(harness.reads).toBe(3);
    await vi.advanceTimersByTimeAsync(MINUTE);
    expect(harness.reads).toBe(3);
    await vi.advanceTimersByTimeAsync(4 * MINUTE);
    expect(harness.reads).toBe(4);
  });

  it("drops a subscription that has gone from the store", async () => {
    const subs = [record({ id: "a" }), record({ id: "b" })];
    const harness = makeStore(subs);
    scheduler = build(harness, bus);
    await scheduler.reload();
    expect(scheduler.scheduledCount).toBe(2);

    subs.pop();
    await scheduler.reload();
    expect(scheduler.scheduledCount).toBe(1);
  });

  it("keeps the current schedule when the store read fails", async () => {
    const harness = makeStore([record()]);
    scheduler = build(harness, bus);
    await scheduler.reload();
    expect(scheduler.scheduledCount).toBe(1);

    harness.store.listEnabledSubscriptions = async () => {
      throw new Error("database is away");
    };
    await scheduler.reload();
    expect(scheduler.scheduledCount).toBe(1);
  });
});

describe("bus-backed predicates", () => {
  let bus: LiveBus;
  let scheduler: SubscriptionScheduler | null = null;

  beforeEach(() => {
    vi.useFakeTimers();
    bus = createLiveBus();
  });

  afterEach(() => {
    scheduler?.stop();
    scheduler = null;
    bus.stop();
    expect(vi.getTimerCount()).toBe(0);
    vi.useRealTimers();
  });

  function sessionStart(sessionId: string, sceneId: string): AnyEvent {
    return {
      type: "session_start",
      projectId: "p1",
      sessionId,
      sceneId,
      sdkVersion: "0.0.0-test",
      ts: Date.now(),
    } as unknown as AnyEvent;
  }

  it("re-evaluates a new_value subscription when an unseen value arrives", async () => {
    const sub = record({
      predicate: { kind: "new_value", dimension: "scene" },
      cooldown: "0s",
    });
    const harness = makeStore([sub], {
      rows: [{ bucket: 0, value: 1, sample_size: 1, dimension_value: "showroom" }],
    });
    scheduler = build(harness, bus);
    await scheduler.reload();
    await vi.advanceTimersByTimeAsync(0);
    const afterFirstTick = harness.reads;

    bus.publish([sessionStart("s1", "showroom")]);
    await vi.advanceTimersByTimeAsync(0);
    expect(harness.reads).toBe(afterFirstTick + 1);

    // The same value again is not news, so it costs nothing.
    bus.publish([sessionStart("s2", "showroom")]);
    await vi.advanceTimersByTimeAsync(0);
    expect(harness.reads).toBe(afterFirstTick + 1);
  });

  it("rate-limits bus-triggered evaluations", async () => {
    const sub = record({
      predicate: { kind: "new_value", dimension: "scene" },
      cooldown: "0s",
    });
    const harness = makeStore([sub], { rows: [] });
    scheduler = build(harness, bus);
    await scheduler.reload();
    await vi.advanceTimersByTimeAsync(0);
    const base = harness.reads;

    bus.publish([sessionStart("s1", "one")]);
    await vi.advanceTimersByTimeAsync(0);
    // A second distinct value inside the rate-limit window is ignored.
    bus.publish([sessionStart("s2", "two")]);
    await vi.advanceTimersByTimeAsync(0);
    expect(harness.reads).toBe(base + 1);

    await vi.advanceTimersByTimeAsync(BUS_MIN_INTERVAL_MS);
    const afterTimer = harness.reads;
    bus.publish([sessionStart("s3", "three")]);
    await vi.advanceTimersByTimeAsync(0);
    expect(harness.reads).toBe(afterTimer + 1);
  });

  it("opens exactly one bus subscription per project and closes it on stop", async () => {
    const subs = [
      record({ id: "a", predicate: { kind: "presence", op: "==", value: 0 } }),
      record({ id: "b", predicate: { kind: "new_value", dimension: "scene" } }),
    ];
    const harness = makeStore(subs);
    scheduler = build(harness, bus);
    await scheduler.reload();

    expect(bus.subscriberCount).toBe(1);
    scheduler.stop();
    scheduler = null;
    expect(bus.subscriberCount).toBe(0);
  });

  it("does not open a bus subscription for store-backed predicates", async () => {
    const harness = makeStore([record()]);
    scheduler = build(harness, bus);
    await scheduler.reload();
    expect(bus.subscriberCount).toBe(0);
  });
});
