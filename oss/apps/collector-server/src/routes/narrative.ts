/**
 * `GET /api/v1/sessions/:id/narrative` — the session narrative
 * (issue #314, ADR 0051 §7, design sketch §G.2).
 *
 * An agent that may legitimately inspect one session has, until now, had two
 * options and no good one: the aggregate metrics say nothing about a single
 * session, and `/sessions/:id/events` returns the whole raw stream — tens of
 * thousands of sampled telemetry lines that no model can read. This route serves
 * the middle ground: an ordered, compacted account of what the session did, with
 * timestamps relative to its first event and a hard cap on entries.
 *
 * **The gate is the same double gate as the raw stream (ADR 0003 / ADR 0051 §9):**
 * `ENABLE_RAW_SESSION_RETENTION` must be on *and* the key must hold `query:raw`.
 * A plain `query` key is authenticated — an unknown key still gets a 401 — and
 * then refused with the same 403 body as the events route, so the two surfaces
 * are indistinguishable to a caller probing for a way in.
 *
 * It lives in its own plugin rather than in `routes/query.ts` for two reasons:
 * the file is already 2 400 lines and under concurrent change, and this route
 * deliberately does **not** want `queryRoutes`' `format` hook (see `format`
 * below). Registered in `app.ts`, so the app-level audit hook records every call
 * — including the refusals, which is exactly what a project owner wants to see.
 */

import type { FastifyPluginAsync } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import {
  buildSessionNarrative,
  renderSessionNarrativeText,
  tableResult,
  type SummaryContext,
} from "@uptimizr/db";
import { NARRATIVE_LIMITS } from "@uptimizr/metrics";
import type { AnyEvent } from "@uptimizr/schema";
import type { CollectorConfig } from "../config.js";
import type { CollectorStore } from "../store.js";
import { requireCapability } from "../auth.js";

interface Options {
  store: CollectorStore;
  config: CollectorConfig;
}

/**
 * Querystring for the narrative. The bounds are the registry's
 * {@link NARRATIVE_LIMITS}, not numbers retyped here, so the tool schema, the
 * OpenAPI parameters and this validator cannot drift apart.
 *
 * `format` is the one place this route departs from the shared result envelope
 * (design sketch §B.1). `full` and `table` mean exactly what they mean
 * everywhere else; `text` is new and exists **only here**: the narrative's one
 * consumer is a model reading a session back, and a line-per-entry rendering
 * costs roughly a third of the tokens of the equivalent JSON. `summary` is not
 * offered — a narrative *is* a summary, and summarising it again would be a
 * digest of a digest.
 */
const narrativeQueryParams = z.object({
  minDwellMs: z.coerce.number().int().nonnegative().max(NARRATIVE_LIMITS.maxMinDwellMs).optional(),
  fpsThreshold: z.coerce.number().positive().max(NARRATIVE_LIMITS.maxFpsThreshold).optional(),
  maxEntries: z.coerce.number().int().positive().max(NARRATIVE_LIMITS.maxMaxEntries).optional(),
  format: z.enum(["full", "table", "text"]).optional(),
});

/**
 * Session-narrative route. Separate plugin, one registration line in `app.ts`.
 */
export const narrativeRoutes: FastifyPluginAsync<Options> = async (app, { store, config }) => {
  const r = app.withTypeProvider<ZodTypeProvider>();

  r.get(
    "/api/v1/sessions/:id/narrative",
    {
      schema: {
        params: z.object({ id: z.string().min(1) }),
        querystring: narrativeQueryParams,
      },
    },
    async (req, reply) => {
      // Both halves of the gate, in the same order and with the same bodies as
      // `/sessions/:id/events`.
      const resolved = await requireCapability(req, reply, store, "query");
      if (!resolved) return reply;
      if (!config.enableRawSessionRetention) {
        return reply.code(403).send({ error: "raw session retention is disabled" });
      }
      if (!resolved.capabilities.includes("query:raw")) {
        return reply.code(403).send({ error: "api key not permitted to read raw session data" });
      }

      // Stream the session out of the store rather than buffering it in the
      // driver (ADR 0015), then compact it. The compaction is pure and lives in
      // `@uptimizr/db`, so this handler stays a gate plus a format switch.
      const events: AnyEvent[] = [];
      for await (const event of store.streamSessionEvents(resolved.projectId, req.params.id)) {
        events.push(event);
      }
      if (events.length === 0) {
        // Unknown to this project, or recorded before retention was switched on.
        return reply.code(404).send({ error: "session not found" });
      }

      const { minDwellMs, fpsThreshold, maxEntries, format } = req.query;
      const narrative = buildSessionNarrative(events, { minDwellMs, fpsThreshold, maxEntries });

      if (format === "text") {
        return reply.type("text/plain; charset=utf-8").send(renderSessionNarrativeText(narrative));
      }
      if (format === "table") {
        const context: SummaryContext = {
          filters: { session: req.params.id, minDwellMs, fpsThreshold, maxEntries },
          limit: maxEntries ?? NARRATIVE_LIMITS.defaultMaxEntries,
        };
        return tableResult("session_narrative", narrative.entries, context);
      }
      return narrative.entries;
    },
  );
};
