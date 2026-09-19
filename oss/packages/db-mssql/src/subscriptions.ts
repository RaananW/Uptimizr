import { randomUUID } from "node:crypto";
import type { Subscription } from "@uptimizr/schema";
import {
  MAX_ENABLED_SUBSCRIPTIONS,
  MAX_SUBSCRIPTIONS_PER_PROJECT,
  MAX_SUBSCRIPTION_EVENTS,
  SubscriptionLimitError,
  clampEventLimit,
  clampSubscriptionError,
  mssqlDialect,
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
import type { MssqlClient, MssqlExecutor } from "./client.js";

/**
 * **Conditional subscriptions** for the single-tenant SQL Server store (#311,
 * ADR 0051 §6 / sketch §F.1–F.2).
 *
 * Mirrors the DuckDB and Postgres accessors column-for-column: one
 * `subscriptions` row per standing question with the declaration in a JSON
 * `config` column, and a bounded `subscription_events` firing log (last
 * {@link MAX_SUBSCRIPTION_EVENTS} per subscription).
 *
 * Two SQL Server specifics:
 *
 * - `enabled` is `bit`, which the driver surfaces as `true`/`false`; the shared
 *   row mapper already accepts either a boolean or a `0`/`1`.
 * - the create's cap check takes `WITH (UPDLOCK, HOLDLOCK)` — SQL Server's
 *   equivalent of Postgres' `FOR UPDATE` on a range — so two collector instances
 *   sharing one database cannot both slip past the cap.
 *
 * `webhook_secret` is never selected by {@link SELECT_COLS} — see the module
 * note in `@uptimizr/db`'s `subscriptions.ts`.
 */

const SELECT_COLS = `id, project_id, name, metric, config, enabled,
       ${mssqlDialect.epochMs("created_at")} AS created_at_ms,
       ${mssqlDialect.epochMs("updated_at")} AS updated_at_ms,
       CASE WHEN last_fired_at IS NULL THEN NULL
            ELSE ${mssqlDialect.epochMs("last_fired_at")} END AS last_fired_at_ms,
       last_error, failures`;

const EVENT_COLS = `id, subscription_id, project_id,
       ${mssqlDialect.epochMs("at")} AS at_ms, payload`;

/**
 * Epoch-ms → `datetime2(3)`. `DATEADD(millisecond, …)` overflows `int` for an
 * absolute epoch, so the value is split into whole seconds plus a millisecond
 * remainder — both well inside `int` — and added in two steps. Identical to the
 * helper in `audit.ts`.
 */
function epochToDatetime(param: string): string {
  return `DATEADD(millisecond, ${param} % 1000, DATEADD(second, ${param} / 1000, CAST(N'1970-01-01' AS datetime2(3))))`;
}

/** A project's subscriptions, oldest first. */
export async function listSubscriptions(
  client: MssqlClient,
  projectId: string,
): Promise<SubscriptionRecord[]> {
  const rows = await client.query<SubscriptionRowLike>(
    `SELECT ${SELECT_COLS} FROM dbo.subscriptions
      WHERE project_id = @p1
      ORDER BY created_at, id`,
    [projectId],
  );
  return rows.map(rowToSubscription);
}

/** Every enabled subscription across every project — the scheduler's resume read. */
export async function listEnabledSubscriptions(
  client: MssqlClient,
  limit: number = MAX_ENABLED_SUBSCRIPTIONS,
): Promise<SubscriptionRecord[]> {
  const capped = Math.min(Math.max(Math.trunc(limit), 1), MAX_ENABLED_SUBSCRIPTIONS);
  const rows = await client.query<SubscriptionRowLike>(
    `SELECT TOP (${capped}) ${SELECT_COLS} FROM dbo.subscriptions
      WHERE enabled = 1
      ORDER BY created_at, id`,
  );
  return rows.map(rowToSubscription);
}

/** One subscription, or `null` when it does not exist in this project. */
export async function getSubscription(
  client: MssqlClient | MssqlExecutor,
  projectId: string,
  id: string,
): Promise<SubscriptionRecord | null> {
  const rows = await client.query<SubscriptionRowLike>(
    `SELECT ${SELECT_COLS} FROM dbo.subscriptions WHERE project_id = @p1 AND id = @p2`,
    [projectId, id],
  );
  const row = rows[0];
  return row == null ? null : rowToSubscription(row);
}

/** Store a new subscription, enforcing the per-project cap under a range lock. */
export async function createSubscription(
  client: MssqlClient,
  projectId: string,
  sub: Subscription,
): Promise<SubscriptionRecord> {
  const id = `sub_${randomUUID().replace(/-/g, "").slice(0, 24)}`;
  const cols = toSubscriptionColumns(sub);
  return client.transaction(async (tx) => {
    const counted = await tx.query<{ n: number }>(
      `SELECT count(*) AS n FROM dbo.subscriptions WITH (UPDLOCK, HOLDLOCK)
        WHERE project_id = @p1`,
      [projectId],
    );
    if (Number(counted[0]?.n ?? 0) >= MAX_SUBSCRIPTIONS_PER_PROJECT) {
      throw new SubscriptionLimitError();
    }
    await tx.query(
      `INSERT INTO dbo.subscriptions
         (id, project_id, name, metric, config, webhook_secret, enabled,
          created_at, updated_at, failures)
       VALUES (@p1, @p2, @p3, @p4, @p5, @p6, @p7, SYSUTCDATETIME(), SYSUTCDATETIME(), 0)`,
      [id, projectId, cols.name, cols.metric, cols.config, cols.webhookSecret, cols.enabled],
    );
    const stored = await getSubscription(tx, projectId, id);
    if (stored == null) throw new Error(`subscription ${id} vanished after insert`);
    return stored;
  });
}

/** Enable or disable one subscription. `null` when it does not exist. */
export async function setSubscriptionEnabled(
  client: MssqlClient,
  projectId: string,
  id: string,
  enabled: boolean,
): Promise<SubscriptionRecord | null> {
  await client.query(
    `UPDATE dbo.subscriptions SET enabled = @p3, updated_at = SYSUTCDATETIME()
      WHERE project_id = @p1 AND id = @p2`,
    [projectId, id, enabled],
  );
  return getSubscription(client, projectId, id);
}

/** Delete a subscription and its firings. `false` when it did not exist. */
export async function deleteSubscription(
  client: MssqlClient,
  projectId: string,
  id: string,
): Promise<boolean> {
  return client.transaction(async (tx) => {
    await tx.query(
      `DELETE FROM dbo.subscription_events WHERE project_id = @p1 AND subscription_id = @p2`,
      [projectId, id],
    );
    const deleted = await tx.query<{ id: string }>(
      `DELETE FROM dbo.subscriptions OUTPUT deleted.id AS id WHERE project_id = @p1 AND id = @p2`,
      [projectId, id],
    );
    return deleted.length > 0;
  });
}

/** Write back what a delivery attempt learned. */
export async function recordSubscriptionOutcome(
  client: MssqlClient,
  projectId: string,
  id: string,
  outcome: SubscriptionDeliveryOutcome,
): Promise<void> {
  const sets = ["updated_at = SYSUTCDATETIME()"];
  const params: unknown[] = [projectId, id];
  if (outcome.firedAt != null) {
    params.push(outcome.firedAt.getTime());
    sets.push(`last_fired_at = ${epochToDatetime(`@p${params.length}`)}`);
  }
  if (outcome.lastError !== undefined) {
    params.push(outcome.lastError == null ? null : clampSubscriptionError(outcome.lastError));
    sets.push(`last_error = @p${params.length}`);
  }
  if (outcome.failures !== undefined) {
    params.push(Math.max(0, Math.trunc(outcome.failures)));
    sets.push(`failures = @p${params.length}`);
  }
  await client.query(
    `UPDATE dbo.subscriptions SET ${sets.join(", ")} WHERE project_id = @p1 AND id = @p2`,
    params,
  );
}

/** The webhook signing secret, or `null`. The only path that reads the column. */
export async function getWebhookSecret(
  client: MssqlClient,
  projectId: string,
  id: string,
): Promise<string | null> {
  const rows = await client.query<{ webhook_secret: string | null }>(
    `SELECT webhook_secret FROM dbo.subscriptions WHERE project_id = @p1 AND id = @p2`,
    [projectId, id],
  );
  const secret = rows[0]?.webhook_secret;
  return secret == null || secret === "" ? null : secret;
}

/** Append one firing and drop everything past the retained window. */
export async function recordSubscriptionEvent(
  client: MssqlClient,
  entry: SubscriptionEventInput,
): Promise<void> {
  const at = entry.at ?? new Date();
  await client.transaction(async (tx) => {
    await tx.query(
      `INSERT INTO dbo.subscription_events (id, subscription_id, project_id, at, payload)
       VALUES (@p1, @p2, @p3, ${epochToDatetime("@p4")}, @p5)`,
      [
        randomUUID(),
        entry.subscriptionId,
        entry.projectId,
        at.getTime(),
        JSON.stringify(entry.payload),
      ],
    );
    await tx.query(
      `WITH ranked AS (
         SELECT id, row_number() OVER (ORDER BY at DESC, id DESC) AS rn
           FROM dbo.subscription_events
          WHERE subscription_id = @p1
       )
       DELETE FROM dbo.subscription_events
        WHERE id IN (SELECT id FROM ranked WHERE rn > @p2)`,
      [entry.subscriptionId, MAX_SUBSCRIPTION_EVENTS],
    );
  });
}

/** A subscription's recent firings, newest first. */
export async function listSubscriptionEvents(
  client: MssqlClient,
  projectId: string,
  id: string,
  opts: SubscriptionEventQueryOptions = {},
): Promise<SubscriptionEventRecord[]> {
  const limit = clampEventLimit(opts.limit);
  const rows = await client.query<SubscriptionEventRowLike>(
    `SELECT TOP (${limit}) ${EVENT_COLS} FROM dbo.subscription_events
      WHERE project_id = @p1 AND subscription_id = @p2
      ORDER BY at DESC, id DESC`,
    [projectId, id],
  );
  return rows.map(rowToSubscriptionEvent);
}
