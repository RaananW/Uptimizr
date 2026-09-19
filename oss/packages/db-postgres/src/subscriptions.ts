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
} from "@uptimizr/db";
import type { PostgresClient, PostgresExecutor } from "./client.js";

/**
 * **Conditional subscriptions** for the single-tenant Postgres store (#311,
 * ADR 0051 §6 / sketch §F.1–F.2).
 *
 * Mirrors the DuckDB accessors column-for-column: one `subscriptions` row per
 * standing question with the declaration in a JSON `config` column, and a
 * bounded `subscription_events` firing log (last
 * {@link MAX_SUBSCRIPTION_EVENTS} per subscription).
 *
 * Two places where Postgres does it better than DuckDB can, and the difference
 * is deliberate rather than accidental:
 *
 * - the create's cap check takes `FOR UPDATE` on the project's existing rows, so
 *   two collector instances sharing one database cannot both slip past the cap;
 * - the firing-log trim is a single `DELETE … USING` against a row-numbered
 *   subquery rather than DuckDB's two-step `NOT IN`.
 *
 * `webhook_secret` is never selected by {@link SELECT_COLS} — see the module
 * note in `@uptimizr/db`'s `subscriptions.ts`.
 */

/** `timestamp` → epoch milliseconds, the unit every record mapper takes. */
const MS = (col: string): string => `(EXTRACT(EPOCH FROM ${col}) * 1000)::bigint`;

const SELECT_COLS = `id, project_id, name, metric, config, enabled,
       ${MS("created_at")} AS created_at_ms,
       ${MS("updated_at")} AS updated_at_ms,
       CASE WHEN last_fired_at IS NULL THEN NULL ELSE ${MS("last_fired_at")} END AS last_fired_at_ms,
       last_error, failures`;

const EVENT_COLS = `id, subscription_id, project_id, ${MS("at")} AS at_ms, payload`;

/** The row shape Postgres returns before {@link rowToSubscription} normalises it. */
type PgSubscriptionRow = Omit<
  SubscriptionRowLike,
  "created_at_ms" | "updated_at_ms" | "last_fired_at_ms" | "failures"
> & {
  created_at_ms: number | string;
  updated_at_ms: number | string;
  last_fired_at_ms: number | string | null;
  failures: number | string;
};

function toRecord(row: PgSubscriptionRow): SubscriptionRecord {
  return rowToSubscription({
    ...row,
    created_at_ms: Number(row.created_at_ms),
    updated_at_ms: Number(row.updated_at_ms),
    last_fired_at_ms: row.last_fired_at_ms == null ? null : Number(row.last_fired_at_ms),
    failures: Number(row.failures),
  });
}

/** A project's subscriptions, oldest first. */
export async function listSubscriptions(
  client: PostgresClient,
  projectId: string,
): Promise<SubscriptionRecord[]> {
  const rows = await client.query<PgSubscriptionRow>(
    `SELECT ${SELECT_COLS} FROM subscriptions
      WHERE project_id = $1
      ORDER BY created_at, id`,
    [projectId],
  );
  return rows.map(toRecord);
}

/** Every enabled subscription across every project — the scheduler's resume read. */
export async function listEnabledSubscriptions(
  client: PostgresClient,
  limit: number = MAX_ENABLED_SUBSCRIPTIONS,
): Promise<SubscriptionRecord[]> {
  const capped = Math.min(Math.max(Math.trunc(limit), 1), MAX_ENABLED_SUBSCRIPTIONS);
  const rows = await client.query<PgSubscriptionRow>(
    `SELECT ${SELECT_COLS} FROM subscriptions
      WHERE enabled
      ORDER BY created_at, id
      LIMIT $1`,
    [capped],
  );
  return rows.map(toRecord);
}

/** One subscription, or `null` when it does not exist in this project. */
export async function getSubscription(
  client: PostgresClient | PostgresExecutor,
  projectId: string,
  id: string,
): Promise<SubscriptionRecord | null> {
  const rows = await client.query<PgSubscriptionRow>(
    `SELECT ${SELECT_COLS} FROM subscriptions WHERE project_id = $1 AND id = $2`,
    [projectId, id],
  );
  const row = rows[0];
  return row == null ? null : toRecord(row);
}

/** Store a new subscription, enforcing the per-project cap under a row lock. */
export async function createSubscription(
  client: PostgresClient,
  projectId: string,
  sub: Subscription,
): Promise<SubscriptionRecord> {
  const id = `sub_${randomUUID().replace(/-/g, "").slice(0, 24)}`;
  const cols = toSubscriptionColumns(sub);
  return client.transaction(async (tx) => {
    // `FOR UPDATE` on the project's existing rows serialises concurrent creates:
    // the second transaction blocks until the first commits, then counts it.
    const existing = await tx.query<{ id: string }>(
      `SELECT id FROM subscriptions WHERE project_id = $1 FOR UPDATE`,
      [projectId],
    );
    if (existing.length >= MAX_SUBSCRIPTIONS_PER_PROJECT) throw new SubscriptionLimitError();
    await tx.query(
      `INSERT INTO subscriptions
         (id, project_id, name, metric, config, webhook_secret, enabled,
          created_at, updated_at, failures)
       VALUES ($1, $2, $3, $4, $5, $6, $7,
               (now() AT TIME ZONE 'utc'), (now() AT TIME ZONE 'utc'), 0)`,
      [id, projectId, cols.name, cols.metric, cols.config, cols.webhookSecret, cols.enabled],
    );
    const stored = await getSubscription(tx, projectId, id);
    if (stored == null) throw new Error(`subscription ${id} vanished after insert`);
    return stored;
  });
}

/** Enable or disable one subscription. `null` when it does not exist. */
export async function setSubscriptionEnabled(
  client: PostgresClient,
  projectId: string,
  id: string,
  enabled: boolean,
): Promise<SubscriptionRecord | null> {
  await client.query(
    `UPDATE subscriptions SET enabled = $3, updated_at = (now() AT TIME ZONE 'utc')
      WHERE project_id = $1 AND id = $2`,
    [projectId, id, enabled],
  );
  return getSubscription(client, projectId, id);
}

/** Delete a subscription and its firings. `false` when it did not exist. */
export async function deleteSubscription(
  client: PostgresClient,
  projectId: string,
  id: string,
): Promise<boolean> {
  return client.transaction(async (tx) => {
    await tx.query(
      `DELETE FROM subscription_events WHERE project_id = $1 AND subscription_id = $2`,
      [projectId, id],
    );
    const deleted = await tx.query<{ id: string }>(
      `DELETE FROM subscriptions WHERE project_id = $1 AND id = $2 RETURNING id`,
      [projectId, id],
    );
    return deleted.length > 0;
  });
}

/** Write back what a delivery attempt learned. */
export async function recordSubscriptionOutcome(
  client: PostgresClient,
  projectId: string,
  id: string,
  outcome: SubscriptionDeliveryOutcome,
): Promise<void> {
  const sets = [`updated_at = (now() AT TIME ZONE 'utc')`];
  const params: unknown[] = [projectId, id];
  if (outcome.firedAt != null) {
    params.push(outcome.firedAt.getTime());
    sets.push(`last_fired_at = to_timestamp($${params.length}::double precision / 1000)
                 AT TIME ZONE 'utc'`);
  }
  if (outcome.lastError !== undefined) {
    params.push(outcome.lastError == null ? null : clampSubscriptionError(outcome.lastError));
    sets.push(`last_error = $${params.length}`);
  }
  if (outcome.failures !== undefined) {
    params.push(Math.max(0, Math.trunc(outcome.failures)));
    sets.push(`failures = $${params.length}`);
  }
  await client.query(
    `UPDATE subscriptions SET ${sets.join(", ")} WHERE project_id = $1 AND id = $2`,
    params,
  );
}

/** The webhook signing secret, or `null`. The only path that reads the column. */
export async function getWebhookSecret(
  client: PostgresClient,
  projectId: string,
  id: string,
): Promise<string | null> {
  const rows = await client.query<{ webhook_secret: string | null }>(
    `SELECT webhook_secret FROM subscriptions WHERE project_id = $1 AND id = $2`,
    [projectId, id],
  );
  const secret = rows[0]?.webhook_secret;
  return secret == null || secret === "" ? null : secret;
}

/** Append one firing and drop everything past the retained window. */
export async function recordSubscriptionEvent(
  client: PostgresClient,
  entry: SubscriptionEventInput,
): Promise<void> {
  const at = entry.at ?? new Date();
  await client.transaction(async (tx) => {
    await tx.query(
      `INSERT INTO subscription_events (id, subscription_id, project_id, at, payload)
       VALUES ($1, $2, $3, to_timestamp($4::double precision / 1000) AT TIME ZONE 'utc', $5)`,
      [
        randomUUID(),
        entry.subscriptionId,
        entry.projectId,
        at.getTime(),
        JSON.stringify(entry.payload),
      ],
    );
    await tx.query(
      `DELETE FROM subscription_events e
        USING (
          SELECT id, row_number() OVER (ORDER BY at DESC, id DESC) AS rn
            FROM subscription_events
           WHERE subscription_id = $1
        ) ranked
        WHERE e.id = ranked.id AND ranked.rn > $2`,
      [entry.subscriptionId, MAX_SUBSCRIPTION_EVENTS],
    );
  });
}

/** A subscription's recent firings, newest first. */
export async function listSubscriptionEvents(
  client: PostgresClient,
  projectId: string,
  id: string,
  opts: SubscriptionEventQueryOptions = {},
): Promise<SubscriptionEventRecord[]> {
  const rows = await client.query<SubscriptionEventRowLike & { at_ms: number | string }>(
    `SELECT ${EVENT_COLS} FROM subscription_events
      WHERE project_id = $1 AND subscription_id = $2
      ORDER BY at DESC, id DESC
      LIMIT $3`,
    [projectId, id, clampEventLimit(opts.limit)],
  );
  return rows.map((row) => rowToSubscriptionEvent({ ...row, at_ms: Number(row.at_ms) }));
}
