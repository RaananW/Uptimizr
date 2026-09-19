import { randomUUID } from "node:crypto";
import type { Subscription } from "@uptimizr/schema";
import {
  MAX_ENABLED_SUBSCRIPTIONS,
  MAX_SUBSCRIPTIONS_PER_PROJECT,
  MAX_SUBSCRIPTION_EVENTS,
  SubscriptionLimitError,
  clampEventLimit,
  clampSubscriptionError,
  rowToSubscription,
  rowToSubscriptionEvent,
  toClickhouseTimestamp,
  toSubscriptionColumns,
  type SubscriptionDeliveryOutcome,
  type SubscriptionEventInput,
  type SubscriptionEventQueryOptions,
  type SubscriptionEventRecord,
  type SubscriptionEventRowLike,
  type SubscriptionRecord,
  type SubscriptionRowLike,
} from "@uptimizr/db";
import type { ClickhouseClient } from "./client.js";

/**
 * **Conditional subscriptions** for the single-tenant ClickHouse store (#311,
 * ADR 0051 §6 / sketch §F.1–F.2).
 *
 * Same two tables as the row stores, expressed the way ClickHouse does mutable
 * metadata (the `scene_regions` precedent):
 *
 * - `subscriptions` is a `ReplacingMergeTree(version)` keyed by
 *   `(project_id, id)`. Every write — create, enable/disable, delivery
 *   bookkeeping — inserts a **complete** replacement row with a higher
 *   `version`; a delete inserts a `deleted = 1` tombstone. Reads take `FINAL`
 *   and filter `deleted = 0`. There is no `UPDATE` here, so the accessors
 *   read-modify-write, and the row they write is the whole row.
 * - `subscription_events` is an append-only `MergeTree`. The firing log's
 *   retention is enforced differently here on purpose — see
 *   {@link recordSubscriptionEvent}.
 *
 * `webhook_secret` is never selected by {@link SELECT_COLS}: the secret rides
 * along in the replacement row (read back by {@link getWebhookSecret}) so an
 * enable/disable never silently drops it, but no read path returns it.
 */

const SELECT_COLS = `id, project_id, name, metric, config, enabled,
       toUnixTimestamp64Milli(created_at) AS created_at_ms,
       toUnixTimestamp64Milli(updated_at) AS updated_at_ms,
       if(last_fired_at_ms = 0, NULL, last_fired_at_ms) AS last_fired_at_ms,
       last_error, failures`;

const EVENT_COLS = `id, subscription_id, project_id,
       toUnixTimestamp64Milli(at) AS at_ms, payload`;

/**
 * Strictly-increasing `ReplacingMergeTree` version. Epoch-ms alone is not
 * enough: two writes to the same subscription inside one millisecond would tie,
 * and `FINAL` would pick between them arbitrarily — so a disable could be
 * resurrected by the delivery bookkeeping that raced it. Identical to the
 * counter in `sceneRegions.ts`.
 */
let lastVersion = 0;
function nextVersion(): number {
  const now = Date.now();
  lastVersion = now > lastVersion ? now : lastVersion + 1;
  return lastVersion;
}

/** The full row written on every create/update, including the secret column. */
interface FullRow {
  id: string;
  project_id: string;
  name: string;
  metric: string;
  config: string;
  webhook_secret: string | null;
  enabled: number;
  created_at: string;
  updated_at: string;
  last_fired_at_ms: number;
  last_error: string;
  failures: number;
  deleted: number;
  version: number;
}

/** Read the full row (secret included) so a replacement can carry it forward. */
async function readFull(
  client: ClickhouseClient,
  projectId: string,
  id: string,
): Promise<FullRow | null> {
  const rows = await client.query<FullRow>(
    `SELECT id, project_id, name, metric, config, webhook_secret, enabled,
            toUnixTimestamp64Milli(created_at) AS created_at,
            toUnixTimestamp64Milli(updated_at) AS updated_at,
            last_fired_at_ms, last_error, failures, deleted, version
       FROM subscriptions FINAL
      WHERE project_id = {projectId:String} AND id = {id:String} AND deleted = 0`,
    { projectId, id },
  );
  const row = rows[0];
  if (row == null) return null;
  return {
    ...row,
    created_at: toClickhouseTimestamp(Number(row.created_at)),
    updated_at: toClickhouseTimestamp(Number(row.updated_at)),
  };
}

/** A project's subscriptions, oldest first. */
export async function listSubscriptions(
  client: ClickhouseClient,
  projectId: string,
): Promise<SubscriptionRecord[]> {
  const rows = await client.query<SubscriptionRowLike>(
    `SELECT ${SELECT_COLS} FROM subscriptions FINAL
      WHERE project_id = {projectId:String} AND deleted = 0
      ORDER BY created_at, id`,
    { projectId },
  );
  return rows.map(rowToSubscription);
}

/** Every enabled subscription across every project — the scheduler's resume read. */
export async function listEnabledSubscriptions(
  client: ClickhouseClient,
  limit: number = MAX_ENABLED_SUBSCRIPTIONS,
): Promise<SubscriptionRecord[]> {
  const capped = Math.min(Math.max(Math.trunc(limit), 1), MAX_ENABLED_SUBSCRIPTIONS);
  const rows = await client.query<SubscriptionRowLike>(
    `SELECT ${SELECT_COLS} FROM subscriptions FINAL
      WHERE deleted = 0 AND enabled = 1
      ORDER BY created_at, id
      LIMIT ${capped}`,
  );
  return rows.map(rowToSubscription);
}

/** One subscription, or `null` when it does not exist in this project. */
export async function getSubscription(
  client: ClickhouseClient,
  projectId: string,
  id: string,
): Promise<SubscriptionRecord | null> {
  const rows = await client.query<SubscriptionRowLike>(
    `SELECT ${SELECT_COLS} FROM subscriptions FINAL
      WHERE project_id = {projectId:String} AND id = {id:String} AND deleted = 0`,
    { projectId, id },
  );
  const row = rows[0];
  return row == null ? null : rowToSubscription(row);
}

/**
 * Store a new subscription.
 *
 * ClickHouse has no transaction to hold the cap check and the insert together,
 * so this is a read-then-insert. A pair of exactly simultaneous creates could
 * therefore land at `MAX + 1`; that is an over-count of one on a bound whose
 * purpose is to keep evaluation work finite, not an invariant a correctness
 * argument rests on. The row stores take a lock precisely because they can.
 */
export async function createSubscription(
  client: ClickhouseClient,
  projectId: string,
  sub: Subscription,
): Promise<SubscriptionRecord> {
  const counted = await client.query<{ n: string | number }>(
    `SELECT count() AS n FROM subscriptions FINAL
      WHERE project_id = {projectId:String} AND deleted = 0`,
    { projectId },
  );
  if (Number(counted[0]?.n ?? 0) >= MAX_SUBSCRIPTIONS_PER_PROJECT) {
    throw new SubscriptionLimitError();
  }

  const id = `sub_${randomUUID().replace(/-/g, "").slice(0, 24)}`;
  const cols = toSubscriptionColumns(sub);
  const stamp = toClickhouseTimestamp(Date.now());
  await client.insert("subscriptions", [
    {
      id,
      project_id: projectId,
      name: cols.name,
      metric: cols.metric,
      config: cols.config,
      webhook_secret: cols.webhookSecret,
      enabled: cols.enabled ? 1 : 0,
      created_at: stamp,
      updated_at: stamp,
      last_fired_at_ms: 0,
      last_error: "",
      failures: 0,
      deleted: 0,
      version: nextVersion(),
    } satisfies FullRow,
  ]);
  const stored = await getSubscription(client, projectId, id);
  if (stored == null) throw new Error(`subscription ${id} vanished after insert`);
  return stored;
}

/** Insert a complete replacement row carrying `patch` over the current one. */
async function replace(
  client: ClickhouseClient,
  projectId: string,
  id: string,
  patch: Partial<FullRow>,
): Promise<SubscriptionRecord | null> {
  const current = await readFull(client, projectId, id);
  if (current == null) return null;
  await client.insert("subscriptions", [
    {
      ...current,
      ...patch,
      updated_at: toClickhouseTimestamp(Date.now()),
      version: nextVersion(),
    },
  ]);
  return getSubscription(client, projectId, id);
}

/** Enable or disable one subscription. `null` when it does not exist. */
export async function setSubscriptionEnabled(
  client: ClickhouseClient,
  projectId: string,
  id: string,
  enabled: boolean,
): Promise<SubscriptionRecord | null> {
  return replace(client, projectId, id, { enabled: enabled ? 1 : 0 });
}

/**
 * Delete a subscription and its firings.
 *
 * The subscription becomes a tombstone (`deleted = 1`, higher `version`); the
 * firings are removed with a lightweight `DELETE`, the same primitive the audit
 * retention sweep uses here.
 */
export async function deleteSubscription(
  client: ClickhouseClient,
  projectId: string,
  id: string,
): Promise<boolean> {
  const current = await readFull(client, projectId, id);
  if (current == null) return false;
  await client.insert("subscriptions", [
    {
      ...current,
      webhook_secret: null,
      config: "{}",
      deleted: 1,
      updated_at: toClickhouseTimestamp(Date.now()),
      version: nextVersion(),
    },
  ]);
  await client.command(
    `DELETE FROM subscription_events WHERE subscription_id = '${id.replace(/'/g, "''")}'`,
  );
  return true;
}

/** Write back what a delivery attempt learned. */
export async function recordSubscriptionOutcome(
  client: ClickhouseClient,
  projectId: string,
  id: string,
  outcome: SubscriptionDeliveryOutcome,
): Promise<void> {
  const patch: Partial<FullRow> = {};
  if (outcome.firedAt != null) patch.last_fired_at_ms = outcome.firedAt.getTime();
  if (outcome.lastError !== undefined) {
    patch.last_error = outcome.lastError == null ? "" : clampSubscriptionError(outcome.lastError);
  }
  if (outcome.failures !== undefined) patch.failures = Math.max(0, Math.trunc(outcome.failures));
  await replace(client, projectId, id, patch);
}

/** The webhook signing secret, or `null`. The only path that reads the column. */
export async function getWebhookSecret(
  client: ClickhouseClient,
  projectId: string,
  id: string,
): Promise<string | null> {
  const rows = await client.query<{ webhook_secret: string | null }>(
    `SELECT webhook_secret FROM subscriptions FINAL
      WHERE project_id = {projectId:String} AND id = {id:String} AND deleted = 0`,
    { projectId, id },
  );
  const secret = rows[0]?.webhook_secret;
  return secret == null || secret === "" ? null : secret;
}

/**
 * How far the firing log is allowed to overshoot its bound before it is trimmed.
 *
 * DuckDB, Postgres and SQL Server trim inside the insert's own transaction,
 * which costs nothing there. ClickHouse's delete is a mutation, and running one
 * per firing would turn a cheap append into a rewrite of the part. So the log is
 * trimmed only when it has grown to this multiple of the bound, and reads are
 * capped by `LIMIT` regardless — the retained window a caller can observe is
 * identical on all four engines; only the physical row count differs, and only
 * transiently.
 */
const TRIM_OVERSHOOT = 3;

/** Append one firing, trimming the log when it has overshot its bound. */
export async function recordSubscriptionEvent(
  client: ClickhouseClient,
  entry: SubscriptionEventInput,
): Promise<void> {
  const at = entry.at ?? new Date();
  await client.insert("subscription_events", [
    {
      id: randomUUID(),
      subscription_id: entry.subscriptionId,
      project_id: entry.projectId,
      at: toClickhouseTimestamp(at.getTime()),
      payload: JSON.stringify(entry.payload),
    },
  ]);

  const counted = await client.query<{ n: string | number }>(
    `SELECT count() AS n FROM subscription_events
      WHERE subscription_id = {subscriptionId:String}`,
    { subscriptionId: entry.subscriptionId },
  );
  if (Number(counted[0]?.n ?? 0) <= MAX_SUBSCRIPTION_EVENTS * TRIM_OVERSHOOT) return;

  const cutoff = await client.query<{ at_ms: string | number }>(
    `SELECT toUnixTimestamp64Milli(at) AS at_ms FROM subscription_events
      WHERE subscription_id = {subscriptionId:String}
      ORDER BY at DESC, id DESC
      LIMIT 1 OFFSET {keep:UInt32}`,
    { subscriptionId: entry.subscriptionId, keep: MAX_SUBSCRIPTION_EVENTS - 1 },
  );
  const cutoffMs = Number(cutoff[0]?.at_ms ?? 0);
  if (cutoffMs <= 0) return;
  await client.command(
    `DELETE FROM subscription_events
      WHERE subscription_id = '${entry.subscriptionId.replace(/'/g, "''")}'
        AND toUnixTimestamp64Milli(at) < ${Math.trunc(cutoffMs)}`,
  );
}

/** A subscription's recent firings, newest first. */
export async function listSubscriptionEvents(
  client: ClickhouseClient,
  projectId: string,
  id: string,
  opts: SubscriptionEventQueryOptions = {},
): Promise<SubscriptionEventRecord[]> {
  const limit = clampEventLimit(opts.limit);
  const rows = await client.query<SubscriptionEventRowLike>(
    `SELECT ${EVENT_COLS} FROM subscription_events
      WHERE project_id = {projectId:String} AND subscription_id = {id:String}
      ORDER BY at DESC, id DESC
      LIMIT ${limit}`,
    { projectId, id },
  );
  return rows.map(rowToSubscriptionEvent);
}
