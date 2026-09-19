import type {
  Subscription,
  SubscriptionDelivery,
  SubscriptionEvaluate,
  SubscriptionFilters,
  SubscriptionPredicate,
} from "@uptimizr/schema";
import { LIMITS } from "@uptimizr/schema";

/**
 * **Conditional subscriptions** — engine-neutral record shape and row mapping
 * (ADR 0051 §6, design sketch §F.1).
 *
 * The four stores keep a subscription the same way they keep every other piece
 * of metadata: a handful of scalar columns for the things they must filter,
 * order or update (`project_id`, `enabled`, `last_fired_at`, `failures`), plus
 * one JSON text column for the declaration itself. The declaration is a closed
 * Zod union validated at the request boundary and never queried *into*, so
 * decomposing it into columns would buy nothing and cost a migration per
 * predicate kind.
 *
 * ## The secret is write-only, and it is not a hash
 *
 * A webhook body is signed with HMAC-SHA-256, so the collector needs the secret
 * itself at delivery time — a one-way hash cannot sign. It therefore lives in
 * its own column that **no read path ever selects into a record**: the only way
 * back out is {@link SubscriptionStore.getWebhookSecret}, which the delivery
 * module calls and nothing else. Every API response carries
 * {@link MASKED_SECRET} in its place, so a secret is write-once from the
 * caller's point of view (rotate it by replacing the subscription).
 *
 * This is the same posture as an API key's `rate_limit` or a scene proxy's blob:
 * stored because the server needs it, never echoed because the caller does not.
 * It is *not* the ADR 0003 API-key rule — a key is a credential the collector
 * only ever needs to *compare*, so it is stored hashed; a signing secret is
 * shared material both ends must hold.
 */

/** What every read path returns in place of a stored webhook secret. */
export const MASKED_SECRET = "••••••••";

/** Subscriptions one project may hold (re-exported for store-side guards). */
export const MAX_SUBSCRIPTIONS_PER_PROJECT = LIMITS.maxSubscriptionsPerProject;

/** Firings retained per subscription; older rows are dropped on write. */
export const MAX_SUBSCRIPTION_EVENTS = LIMITS.maxSubscriptionEvents;

/**
 * Ceiling on the scheduler's resume read. Ten projects at the per-project cap;
 * beyond that a self-hoster is past what a single in-process scheduler is for.
 */
export const MAX_ENABLED_SUBSCRIPTIONS = 10 * LIMITS.maxSubscriptionsPerProject;

/** Default quiet period after a firing, when a caller declares none. */
export const DEFAULT_COOLDOWN = "1h";

/**
 * A stored subscription, as every store returns it and every API response
 * shapes it. The `delivery` array is always **masked** — see the module note.
 */
export interface SubscriptionRecord {
  id: string;
  projectId: string;
  name: string;
  /** Registry metric id (`@uptimizr/metrics`). */
  metric: string;
  filters: SubscriptionFilters;
  evaluate: SubscriptionEvaluate;
  predicate: SubscriptionPredicate;
  cooldown: string;
  /** Delivery targets with any webhook secret replaced by {@link MASKED_SECRET}. */
  delivery: SubscriptionDelivery[];
  enabled: boolean;
  createdAt: Date;
  updatedAt: Date;
  /** When it last fired, or `null` if it never has. */
  lastFiredAt: Date | null;
  /** The last delivery failure, bounded and redacted, or `null`. */
  lastError: string | null;
  /** Consecutive delivery failures since the last success. */
  failures: number;
}

/** One recorded firing (sketch §F.2): `{ subscriptionId, at, payload }`. */
export interface SubscriptionEventRecord {
  id: string;
  subscriptionId: string;
  projectId: string;
  at: Date;
  /** The firing payload as stored — JSON text, parsed by the row mapper. */
  payload: Record<string, unknown>;
}

/** What a store needs to persist one firing. */
export interface SubscriptionEventInput {
  subscriptionId: string;
  projectId: string;
  at?: Date;
  payload: Record<string, unknown>;
}

/** Bookkeeping a delivery attempt writes back onto the subscription. */
export interface SubscriptionDeliveryOutcome {
  /** Set when the firing was delivered (or had nothing to deliver to). */
  firedAt?: Date;
  /** Bounded, redacted failure text; `null` clears a previous error. */
  lastError?: string | null;
  /** Consecutive failure count to store. */
  failures?: number;
}

/** Options for reading a subscription's recent firings. */
export interface SubscriptionEventQueryOptions {
  /** Newest-first cap; clamped to {@link MAX_SUBSCRIPTION_EVENTS}. */
  limit?: number;
}

/** Longest `last_error` text a store keeps. Enough to name the cause, not a log. */
export const SUBSCRIPTION_ERROR_MAX_LENGTH = 300;

/**
 * Bound and flatten an error string before it is stored.
 *
 * Delivery errors quote a remote response, which is attacker-influenced text
 * from the collector's point of view: it is truncated so it cannot grow the row
 * without limit, and newlines are collapsed so a multi-line body cannot forge
 * structure in a log line or a dashboard cell.
 */
export function clampSubscriptionError(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > SUBSCRIPTION_ERROR_MAX_LENGTH
    ? `${flat.slice(0, SUBSCRIPTION_ERROR_MAX_LENGTH - 1)}…`
    : flat;
}

/** The JSON-encoded half of a subscription row (everything but the scalars). */
interface StoredConfig {
  filters?: SubscriptionFilters;
  evaluate: SubscriptionEvaluate;
  predicate: SubscriptionPredicate;
  cooldown?: string;
  delivery: SubscriptionDelivery[];
}

/**
 * Split a validated declaration into the columns a store writes.
 *
 * The webhook secret is lifted **out** of the JSON config and returned
 * separately, so the config column — which every read path selects — can never
 * contain it, whatever a future read path does.
 */
export function toSubscriptionColumns(sub: Subscription): {
  name: string;
  metric: string;
  config: string;
  webhookSecret: string | null;
  enabled: boolean;
} {
  let webhookSecret: string | null = null;
  const delivery = sub.delivery.map((target) => {
    if (target.kind !== "webhook") return target;
    if (target.secret != null) webhookSecret = target.secret;
    const { secret: _secret, ...rest } = target;
    return rest as SubscriptionDelivery;
  });
  const config: StoredConfig = {
    filters: sub.filters,
    evaluate: sub.evaluate,
    predicate: sub.predicate,
    cooldown: sub.cooldown ?? DEFAULT_COOLDOWN,
    delivery,
  };
  return {
    name: sub.name,
    metric: sub.metric,
    config: JSON.stringify(config),
    webhookSecret,
    enabled: sub.enabled ?? true,
  };
}

/** The scalar half of a stored subscription row, engine-normalised. */
export interface SubscriptionRowLike {
  id: string;
  project_id: string;
  name: string;
  metric: string;
  config: string;
  enabled: boolean | number;
  created_at_ms: number;
  updated_at_ms: number;
  last_fired_at_ms: number | null;
  last_error: string | null;
  failures: number;
}

/**
 * Map a stored row back to a {@link SubscriptionRecord}.
 *
 * Re-masks every webhook target on the way out: the secret is not in the config
 * column, but a subscription written by an older build — or by hand — might
 * carry one, and a read path must never be the thing that leaks it.
 */
export function rowToSubscription(row: SubscriptionRowLike): SubscriptionRecord {
  const config = JSON.parse(row.config) as StoredConfig;
  const delivery = (config.delivery ?? []).map((target) =>
    target.kind === "webhook" ? { ...target, secret: MASKED_SECRET } : target,
  );
  return {
    id: row.id,
    projectId: row.project_id,
    name: row.name,
    metric: row.metric,
    filters: config.filters ?? {},
    evaluate: config.evaluate,
    predicate: config.predicate,
    cooldown: config.cooldown ?? DEFAULT_COOLDOWN,
    delivery,
    enabled: row.enabled === true || row.enabled === 1,
    createdAt: new Date(Number(row.created_at_ms)),
    updatedAt: new Date(Number(row.updated_at_ms)),
    lastFiredAt: row.last_fired_at_ms == null ? null : new Date(Number(row.last_fired_at_ms)),
    lastError: row.last_error == null || row.last_error === "" ? null : row.last_error,
    failures: Number(row.failures ?? 0),
  };
}

/** The scalar half of a stored firing row, engine-normalised. */
export interface SubscriptionEventRowLike {
  id: string;
  subscription_id: string;
  project_id: string;
  at_ms: number;
  payload: string;
}

/** Map a stored firing row back to a {@link SubscriptionEventRecord}. */
export function rowToSubscriptionEvent(row: SubscriptionEventRowLike): SubscriptionEventRecord {
  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(row.payload) as Record<string, unknown>;
  } catch {
    // A row written by a future/rolled-back build must not break the listing.
    payload = {};
  }
  return {
    id: row.id,
    subscriptionId: row.subscription_id,
    projectId: row.project_id,
    at: new Date(Number(row.at_ms)),
    payload,
  };
}

/**
 * The subscription half of the store contract, factored out so the four engine
 * packages and the collector's `CollectorStore` cannot drift.
 */
export interface SubscriptionStore {
  /** A project's subscriptions, oldest first (stable for diffs and listings). */
  listSubscriptions(projectId: string): Promise<SubscriptionRecord[]>;
  /**
   * Every **enabled** subscription across every project, capped at
   * {@link MAX_ENABLED_SUBSCRIPTIONS}.
   *
   * The scheduler's resume path: after a restart it has no list of projects to
   * ask about, so it asks the store for the work instead. Deliberately not
   * project-scoped and deliberately capped — an operator who has somehow got
   * more standing subscriptions than the cap has a configuration problem, and
   * the collector should keep the ones it can rather than schedule unbounded
   * work.
   */
  listEnabledSubscriptions(limit?: number): Promise<SubscriptionRecord[]>;
  /** One subscription, or `null` when it does not exist in this project. */
  getSubscription(projectId: string, id: string): Promise<SubscriptionRecord | null>;
  /**
   * Store a new subscription and return it. Rejects with an `Error` when the
   * project is already at {@link MAX_SUBSCRIPTIONS_PER_PROJECT}.
   */
  createSubscription(projectId: string, sub: Subscription): Promise<SubscriptionRecord>;
  /** Enable/disable. Returns the updated record, or `null` when unknown. */
  setSubscriptionEnabled(
    projectId: string,
    id: string,
    enabled: boolean,
  ): Promise<SubscriptionRecord | null>;
  /** Delete a subscription and its firings. `false` when it did not exist. */
  deleteSubscription(projectId: string, id: string): Promise<boolean>;
  /** Write back a delivery attempt's bookkeeping. Never throws on unknown ids. */
  recordSubscriptionOutcome(
    projectId: string,
    id: string,
    outcome: SubscriptionDeliveryOutcome,
  ): Promise<void>;
  /**
   * The webhook signing secret, or `null`. The **only** read path that returns
   * it; called by the delivery module and by nothing else.
   */
  getWebhookSecret(projectId: string, id: string): Promise<string | null>;
  /**
   * Append one firing, dropping the oldest beyond
   * {@link MAX_SUBSCRIPTION_EVENTS} for that subscription.
   */
  recordSubscriptionEvent(entry: SubscriptionEventInput): Promise<void>;
  /** A subscription's recent firings, newest first. */
  listSubscriptionEvents(
    projectId: string,
    id: string,
    opts?: SubscriptionEventQueryOptions,
  ): Promise<SubscriptionEventRecord[]>;
}

/** Clamp a caller-supplied firing-list limit into the retained range. */
export function clampEventLimit(limit: number | undefined): number {
  const n = Math.trunc(limit ?? MAX_SUBSCRIPTION_EVENTS);
  if (!Number.isFinite(n) || n < 1) return 1;
  return Math.min(n, MAX_SUBSCRIPTION_EVENTS);
}

/** The error a store throws when a project is already at its subscription cap. */
export class SubscriptionLimitError extends Error {
  constructor(readonly limit: number = MAX_SUBSCRIPTIONS_PER_PROJECT) {
    super(`project already holds the maximum of ${limit} subscriptions`);
    this.name = "SubscriptionLimitError";
  }
}
