import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { subscriptionSchema, type Subscription } from "@uptimizr/schema";
import { getMetric } from "@uptimizr/metrics";
import type { SubscriptionRecord } from "@uptimizr/db";
import { createStore } from "../serve.js";
import type { CollectorStore } from "../store.js";
import { evaluateSubscription } from "./evaluate.js";

/**
 * `uptimizr subscriptions …` — the operator's offline half of the subscriptions
 * API (#311, ADR 0051 §6).
 *
 * The offline sibling of `/api/v1/subscriptions`, and an **operator** command in
 * the same sense as `new-key` and `regions set`: it takes no API key and opens
 * the store directly, because store access is already strictly more than any
 * capability grants. It is the path a self-hoster uses to put a subscription
 * under version control — `sub.json` in a repo, applied by a deploy step —
 * rather than clicking one together.
 *
 * `test` deliberately **never delivers**. A dry run from a shell should not be
 * able to page anyone; proving a webhook receiver works is
 * `POST /api/v1/subscriptions/:id/test?deliver=true`, which needs an `annotate`
 * key and is auditable.
 *
 * Human progress goes to stderr, machine-readable JSON to stdout — the same
 * split the rest of `cli.ts` uses, so `uptimizr subscriptions list | jq` works.
 */

/** Read and validate a declaration file (a bare object or a `{ subscription }` envelope). */
export function readSubscriptionFile(file: string): Subscription {
  const raw = readFileSync(resolve(file), "utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`${file} is not valid JSON: ${err instanceof Error ? err.message : err}`, {
      cause: err,
    });
  }
  const candidate =
    parsed != null && typeof parsed === "object" && "subscription" in parsed
      ? (parsed as { subscription: unknown }).subscription
      : parsed;

  const result = subscriptionSchema.safeParse(candidate);
  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => `  - ${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("\n");
    throw new Error(`${file} is not a valid subscription:\n${issues}`);
  }
  return result.data;
}

/** One line per subscription, for `list`'s stderr summary. */
function summarize(sub: SubscriptionRecord): string {
  const state = sub.enabled ? "enabled" : "disabled";
  const last = sub.lastFiredAt ? sub.lastFiredAt.toISOString() : "never";
  const error = sub.lastError ? ` · last error: ${sub.lastError}` : "";
  return `${sub.id}  ${sub.name}  [${sub.predicate.kind} on ${sub.metric}] ${state} · last fired ${last}${error}`;
}

async function withStore<T>(fn: (store: CollectorStore) => Promise<T>): Promise<T> {
  const store = await createStore();
  try {
    return await fn(store);
  } finally {
    await store.close();
  }
}

/** `uptimizr subscriptions list` — every subscription of `projectId`. */
export async function cmdSubscriptionsList(projectId: string): Promise<void> {
  const rows = await withStore((store) => store.listSubscriptions(projectId));
  for (const sub of rows) console.error(summarize(sub));
  if (rows.length === 0) console.error(`No subscriptions on project ${projectId}.`);
  process.stdout.write(`${JSON.stringify(rows, null, 2)}\n`);
}

/** `uptimizr subscriptions add --file sub.json` — store a new declaration. */
export async function cmdSubscriptionsAdd(projectId: string, file: string): Promise<void> {
  const declaration = readSubscriptionFile(file);
  // The registry check the route does, done here too: an operator must not be
  // able to create offline a subscription the scheduler will only reject later.
  if (getMetric(declaration.metric) == null) {
    throw new Error(`Unknown metric ${JSON.stringify(declaration.metric)}.`);
  }
  const created = await withStore((store) => store.createSubscription(projectId, declaration));
  console.error(`✓ subscription ${created.id} created on project ${projectId}`);
  if (created.delivery.some((d) => d.kind === "webhook")) {
    console.error(
      "  A webhook is configured. The collector only POSTs to hosts named in " +
        "COLLECTOR_WEBHOOK_ALLOWED_HOSTS; until one is set, firings are recorded and " +
        "fanned out over SSE but nothing leaves the process.",
    );
  }
  process.stdout.write(`${JSON.stringify(created, null, 2)}\n`);
}

/** `uptimizr subscriptions remove <id>` — delete a subscription and its firings. */
export async function cmdSubscriptionsRemove(projectId: string, id: string): Promise<void> {
  const deleted = await withStore((store) => store.deleteSubscription(projectId, id));
  if (!deleted) throw new Error(`No subscription ${JSON.stringify(id)} on project ${projectId}.`);
  console.error(`✓ subscription ${id} removed`);
}

/**
 * `uptimizr subscriptions test <id>` — evaluate once, now, delivering nothing.
 *
 * Answers with the evaluation, including why it did not fire, which is what
 * makes a subscription tunable rather than mysterious.
 */
export async function cmdSubscriptionsTest(projectId: string, id: string): Promise<void> {
  const result = await withStore(async (store) => {
    const sub = await store.getSubscription(projectId, id);
    if (sub == null) {
      throw new Error(`No subscription ${JSON.stringify(id)} on project ${projectId}.`);
    }
    const metric = getMetric(sub.metric);
    if (metric == null) {
      throw new Error(`Subscription ${id} names unknown metric ${JSON.stringify(sub.metric)}.`);
    }
    const evaluation = await evaluateSubscription(
      {
        readBuckets: (opts) => store.metricBuckets(projectId, opts),
        // No live bus in a one-shot CLI process, so a `presence` predicate here
        // reads zero live sessions. Said plainly rather than left to be guessed.
        activeSessions: () => 0,
      },
      sub,
      metric,
    );
    return { sub, evaluation };
  });

  console.error(
    result.evaluation.fired
      ? `✓ would fire: ${result.evaluation.reason}`
      : `· would not fire: ${result.evaluation.reason}`,
  );
  if (result.sub.predicate.kind === "presence") {
    console.error(
      "  Note: `presence` is evaluated from the running collector's live bus; a CLI process " +
        "has none, so this reports zero live sessions.",
    );
  }
  process.stdout.write(
    `${JSON.stringify(
      {
        subscriptionId: result.sub.id,
        fired: result.evaluation.fired,
        reason: result.evaluation.reason,
        window: result.evaluation.window,
        value: result.evaluation.value,
        expected: result.evaluation.expected,
        sampleSize: result.evaluation.sampleSize,
        dimensionValue: result.evaluation.dimensionValue,
        bucket: result.evaluation.bucket,
        delivered: false,
      },
      null,
      2,
    )}\n`,
  );
}
