import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Subscription } from "@uptimizr/schema";
import { createDuckdbClient, type DuckdbClient } from "../duckdb/client.js";
import { DUCKDB_MIGRATIONS, migrateDuckdb } from "../duckdb/migrations.js";
import {
  createSubscription,
  deleteSubscription,
  getSubscription,
  getWebhookSecret,
  listEnabledSubscriptions,
  listSubscriptionEvents,
  listSubscriptions,
  recordSubscriptionEvent,
  recordSubscriptionOutcome,
  setSubscriptionEnabled,
} from "../duckdb/subscriptions.js";
import {
  MASKED_SECRET,
  MAX_SUBSCRIPTIONS_PER_PROJECT,
  MAX_SUBSCRIPTION_EVENTS,
  SubscriptionLimitError,
  clampSubscriptionError,
  toSubscriptionColumns,
} from "../subscriptions.js";

/**
 * Conditional-subscription storage on the OSS DuckDB store (#311, ADR 0051 §6).
 *
 * The three things the collector actually relies on, and which a per-engine
 * accessor is easy to get wrong:
 *
 * - the webhook secret is stored but never reachable through a record;
 * - the firing log is bounded per subscription, on write;
 * - everything is scoped to a project, including the delete.
 */

const PID = "p1";
const OTHER_PID = "p2";

function declaration(overrides: Partial<Subscription> = {}): Subscription {
  return {
    name: "FPS drop in lobby",
    metric: "perf_summary",
    filters: { scene: "lobby" },
    evaluate: { every: "5m", window: "1h" },
    predicate: { kind: "threshold", column: "p50_fps", op: "<", value: 30 },
    cooldown: "1h",
    delivery: [{ kind: "sse" }],
    enabled: true,
    ...overrides,
  } as Subscription;
}

describe("duckdb subscriptions", () => {
  let db: DuckdbClient;

  beforeEach(async () => {
    db = await createDuckdbClient(":memory:");
    await migrateDuckdb(db);
  });

  afterEach(async () => {
    await db.close();
  });

  it("stores and reads back a declaration, defaulting what the caller left out", async () => {
    const created = await createSubscription(db, PID, declaration({ cooldown: undefined }));

    expect(created.id).toMatch(/^sub_[0-9a-f]{24}$/);
    expect(created.projectId).toBe(PID);
    expect(created.metric).toBe("perf_summary");
    expect(created.filters).toEqual({ scene: "lobby" });
    expect(created.predicate).toEqual({
      kind: "threshold",
      column: "p50_fps",
      op: "<",
      value: 30,
    });
    // Not declared, so the stored record carries the default rather than
    // `undefined` — the scheduler must never have to guess a cooldown.
    expect(created.cooldown).toBe("1h");
    expect(created.enabled).toBe(true);
    expect(created.failures).toBe(0);
    expect(created.lastFiredAt).toBeNull();
    expect(created.lastError).toBeNull();

    expect(await getSubscription(db, PID, created.id)).toEqual(created);
    expect(await listSubscriptions(db, PID)).toEqual([created]);
  });

  it("stores the webhook secret but never returns it in a record", async () => {
    const created = await createSubscription(
      db,
      PID,
      declaration({
        delivery: [
          { kind: "sse" },
          { kind: "webhook", url: "https://hooks.example/uptimizr", secret: "s".repeat(32) },
        ],
      }),
    );

    const webhook = created.delivery.find((d) => d.kind === "webhook");
    expect(webhook).toBeDefined();
    expect(webhook && "secret" in webhook ? webhook.secret : null).toBe(MASKED_SECRET);
    // The one accessor that may see it, and the raw column behind it.
    expect(await getWebhookSecret(db, PID, created.id)).toBe("s".repeat(32));

    const [{ config }] = await db.all<{ config: string }>(
      `SELECT config FROM subscriptions WHERE id = $id`,
      { id: created.id },
    );
    expect(config).not.toContain("ssssssss");
  });

  it("keeps projects apart on read, update and delete", async () => {
    const mine = await createSubscription(db, PID, declaration());
    await createSubscription(db, OTHER_PID, declaration({ name: "someone else's" }));

    expect(await getSubscription(db, OTHER_PID, mine.id)).toBeNull();
    expect(await setSubscriptionEnabled(db, OTHER_PID, mine.id, false)).toBeNull();
    expect(await deleteSubscription(db, OTHER_PID, mine.id)).toBe(false);
    expect(await getSubscription(db, PID, mine.id)).not.toBeNull();

    expect(await listSubscriptions(db, PID)).toHaveLength(1);
    expect(await listSubscriptions(db, OTHER_PID)).toHaveLength(1);
  });

  it("enables, disables and deletes", async () => {
    const created = await createSubscription(db, PID, declaration());

    const disabled = await setSubscriptionEnabled(db, PID, created.id, false);
    expect(disabled?.enabled).toBe(false);
    expect(await listEnabledSubscriptions(db)).toEqual([]);

    const enabled = await setSubscriptionEnabled(db, PID, created.id, true);
    expect(enabled?.enabled).toBe(true);
    expect((await listEnabledSubscriptions(db)).map((s) => s.id)).toEqual([created.id]);

    expect(await deleteSubscription(db, PID, created.id)).toBe(true);
    expect(await deleteSubscription(db, PID, created.id)).toBe(false);
    expect(await getSubscription(db, PID, created.id)).toBeNull();
  });

  it("records delivery bookkeeping, clamping the error text", async () => {
    const created = await createSubscription(db, PID, declaration());
    const at = new Date("2026-01-02T03:04:05.000Z");

    await recordSubscriptionOutcome(db, PID, created.id, {
      firedAt: at,
      lastError: `webhook responded 500\n${"x".repeat(1000)}`,
      failures: 2,
    });
    const failed = await getSubscription(db, PID, created.id);
    expect(failed?.lastFiredAt?.toISOString()).toBe(at.toISOString());
    expect(failed?.failures).toBe(2);
    expect(failed?.lastError).toBe(
      clampSubscriptionError(`webhook responded 500\n${"x".repeat(1000)}`),
    );
    expect(failed?.lastError).not.toContain("\n");

    // A later success clears the error and the streak without touching the rest.
    await recordSubscriptionOutcome(db, PID, created.id, { lastError: null, failures: 0 });
    const recovered = await getSubscription(db, PID, created.id);
    expect(recovered?.lastError).toBeNull();
    expect(recovered?.failures).toBe(0);
    expect(recovered?.lastFiredAt?.toISOString()).toBe(at.toISOString());
  });

  it("bounds the firing log to the last N per subscription, newest first", async () => {
    const created = await createSubscription(db, PID, declaration());
    const total = MAX_SUBSCRIPTION_EVENTS + 20;

    // Backfill everything but the newest row in one statement, then append that
    // one through `recordSubscriptionEvent`: the trim runs on write, so a single
    // real append over an oversized log is exactly what proves the bound — and
    // 120 sequential DuckDB transactions is the slowest way to learn the same
    // thing (it timed out under CI's parallel load).
    await db.run(
      `INSERT INTO subscription_events (id, subscription_id, project_id, "at", payload)
       SELECT 'evt_' || i, $subscriptionId, $projectId,
              make_timestamp(CAST((1700000000000 + i * 1000) AS BIGINT) * 1000),
              '{"seq": ' || i || '}'
         FROM range(0, ${total - 1}) AS t(i)`,
      { subscriptionId: created.id, projectId: PID },
    );
    await recordSubscriptionEvent(db, {
      subscriptionId: created.id,
      projectId: PID,
      at: new Date(1_700_000_000_000 + (total - 1) * 1000),
      payload: { seq: total - 1 },
    });

    const rows = await listSubscriptionEvents(db, PID, created.id, { limit: 1000 });
    expect(rows).toHaveLength(MAX_SUBSCRIPTION_EVENTS);
    // Newest first, and the oldest 20 have fallen off.
    expect(rows[0]?.payload).toEqual({ seq: total - 1 });
    expect(rows.at(-1)?.payload).toEqual({ seq: total - MAX_SUBSCRIPTION_EVENTS });

    const [{ n }] = await db.all<{ n: number }>(
      `SELECT count(*) AS n FROM subscription_events WHERE subscription_id = $id`,
      { id: created.id },
    );
    expect(Number(n)).toBe(MAX_SUBSCRIPTION_EVENTS);
  });

  it("drops a subscription's firings with the subscription", async () => {
    const created = await createSubscription(db, PID, declaration());
    await recordSubscriptionEvent(db, {
      subscriptionId: created.id,
      projectId: PID,
      payload: { seq: 1 },
    });

    await deleteSubscription(db, PID, created.id);
    const [{ n }] = await db.all<{ n: number }>(
      `SELECT count(*) AS n FROM subscription_events WHERE subscription_id = $id`,
      { id: created.id },
    );
    expect(Number(n)).toBe(0);
  });

  it("refuses to exceed the per-project cap", async () => {
    // Filled with one statement rather than a hundred `createSubscription`
    // round trips: the cap is read from the row count, so what is under test is
    // the guard, not the insert path (which every other case exercises). A
    // hundred real transactions would also make this the slowest test in the
    // package for no extra coverage.
    const cols = toSubscriptionColumns(declaration());
    await db.run(
      `INSERT INTO subscriptions
         (id, project_id, name, metric, config, webhook_secret, enabled,
          created_at, updated_at, failures)
       SELECT 'sub_seed_' || i, $projectId, 'seeded', $metric, $config, NULL, TRUE,
              now(), now(), 0
         FROM range(0, ${MAX_SUBSCRIPTIONS_PER_PROJECT}) AS t(i)`,
      { projectId: PID, metric: cols.metric, config: cols.config },
    );
    expect(await listSubscriptions(db, PID)).toHaveLength(MAX_SUBSCRIPTIONS_PER_PROJECT);

    await expect(createSubscription(db, PID, declaration())).rejects.toBeInstanceOf(
      SubscriptionLimitError,
    );
    // The cap is per project, not per store.
    await expect(createSubscription(db, OTHER_PID, declaration())).resolves.toBeDefined();
  });
});

describe("toSubscriptionColumns", () => {
  it("lifts the webhook secret out of the JSON config", () => {
    const cols = toSubscriptionColumns(
      declaration({
        delivery: [{ kind: "webhook", url: "https://hooks.example/x", secret: "a".repeat(20) }],
      }),
    );
    expect(cols.webhookSecret).toBe("a".repeat(20));
    expect(cols.config).not.toContain("aaaa");
    expect(JSON.parse(cols.config).delivery).toEqual([
      { kind: "webhook", url: "https://hooks.example/x" },
    ]);
  });
});

describe("DUCKDB_MIGRATIONS (subscriptions)", () => {
  it("creates both tables with the columns the accessors select", () => {
    const subs = DUCKDB_MIGRATIONS.find((m) => m.id === "0044_subscriptions");
    expect(subs?.sql).toContain("CREATE TABLE IF NOT EXISTS subscriptions");
    for (const column of [
      "project_id",
      "metric",
      "config",
      "webhook_secret",
      "enabled",
      "last_fired_at",
      "last_error",
      "failures",
    ]) {
      expect(subs?.sql, column).toContain(column);
    }

    const events = DUCKDB_MIGRATIONS.find((m) => m.id === "0046_subscription_events");
    expect(events?.sql).toContain("CREATE TABLE IF NOT EXISTS subscription_events");
    // `at` is a DuckDB keyword, so it must be quoted here and in every accessor.
    expect(events?.sql).toContain(`"at"`);
  });
});
