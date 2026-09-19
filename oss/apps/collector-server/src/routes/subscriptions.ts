import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import {
  MAX_SUBSCRIPTION_EVENTS,
  SubscriptionLimitError,
  isBucketableMetric,
  BUCKETABLE_METRIC_IDS,
  type SubscriptionRecord,
} from "@uptimizr/db";
import { LIMITS, subscriptionPatchSchema, subscriptionSchema } from "@uptimizr/schema";
import { getMetric } from "@uptimizr/metrics";
import type { CollectorConfig } from "../config.js";
import type { CollectorStore } from "../store.js";
import { requireCapability } from "../auth.js";
import { verifyLiveToken } from "../liveToken.js";
import { createConnectionLimiter, type ConnectionLimiter } from "../connectionLimiter.js";
import { thresholdColumnFor } from "../subscriptions/evaluate.js";
import { checkWebhookUrl, webhookTargetOf } from "../subscriptions/delivery.js";
import type { SubscriptionScheduler } from "../subscriptions/scheduler.js";
import type { SubscriptionStream } from "../subscriptions/stream.js";

/**
 * **Conditional subscriptions API** — `/api/v1/subscriptions` (#311, ADR 0051
 * §6 / sketch §F.1–F.3).
 *
 * Its own plugin, registered with one line in `app.ts`, for the same reason
 * `insights.ts` is: it is a different *kind* of surface from the aggregate reads
 * — a small CRUD resource plus an SSE stream, with its own error vocabulary and
 * its own capability split.
 *
 * ## The capability split
 *
 * Reads (`GET`) need `query`: a subscription is project configuration, and a key
 * that can read the project's telemetry can read what it is watching for.
 * **Writes need `annotate`** (ADR 0051 §7) — the same grant the metadata write
 * path uses — because creating a subscription is how an agent asks the collector
 * to make an outbound request on its behalf. A plain `query` key cannot do that.
 *
 * ## Secrets
 *
 * A webhook `secret` is accepted on create and never returned again: every read
 * answers with a masked placeholder (`@uptimizr/db`'s `MASKED_SECRET`). There is
 * no rotate endpoint on purpose — replacing the subscription is one call, and it
 * makes the change visible in the listing rather than silent.
 *
 * ## The SSE stream
 *
 * `GET /api/v1/subscriptions/stream?token=…` uses the live-token model of
 * ADR 0032 §7 (an `EventSource` cannot send `x-api-key`) and shares the live
 * endpoints' connection budget, because it is the same kind of held-open socket
 * and the same kind of memory.
 */

interface Options {
  store: CollectorStore;
  config: CollectorConfig;
  scheduler: SubscriptionScheduler;
  stream: SubscriptionStream;
  /**
   * The collector-wide SSE connection budget, shared with the live endpoints
   * (ADR 0032 §6): this stream is the same kind of held-open socket, so one
   * counter serves both and `LIVE_MAX_CONNECTIONS` bounds the total.
   */
  connections?: ConnectionLimiter;
}

const HEARTBEAT_MS = 15_000;

const idParam = z.object({ id: z.string().min(1).max(64) });

const streamQuery = z.object({
  token: z.string().min(1).optional(),
  /** Deliver only this subscription's firings. */
  id: z.string().min(1).max(64).optional(),
});

const eventsQuery = z.object({
  limit: z.coerce.number().int().positive().max(MAX_SUBSCRIPTION_EVENTS).optional(),
});

const testQuery = z.object({
  /** Also record and deliver the firing, if it fires. Off by default. */
  deliver: z.coerce.boolean().optional(),
});

/**
 * The body a rejected create answers with.
 *
 * A plain interface rather than a Zod schema: none of these routes pins a
 * `response` schema (the handlers answer with several shapes per status, and
 * pinning one narrows the others away), so there is nothing here for Zod to
 * validate — only a shape for the handler to build. The contract a caller reads
 * is the OpenAPI document in `meta.ts`.
 */
interface RejectionBody {
  error: string;
  metric?: string;
  column?: string;
  available?: string[];
}

/**
 * Shape a stored record for the wire.
 *
 * Only the timestamps change: `Date` objects would serialise to ISO strings
 * anyway, but doing it explicitly is what `GET /api/v1/audit` does, and it keeps
 * the JSON identical whether Fastify's serializer or a test's `JSON.stringify`
 * produces it. Nothing is stripped here — the masking that matters is done by
 * the store's row mapper, so a record can never carry a secret this far.
 */
function toApi(sub: SubscriptionRecord): Record<string, unknown> {
  return {
    ...sub,
    createdAt: sub.createdAt.toISOString(),
    updatedAt: sub.updatedAt.toISOString(),
    lastFiredAt: sub.lastFiredAt?.toISOString() ?? null,
  };
}

/**
 * Validate a declaration against the registry, beyond what Zod can check.
 *
 * Three refusals, each naming its own remedy, for the same reason the insight
 * routes separate theirs: an agent that is told "bad metric" retries the same
 * call, and an agent that is told "use `p50_fps`" does not.
 */
function checkAgainstRegistry(sub: z.infer<typeof subscriptionSchema>): RejectionBody | null {
  // `presence` is answered from the live bus and reads no series at all, so it
  // is the one predicate that does not constrain the metric.
  const busOnly = sub.predicate.kind === "presence";

  const metric = getMetric(sub.metric);
  if (metric == null) {
    return {
      error: `unknown metric '${sub.metric}'`,
      metric: sub.metric,
      available: [...BUCKETABLE_METRIC_IDS],
    };
  }
  if (!busOnly && !isBucketableMetric(sub.metric)) {
    return {
      error:
        `metric '${sub.metric}' has no portable bucket series, so it cannot be evaluated on a ` +
        `window without changing what it means`,
      metric: sub.metric,
      available: [...BUCKETABLE_METRIC_IDS],
    };
  }
  if (sub.predicate.kind === "threshold") {
    const column = thresholdColumnFor(metric);
    if (column == null) {
      return {
        error: `metric '${sub.metric}' declares no comparable column to threshold on`,
        metric: sub.metric,
      };
    }
    if (sub.predicate.column !== column) {
      return {
        error:
          `a threshold on '${sub.metric}' can only compare its headline column ` +
          `'${column}' (got '${sub.predicate.column}')`,
        metric: sub.metric,
        column,
      };
    }
  }
  return null;
}

/** Whether the subscription's webhook target is reachable under this config. */
function checkDelivery(
  sub: z.infer<typeof subscriptionSchema>,
  config: CollectorConfig,
): string | null {
  const target = sub.delivery.find((d) => d.kind === "webhook");
  if (target == null || target.kind !== "webhook") return null;
  const checked = checkWebhookUrl(target.url, config.webhookAllowedHosts);
  return "refused" in checked ? checked.refused : null;
}

/** Open an SSE response on the raw socket (mirrors `routes/live.ts`). */
function openSse(
  request: FastifyRequest,
  reply: FastifyReply,
  config: CollectorConfig,
): { send: (data: string, event?: string) => void; comment: (text: string) => void } {
  const origin = request.headers.origin;
  const cors =
    typeof origin === "string" && config.corsOrigins.includes(origin)
      ? { "access-control-allow-origin": origin, vary: "Origin" }
      : {};
  reply.raw.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
    "x-accel-buffering": "no",
    ...cors,
  });
  reply.raw.write(": connected\n\n");
  reply.hijack();

  return {
    send: (data, event) => {
      if (reply.raw.writableEnded) return;
      if (event) reply.raw.write(`event: ${event}\n`);
      reply.raw.write(`data: ${data}\n\n`);
    },
    comment: (text) => {
      if (!reply.raw.writableEnded) reply.raw.write(`: ${text}\n\n`);
    },
  };
}

export const subscriptionRoutes: FastifyPluginAsync<Options> = async (app, options) => {
  const { store, config, scheduler, stream } = options;
  const r = app.withTypeProvider<ZodTypeProvider>();
  const connections = options.connections ?? createConnectionLimiter(config.liveMaxConnections);

  /** Resolve a subscription of the authenticated project, or send a 404. */
  async function resolve(
    projectId: string,
    id: string,
    reply: FastifyReply,
  ): Promise<SubscriptionRecord | null> {
    const sub = await store.getSubscription(projectId, id);
    if (sub == null) {
      await reply.code(404).send({ error: `no subscription '${id}' in this project` });
      return null;
    }
    return sub;
  }

  // --- SSE stream ----------------------------------------------------------
  // Registered before `/:id` so `stream` is never read as a subscription id.
  r.get("/api/v1/subscriptions/stream", { schema: { querystring: streamQuery } }, (req, reply) => {
    const token = req.query.token;
    if (!token) {
      void reply.code(401).send({ error: "missing live token" });
      return;
    }
    const claims = verifyLiveToken(token, config.liveTokenSecret);
    if (!claims) {
      void reply.code(401).send({ error: "invalid or expired live token" });
      return;
    }
    // Shares the live budget: an open subscription stream is the same held-open
    // socket, and one pool is the only way the cap means anything.
    if (!connections.acquire()) {
      void reply.code(503).send({ error: "live connection limit reached" });
      return;
    }

    const { send, comment } = openSse(req, reply, config);
    const unsubscribe = stream.subscribe(
      { projectId: claims.projectId, subscriptionId: req.query.id },
      (message) => send(JSON.stringify(message), "subscription"),
    );
    const heartbeat = setInterval(() => comment("ping"), HEARTBEAT_MS);
    heartbeat.unref?.();

    req.raw.on("close", () => {
      clearInterval(heartbeat);
      unsubscribe();
      connections.release();
    });
  });

  // --- CRUD ----------------------------------------------------------------
  r.get("/api/v1/subscriptions", {}, async (req, reply) => {
    const resolved = await requireCapability(req, reply, store, "query");
    if (!resolved) return reply;
    const rows = await store.listSubscriptions(resolved.projectId);
    return rows.map(toApi);
  });

  r.get("/api/v1/subscriptions/:id", { schema: { params: idParam } }, async (req, reply) => {
    const resolved = await requireCapability(req, reply, store, "query");
    if (!resolved) return reply;
    const sub = await resolve(resolved.projectId, req.params.id, reply);
    return sub == null ? reply : toApi(sub);
  });

  r.post(
    "/api/v1/subscriptions",
    {
      // No `response` schema: the handler answers with a 201 record, a 400
      // rejection or a 409, and pinning one of those in the serializer would
      // narrow the others away. Error bodies are documented in `meta.ts`.
      schema: { body: subscriptionSchema },
    },
    async (req, reply) => {
      const resolved = await requireCapability(req, reply, store, "annotate");
      if (!resolved) return reply;

      const rejection = checkAgainstRegistry(req.body);
      if (rejection != null) return reply.code(400).send(rejection);
      // A webhook the collector may not reach is refused at creation rather than
      // silently recorded and then failed on every firing.
      const refusal = checkDelivery(req.body, config);
      if (refusal != null) return reply.code(400).send({ error: refusal });

      try {
        const created = await store.createSubscription(resolved.projectId, req.body);
        await scheduler.reload();
        return reply.code(201).send(toApi(created));
      } catch (err) {
        if (err instanceof SubscriptionLimitError) {
          return reply.code(409).send({
            error: `a project may hold at most ${LIMITS.maxSubscriptionsPerProject} subscriptions`,
          });
        }
        throw err;
      }
    },
  );

  r.patch(
    "/api/v1/subscriptions/:id",
    {
      schema: { params: idParam, body: subscriptionPatchSchema },
    },
    async (req, reply) => {
      const resolved = await requireCapability(req, reply, store, "annotate");
      if (!resolved) return reply;
      const updated = await store.setSubscriptionEnabled(
        resolved.projectId,
        req.params.id,
        req.body.enabled,
      );
      if (updated == null) {
        return reply
          .code(404)
          .send({ error: `no subscription '${req.params.id}' in this project` });
      }
      await scheduler.reload();
      return toApi(updated);
    },
  );

  r.delete("/api/v1/subscriptions/:id", { schema: { params: idParam } }, async (req, reply) => {
    const resolved = await requireCapability(req, reply, store, "annotate");
    if (!resolved) return reply;
    const deleted = await store.deleteSubscription(resolved.projectId, req.params.id);
    if (!deleted) {
      return reply.code(404).send({ error: `no subscription '${req.params.id}' in this project` });
    }
    await scheduler.reload();
    return reply.code(204).send();
  });

  // --- Firings -------------------------------------------------------------
  r.get(
    "/api/v1/subscriptions/:id/events",
    {
      schema: { params: idParam, querystring: eventsQuery },
    },
    async (req, reply) => {
      const resolved = await requireCapability(req, reply, store, "query");
      if (!resolved) return reply;
      const sub = await resolve(resolved.projectId, req.params.id, reply);
      if (sub == null) return reply;
      const rows = await store.listSubscriptionEvents(resolved.projectId, sub.id, {
        limit: req.query.limit,
      });
      return rows.map((row) => ({ ...row, at: row.at.toISOString() }));
    },
  );

  /**
   * Evaluate once, now.
   *
   * A dry run by default: it answers with the evaluation — including *why* it
   * did not fire — and delivers nothing. `?deliver=true` makes it a real firing,
   * cooldown and all, which is how an operator proves a webhook receiver works
   * without waiting for the condition to occur on its own.
   */
  r.post(
    "/api/v1/subscriptions/:id/test",
    {
      schema: { params: idParam, querystring: testQuery },
    },
    async (req, reply) => {
      const resolved = await requireCapability(req, reply, store, "annotate");
      if (!resolved) return reply;
      const sub = await resolve(resolved.projectId, req.params.id, reply);
      if (sub == null) return reply;

      const result = await scheduler.runOnce(sub, { deliver: req.query.deliver === true });
      if (result == null) {
        return reply
          .code(409)
          .send({ error: "an evaluation is already in flight; try again in a moment" });
      }
      return {
        fired: result.fired,
        reason: result.reason,
        window: result.window,
        value: result.value,
        expected: result.expected,
        sampleSize: result.sampleSize,
        dimensionValue: result.dimensionValue,
        bucket: result.bucket,
        delivered: result.fired && req.query.deliver === true,
        webhookConfigured: webhookTargetOf(sub) != null,
      };
    },
  );
};
