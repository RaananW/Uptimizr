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
  toSubscriptionColumns,
  type SubscriptionDeliveryOutcome,
  type SubscriptionEventInput,
  type SubscriptionEventQueryOptions,
  type SubscriptionEventRecord,
  type SubscriptionEventRowLike,
  type SubscriptionRecord,
  type SubscriptionRowLike,
} from "../subscriptions.js";
import type { DuckdbClient } from "./client.js";

/**
 * **Conditional subscriptions** for the DuckDB single-file store (ADR 0051 §6 /
 * sketch §F.1–F.2).
 *
 * Two tables, both plain metadata — no event type is added and
 * `@uptimizr/schema`'s event union is untouched:
 *
 * - `subscriptions` — one row per standing question, keyed by `id` and scoped to
 *   a project. The declaration itself lives in a JSON `config` column; the
 *   scalars beside it are exactly what the store must filter, order or update.
 * - `subscription_events` — the bounded firing log, last
 *   {@link MAX_SUBSCRIPTION_EVENTS} per subscription. The trim runs inside the
 *   same transaction as the insert, so the bound holds even if the collector
 *   dies between the two.
 *
 * `at` is a DuckDB keyword, so it is double-quoted here and in the migration —
 * the column name matches the other three engines, where it needs no quoting.
 */

const SELECT_COLS = `id, project_id, name, metric, config, enabled,
       epoch_ms(created_at) AS created_at_ms,
       epoch_ms(updated_at) AS updated_at_ms,
       epoch_ms(last_fired_at) AS last_fired_at_ms,
       last_error, failures`;

const EVENT_COLS = `id, subscription_id, project_id, epoch_ms("at") AS at_ms, payload`;

/** A project's subscriptions, oldest first. */
export async function listSubscriptions(
  client: DuckdbClient,
  projectId: string,
): Promise<SubscriptionRecord[]> {
  const rows = await client.all<SubscriptionRowLike>(
    `SELECT ${SELECT_COLS} FROM subscriptions
      WHERE project_id = $projectId
      ORDER BY created_at, id`,
    { projectId },
  );
  return rows.map(rowToSubscription);
}

/** Every enabled subscription across every project — the scheduler's resume read. */
export async function listEnabledSubscriptions(
  client: DuckdbClient,
  limit: number = MAX_ENABLED_SUBSCRIPTIONS,
): Promise<SubscriptionRecord[]> {
  const capped = Math.min(Math.max(Math.trunc(limit), 1), MAX_ENABLED_SUBSCRIPTIONS);
  const rows = await client.all<SubscriptionRowLike>(
    `SELECT ${SELECT_COLS} FROM subscriptions
      WHERE enabled
      ORDER BY created_at, id
      LIMIT ${capped}`,
  );
  return rows.map(rowToSubscription);
}

/** One subscription, or `null` when it does not exist in this project. */
export async function getSubscription(
  client: DuckdbClient,
  projectId: string,
  id: string,
): Promise<SubscriptionRecord | null> {
  const rows = await client.all<SubscriptionRowLike>(
    `SELECT ${SELECT_COLS} FROM subscriptions
      WHERE project_id = $projectId AND id = $id`,
    { projectId, id },
  );
  const row = rows[0];
  return row == null ? null : rowToSubscription(row);
}

/**
 * Store a new subscription.
 *
 * The per-project cap is checked and the row inserted inside one transaction on
 * the exclusive connection, so two concurrent creates cannot both read
 * `count = 99` and both insert.
 */
export async function createSubscription(
  client: DuckdbClient,
  projectId: string,
  sub: Subscription,
): Promise<SubscriptionRecord> {
  const id = `sub_${randomUUID().replace(/-/g, "").slice(0, 24)}`;
  const cols = toSubscriptionColumns(sub);
  await client.exclusive(async (con) => {
    await con.run("BEGIN TRANSACTION");
    try {
      const reader = await con.runAndReadAll(
        `SELECT count(*) AS n FROM subscriptions WHERE project_id = $projectId`,
        { projectId } as unknown as Record<string, never>,
      );
      const counted = reader.getRowObjects()[0]?.n;
      if (Number(counted ?? 0) >= MAX_SUBSCRIPTIONS_PER_PROJECT) {
        throw new SubscriptionLimitError();
      }
      await con.run(
        `INSERT INTO subscriptions
           (id, project_id, name, metric, config, webhook_secret, enabled,
            created_at, updated_at, last_fired_at, last_error, failures)
         VALUES ($id, $projectId, $name, $metric, $config, $webhookSecret, $enabled,
                 now(), now(), NULL, NULL, 0)`,
        {
          id,
          projectId,
          name: cols.name,
          metric: cols.metric,
          config: cols.config,
          webhookSecret: cols.webhookSecret,
          enabled: cols.enabled,
        },
      );
      await con.run("COMMIT");
    } catch (err) {
      await con.run("ROLLBACK");
      throw err;
    }
  });
  const stored = await getSubscription(client, projectId, id);
  // The row was just inserted in a committed transaction; a null here would mean
  // the store lost it, which is a fault, not an empty result.
  if (stored == null) throw new Error(`subscription ${id} vanished after insert`);
  return stored;
}

/** Enable or disable one subscription. `null` when it does not exist. */
export async function setSubscriptionEnabled(
  client: DuckdbClient,
  projectId: string,
  id: string,
  enabled: boolean,
): Promise<SubscriptionRecord | null> {
  await client.run(
    `UPDATE subscriptions SET enabled = $enabled, updated_at = now()
      WHERE project_id = $projectId AND id = $id`,
    { projectId, id, enabled },
  );
  return getSubscription(client, projectId, id);
}

/** Delete a subscription and its firings. `false` when it did not exist. */
export async function deleteSubscription(
  client: DuckdbClient,
  projectId: string,
  id: string,
): Promise<boolean> {
  const existing = await getSubscription(client, projectId, id);
  if (existing == null) return false;
  await client.exclusive(async (con) => {
    await con.run("BEGIN TRANSACTION");
    try {
      await con.run(
        `DELETE FROM subscription_events WHERE project_id = $projectId AND subscription_id = $id`,
        { projectId, id },
      );
      await con.run(`DELETE FROM subscriptions WHERE project_id = $projectId AND id = $id`, {
        projectId,
        id,
      });
      await con.run("COMMIT");
    } catch (err) {
      await con.run("ROLLBACK");
      throw err;
    }
  });
  return true;
}

/**
 * Write back what a delivery attempt learned. Each field is optional, so a
 * successful delivery (`firedAt`, `failures: 0`, `lastError: null`) and a failed
 * one (`lastError`, `failures: n`) use the same call.
 */
export async function recordSubscriptionOutcome(
  client: DuckdbClient,
  projectId: string,
  id: string,
  outcome: SubscriptionDeliveryOutcome,
): Promise<void> {
  const sets: string[] = ["updated_at = now()"];
  const params: Record<string, unknown> = { projectId, id };
  if (outcome.firedAt != null) {
    sets.push("last_fired_at = make_timestamp($firedAtUs)");
    params.firedAtUs = outcome.firedAt.getTime() * 1000;
  }
  if (outcome.lastError !== undefined) {
    sets.push("last_error = $lastError");
    params.lastError = outcome.lastError == null ? null : clampSubscriptionError(outcome.lastError);
  }
  if (outcome.failures !== undefined) {
    sets.push("failures = CAST($failures AS BIGINT)");
    params.failures = Math.max(0, Math.trunc(outcome.failures));
  }
  await client.run(
    `UPDATE subscriptions SET ${sets.join(", ")}
      WHERE project_id = $projectId AND id = $id`,
    params,
  );
}

/**
 * The webhook signing secret for one subscription, or `null`.
 *
 * The only path that reads the column. Everything else — the list, the get, the
 * API responses — selects {@link SELECT_COLS}, which deliberately omits it.
 */
export async function getWebhookSecret(
  client: DuckdbClient,
  projectId: string,
  id: string,
): Promise<string | null> {
  const rows = await client.all<{ webhook_secret: string | null }>(
    `SELECT webhook_secret FROM subscriptions WHERE project_id = $projectId AND id = $id`,
    { projectId, id },
  );
  const secret = rows[0]?.webhook_secret;
  return secret == null || secret === "" ? null : secret;
}

/**
 * Append one firing and drop everything past the retained window.
 *
 * The trim is a `DELETE … WHERE "at" < (the Nth newest)` rather than a row-number
 * window, because DuckDB will not delete from a CTE over the same table. Both
 * statements run in one transaction, so the bound is never observed broken.
 */
export async function recordSubscriptionEvent(
  client: DuckdbClient,
  entry: SubscriptionEventInput,
): Promise<void> {
  const at = entry.at ?? new Date();
  await client.exclusive(async (con) => {
    await con.run("BEGIN TRANSACTION");
    try {
      await con.run(
        `INSERT INTO subscription_events (id, subscription_id, project_id, "at", payload)
         VALUES ($id, $subscriptionId, $projectId, make_timestamp($atUs), $payload)`,
        {
          id: randomUUID(),
          subscriptionId: entry.subscriptionId,
          projectId: entry.projectId,
          atUs: at.getTime() * 1000,
          payload: JSON.stringify(entry.payload),
        },
      );
      await con.run(
        `DELETE FROM subscription_events
          WHERE subscription_id = $subscriptionId
            AND id NOT IN (
              SELECT id FROM subscription_events
               WHERE subscription_id = $subscriptionId
               ORDER BY "at" DESC, id DESC
               LIMIT ${MAX_SUBSCRIPTION_EVENTS}
            )`,
        { subscriptionId: entry.subscriptionId },
      );
      await con.run("COMMIT");
    } catch (err) {
      await con.run("ROLLBACK");
      throw err;
    }
  });
}

/** A subscription's recent firings, newest first. */
export async function listSubscriptionEvents(
  client: DuckdbClient,
  projectId: string,
  id: string,
  opts: SubscriptionEventQueryOptions = {},
): Promise<SubscriptionEventRecord[]> {
  const limit = clampEventLimit(opts.limit);
  const rows = await client.all<SubscriptionEventRowLike>(
    `SELECT ${EVENT_COLS} FROM subscription_events
      WHERE project_id = $projectId AND subscription_id = $id
      ORDER BY "at" DESC, id DESC
      LIMIT ${limit}`,
    { projectId, id },
  );
  return rows.map(rowToSubscriptionEvent);
}
