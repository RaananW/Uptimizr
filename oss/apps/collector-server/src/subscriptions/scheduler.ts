import type { AnyEvent } from "@uptimizr/schema";
import { isBusBackedPredicate, parseDurationMs } from "@uptimizr/schema";
import type { SubscriptionRecord } from "@uptimizr/db";
import { getMetric, type MetricDefinition } from "@uptimizr/metrics";
import type { CollectorConfig } from "../config.js";
import type { LiveBus, LiveSubscriber } from "../liveBus.js";
import type { CollectorStore } from "../store.js";
import { evaluateSubscription, summaryFor, toFiring, type EvaluationResult } from "./evaluate.js";
import { deliver, type DeliveryOutcome } from "./delivery.js";
import type { SubscriptionStream } from "./stream.js";

/**
 * **The subscription scheduler** (#311, ADR 0051 §6 / sketch §F.2).
 *
 * One in-process scheduler for the whole collector. Its job is small and its
 * constraints are the interesting part:
 *
 * - **Every subscription owns one timer**, firing on its own `evaluate.every`.
 *   Even the bus-backed predicates have one: `presence <= 0` ("nobody is in the
 *   scene") can only become true when events *stop* arriving, so a scheduler
 *   that only woke on bus traffic could never report it.
 * - **The bus is an accelerator, not the clock.** `presence` and `new_value`
 *   additionally watch `LiveBus.subscribe` so they react in seconds rather than
 *   at the next tick. The state each one keeps is bounded
 *   ({@link NEW_VALUE_MAX_TRIGGERS}) and the trigger is rate-limited
 *   ({@link BUS_MIN_INTERVAL_MS}), so a firehose cannot turn into a query storm.
 *   The *answer* still comes from the store evaluation, so the bus can only
 *   change when a subscription is checked, never what it concludes.
 * - **At most {@link CollectorConfig.subscriptionsMaxConcurrent} evaluations run
 *   at once**, and at most one per subscription. A tick that arrives while the
 *   previous one is still in flight is dropped, not queued — a subscription that
 *   cannot keep up with its own interval must not grow a backlog.
 * - **Cooldown is enforced before delivery, not before evaluation.** The
 *   evaluation is cheap and its result is what `POST …/test` and the dashboard
 *   read; the *firing* is what costs a webhook.
 * - **Every timer is `unref`'d and cleared by {@link SubscriptionScheduler.stop}.**
 *   A test that starts the scheduler and closes the app leaves nothing behind.
 */

/** Smallest gap between two bus-triggered evaluations of one subscription. */
export const BUS_MIN_INTERVAL_MS = 5_000;

/**
 * Distinct dimension values one `new_value` watcher remembers having triggered
 * on. Past this the set is cleared and the watcher falls back to its timer — the
 * predicate is for low-cardinality dimensions ("a new scene", "a new custom
 * event"), and an unbounded set on a hot bus is exactly the kind of state
 * ADR 0032 §6 exists to prevent.
 */
export const NEW_VALUE_MAX_TRIGGERS = 256;

/** How often the scheduler re-reads the store to pick up external changes. */
export const RELOAD_INTERVAL_MS = 60_000;

/** Promoted event fields a `new_value` dimension maps to on a live event. */
const EVENT_FIELD: Readonly<Record<string, string>> = {
  scene: "sceneId",
  name: "name",
  mesh: "mesh",
  source: "source",
};

export interface SchedulerDeps {
  store: CollectorStore;
  config: CollectorConfig;
  liveBus: LiveBus;
  stream: SubscriptionStream;
  /** Structured logger; a Fastify instance's `log` in production. */
  log: { warn: (obj: unknown, msg?: string) => void; info: (obj: unknown, msg?: string) => void };
  /** Injected for tests. Defaults to the global `fetch`. */
  fetchImpl?: typeof fetch;
  /** Injected for tests. Defaults to `Date.now`. */
  now?: () => number;
  /** Injected for tests, so webhook backoff does not sleep for real. */
  sleep?: (ms: number) => Promise<void>;
  /**
   * Fraction in `[0, 1)` used to jitter a subscription's first evaluation.
   * Defaults to `Math.random`; tests pass `() => 0` for a deterministic phase.
   */
  jitter?: () => number;
}

export interface RunOptions {
  /** Deliver a firing (record it, fan it out, POST it). `false` for a dry run. */
  deliver?: boolean;
}

export interface SubscriptionScheduler {
  /** Reconcile timers and bus watchers against the store. Idempotent. */
  reload(): Promise<void>;
  /**
   * Evaluate one subscription now, outside its schedule. Returns the evaluation
   * so `POST …/test` can answer with it. Honours cooldown when delivering.
   *
   * `null` means "not now": the subscription already had an evaluation in
   * flight, or the collector was at its concurrency cap. The route turns that
   * into a `409` rather than quietly running a second one in parallel.
   */
  runOnce(sub: SubscriptionRecord, options?: RunOptions): Promise<EvaluationResult | null>;
  /** Subscriptions currently scheduled. */
  readonly scheduledCount: number;
  /** Evaluations in flight (for tests asserting the concurrency cap). */
  readonly inFlight: number;
  /** Clear every timer and bus watcher. Idempotent. */
  stop(): void;
}

/** Per-subscription scheduler state. */
interface Slot {
  sub: SubscriptionRecord;
  /** The jittered first-evaluation timer; cleared once it has fired. */
  start: ReturnType<typeof setTimeout> | null;
  /** The steady-state interval, installed when `start` fires. */
  timer: ReturnType<typeof setInterval> | null;
  /** Guards "one evaluation in flight per subscription". */
  running: boolean;
  /** Last bus-triggered evaluation, for {@link BUS_MIN_INTERVAL_MS}. */
  lastBusRun: number;
  /** `new_value` only: dimension values already triggered on. Bounded. */
  triggered: Set<string>;
}

/** A per-project live-bus watcher shared by that project's bus-backed slots. */
interface Watcher {
  subscriber: LiveSubscriber;
  stopped: boolean;
}

/** Read one promoted dimension value off a live event. */
function dimensionValueOf(event: AnyEvent, dimension: string): string | null {
  const field = EVENT_FIELD[dimension];
  if (field == null) return null;
  const value = (event as unknown as Record<string, unknown>)[field];
  return typeof value === "string" && value.length > 0 ? value : null;
}

/**
 * Create the scheduler. It does nothing until {@link SubscriptionScheduler.reload}
 * is called, which `app.ts` does once at startup and every CRUD write does after
 * it changes something.
 */
export function createSubscriptionScheduler(deps: SchedulerDeps): SubscriptionScheduler {
  const now = deps.now ?? Date.now;
  const maxConcurrent = Math.max(1, deps.config.subscriptionsMaxConcurrent);
  const slots = new Map<string, Slot>();
  const watchers = new Map<string, Watcher>();
  let inFlight = 0;
  let stopped = false;
  let reloadTimer: ReturnType<typeof setInterval> | null = null;

  /** The registry entry a subscription watches, or `null` if it went away. */
  function metricOf(sub: SubscriptionRecord): MetricDefinition | null {
    return getMetric(sub.metric) ?? null;
  }

  /**
   * Run one evaluation, respecting the global concurrency cap and the
   * one-per-subscription rule.
   *
   * Returns `null` when the slot was busy or the cap was full — a dropped tick,
   * which is the correct answer for a periodic check whose previous run has not
   * finished. Queueing them would build exactly the backlog the cap exists to
   * prevent.
   */
  async function tick(slot: Slot, options: RunOptions = {}): Promise<EvaluationResult | null> {
    if (stopped || slot.running || inFlight >= maxConcurrent) return null;
    slot.running = true;
    inFlight += 1;
    try {
      return await evaluateAndDeliver(slot.sub, options);
    } catch (err) {
      deps.log.warn({ err, subscription: slot.sub.id }, "subscription evaluation failed");
      return null;
    } finally {
      inFlight -= 1;
      slot.running = false;
    }
  }

  /** Evaluate, then record + deliver when it fired and is out of cooldown. */
  async function evaluateAndDeliver(
    sub: SubscriptionRecord,
    options: RunOptions,
  ): Promise<EvaluationResult> {
    const metric = metricOf(sub);
    if (metric == null) {
      throw new Error(`subscription ${sub.id} names unknown metric ${JSON.stringify(sub.metric)}`);
    }
    const result = await evaluateSubscription(
      {
        readBuckets: (opts) => deps.store.metricBuckets(sub.projectId, opts),
        activeSessions: () => deps.liveBus.presence(sub.projectId).activeSessions,
        now,
      },
      sub,
      metric,
    );
    if (!result.fired || options.deliver === false) return result;

    const at = now();
    const cooldownMs = parseDurationMs(sub.cooldown) ?? 0;
    if (sub.lastFiredAt != null && at - sub.lastFiredAt.getTime() < cooldownMs) return result;

    const firing = toFiring(sub, result, at);
    const summary = summaryFor(sub, result);
    // The firing is recorded before it is delivered: a webhook that times out
    // must still leave evidence that the condition was met.
    await deps.store.recordSubscriptionEvent({
      subscriptionId: sub.id,
      projectId: sub.projectId,
      at: new Date(at),
      payload: { ...firing, summary },
    });

    let outcome: DeliveryOutcome;
    try {
      outcome = await deliver(sub, firing, summary, {
        broadcast: (f, s) => deps.stream.publish(sub.projectId, { firing: f, summary: s }),
        secret: await deps.store.getWebhookSecret(sub.projectId, sub.id),
        allowedHosts: deps.config.webhookAllowedHosts,
        fetchImpl: deps.fetchImpl,
        sleep: deps.sleep,
      });
    } catch (err) {
      outcome = {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
        attempts: 0,
        egress: false,
      };
    }

    // `lastFiredAt` is stamped whether or not delivery succeeded: the condition
    // fired, and a receiver that is down must not turn the cooldown off and let
    // the subscription re-fire on every tick.
    const failures = outcome.ok ? 0 : sub.failures + 1;
    await deps.store.recordSubscriptionOutcome(sub.projectId, sub.id, {
      firedAt: new Date(at),
      lastError: outcome.error,
      failures,
    });
    // Keep the in-memory slot in step so the cooldown holds until the next
    // reload, rather than only in the row.
    sub.lastFiredAt = new Date(at);
    sub.failures = failures;
    sub.lastError = outcome.error;
    return result;
  }

  /** Attach the per-project bus watcher, creating it on first use. */
  function ensureWatcher(projectId: string): void {
    if (watchers.has(projectId)) return;
    const subscriber = deps.liveBus.subscribe({ projectId });
    const watcher: Watcher = { subscriber, stopped: false };
    watchers.set(projectId, watcher);

    const pump = async (): Promise<void> => {
      for await (const event of subscriber) {
        if (watcher.stopped || stopped) break;
        onEvent(projectId, event);
      }
    };
    void pump();
  }

  /** Dispatch one arriving event to this project's bus-backed slots. */
  function onEvent(projectId: string, event: AnyEvent): void {
    const at = now();
    for (const slot of slots.values()) {
      if (slot.sub.projectId !== projectId) continue;
      if (!isBusBackedPredicate(slot.sub.predicate.kind)) continue;
      if (at - slot.lastBusRun < BUS_MIN_INTERVAL_MS) continue;

      if (slot.sub.predicate.kind === "new_value") {
        const value = dimensionValueOf(event, slot.sub.predicate.dimension);
        // Only an unseen value is worth waking the store for. The set is this
        // watcher's whole memory, and it is bounded.
        if (value == null || slot.triggered.has(value)) continue;
        if (slot.triggered.size >= NEW_VALUE_MAX_TRIGGERS) slot.triggered.clear();
        slot.triggered.add(value);
      }

      slot.lastBusRun = at;
      void tick(slot);
    }
  }

  /**
   * Start one subscription's timer.
   *
   * The first evaluation is delayed by a jittered fraction of the interval, so
   * a hundred subscriptions restored from the store on one boot spread their
   * first reads across the interval instead of hitting the store together. From
   * then on it is a plain interval — the phase set by the jitter persists,
   * because `reload` deliberately does not restart a timer whose cadence is
   * unchanged.
   */
  function schedule(sub: SubscriptionRecord): void {
    const everyMs = Math.max(parseDurationMs(sub.evaluate.every) ?? 60_000, 60_000);
    const jitter = Math.floor(
      Math.min(Math.max(deps.jitter?.() ?? Math.random(), 0), 0.999) * everyMs,
    );
    const slot: Slot = {
      sub,
      start: null,
      timer: null,
      running: false,
      lastBusRun: 0,
      triggered: new Set(),
    };
    slot.start = setTimeout(() => {
      slot.start = null;
      void tick(slot);
      slot.timer = setInterval(() => void tick(slot), everyMs);
      slot.timer.unref?.();
    }, jitter);
    slot.start.unref?.();
    slots.set(sub.id, slot);
    if (isBusBackedPredicate(sub.predicate.kind)) ensureWatcher(sub.projectId);
  }

  function unschedule(id: string): void {
    const slot = slots.get(id);
    if (slot == null) return;
    if (slot.start != null) clearTimeout(slot.start);
    if (slot.timer != null) clearInterval(slot.timer);
    slots.delete(id);
  }

  /**
   * Reconcile timers and bus watchers against the store.
   *
   * A named function rather than only a method, because the periodic reconcile
   * below schedules it: an arrow calling `this.reload()` would break the moment
   * anyone destructured the scheduler.
   */
  async function reloadNow(): Promise<void> {
    if (stopped) return;
    let enabled: SubscriptionRecord[];
    try {
      enabled = await deps.store.listEnabledSubscriptions();
    } catch (err) {
      deps.log.warn({ err }, "failed to read subscriptions; keeping the current schedule");
      return;
    }
    const wanted = new Map(enabled.map((sub) => [sub.id, sub]));

    for (const id of [...slots.keys()]) if (!wanted.has(id)) unschedule(id);

    for (const [id, sub] of wanted) {
      const slot = slots.get(id);
      if (slot == null) {
        schedule(sub);
        continue;
      }
      // Reschedule only when the cadence changed; otherwise keep the timer
      // (and its phase) and just refresh the declaration, so a reload does not
      // silently re-align every subscription to the same instant.
      if (slot.sub.evaluate.every !== sub.evaluate.every) {
        unschedule(id);
        schedule(sub);
      } else {
        slot.sub = sub;
      }
    }

    if (reloadTimer == null) {
      // Another instance sharing a Postgres/SQL Server database can change the
      // set without going through this process's routes.
      reloadTimer = setInterval(() => void reloadNow(), RELOAD_INTERVAL_MS);
      reloadTimer.unref?.();
    }
  }

  return {
    reload: reloadNow,

    async runOnce(sub, options = {}) {
      // An out-of-band run of a *scheduled* subscription takes the slot's
      // one-in-flight guard, so `POST …/test` cannot race its own timer. A
      // disabled (therefore unscheduled) subscription gets a fresh slot-less
      // run, still under the global cap.
      const slot = slots.get(sub.id);
      if (slot != null) return tick(slot, options);
      if (stopped || inFlight >= maxConcurrent) return null;
      inFlight += 1;
      try {
        return await evaluateAndDeliver(sub, options);
      } finally {
        inFlight -= 1;
      }
    },

    get scheduledCount() {
      return slots.size;
    },

    get inFlight() {
      return inFlight;
    },

    stop() {
      stopped = true;
      if (reloadTimer != null) clearInterval(reloadTimer);
      reloadTimer = null;
      for (const id of [...slots.keys()]) unschedule(id);
      for (const watcher of watchers.values()) {
        watcher.stopped = true;
        watcher.subscriber.close();
      }
      watchers.clear();
    },
  };
}
