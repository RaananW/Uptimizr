import type { FastifyPluginAsync, FastifyReply } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { collectRequestSchema, collectResponseSchema } from "@uptimizr/schema";
import type { CollectorConfig } from "../config.js";
import type { CollectorStore } from "../store.js";
import type { LiveBus } from "../liveBus.js";
import { enrichEvents } from "../enrich.js";
import { dailySalt, visitorHash } from "../visitor.js";

interface Options {
  store: CollectorStore;
  config: CollectorConfig;
  liveBus: LiveBus;
}

/** Reject an ingest batch with a status + error message (plain reply, unconstrained by the 200 schema). */
function rejectIngest(reply: FastifyReply, code: number, error: string): FastifyReply {
  return reply.code(code).send({ error });
}

/**
 * Ingestion route. Validates the batch against the schema, authorizes it against
 * the (public) project id, enriches each event with the cookieless visitor id
 * (raw IP never stored), publishes to the live bus (ADR 0032 §2), and inserts.
 * Kept thin — all storage logic lives in the store.
 *
 * Browser beacons (`navigator.sendBeacon`) cannot carry a secret header, so the
 * `projectId` in the envelope is the public ingest credential (like a GA
 * measurement id). The route therefore (a) requires every event in a batch to
 * share one `projectId` and (b) rejects batches for a project that does not
 * exist, so events can never be written under an arbitrary/spoofed project. CORS
 * origin allow-listing and a dedicated per-client rate limit bound the rest.
 */
export const collectRoutes: FastifyPluginAsync<Options> = async (app, { store, config, liveBus }) => {
  const r = app.withTypeProvider<ZodTypeProvider>();

  r.post(
    "/api/v1/collect",
    {
      config: {
        rateLimit: {
          max: config.ingestRateLimitMax,
          timeWindow: config.ingestRateLimitWindowMs,
        },
      },
      schema: {
        body: collectRequestSchema,
        response: { 200: collectResponseSchema },
      },
    },
    async (request, reply) => {
      const { events } = request.body;
      const projectId = events[0]!.projectId;

      // A batch belongs to exactly one project; mixed ids are rejected outright.
      if (events.some((event) => event.projectId !== projectId)) {
        return rejectIngest(reply, 400, "all events in a batch must share one projectId");
      }

      // Reject events for an unknown project so data is never stored under a
      // spoofed/non-existent id.
      if (!(await store.projectExists(projectId))) {
        return rejectIngest(reply, 401, "unknown project");
      }

      const ip = request.ip ?? "";
      const ua = (request.headers["user-agent"] as string | undefined) ?? "";
      const visitorId = visitorHash(ip, ua, dailySalt(config.visitorHashSecret));

      const enriched = enrichEvents(events, visitorId);
      liveBus.publish(enriched);
      await store.insertEvents(enriched);

      return { accepted: enriched.length, rejected: 0 };
    },
  );
};
