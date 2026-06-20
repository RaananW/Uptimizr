import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import type { CollectorConfig } from "../config.js";
import type { CollectorStore } from "../store.js";
import type { LiveBus } from "../liveBus.js";
import { mintLiveToken, verifyLiveToken } from "../liveToken.js";

interface Options {
  store: CollectorStore;
  config: CollectorConfig;
  liveBus: LiveBus;
}

const HEARTBEAT_MS = 15_000;
const tokenQuery = z.object({ token: z.string().min(1).optional() });
const streamQuery = tokenQuery.extend({
  /** Optional comma-separated event-type allow-list for the firehose. */
  types: z.string().max(512).optional(),
});

/**
 * Resolve the project for a live SSE request from a `?token=` (ADR 0032 §7).
 * Sends a 401 and returns `null` when the token is missing/invalid/expired.
 */
function authLiveToken(
  request: FastifyRequest<{ Querystring: { token?: string } }>,
  reply: FastifyReply,
  config: CollectorConfig,
): string | null {
  const token = request.query.token;
  if (!token) {
    void reply.code(401).send({ error: "missing live token" });
    return null;
  }
  const projectId = verifyLiveToken(token, config.liveTokenSecret);
  if (!projectId) {
    void reply.code(401).send({ error: "invalid or expired live token" });
    return null;
  }
  return projectId;
}

/**
 * Reflect an allowed request `Origin` for a raw (hijacked) SSE response. The CORS
 * plugin sets `Access-Control-Allow-Origin` via `reply.header`, but SSE bypasses
 * Fastify's send path (`reply.raw.writeHead` + `reply.hijack`), so those headers
 * are never flushed. Without this, a cross-origin `EventSource` (e.g. the
 * dashboard on a different origin than the collector) is blocked by the browser.
 */
function sseCorsHeaders(
  request: FastifyRequest,
  config: CollectorConfig,
): Record<string, string> {
  const origin = request.headers.origin;
  if (typeof origin === "string" && config.corsOrigins.includes(origin)) {
    return { "access-control-allow-origin": origin, vary: "Origin" };
  }
  return {};
}

/** Open an SSE response on the raw socket. Returns a writer + a teardown hook. */
function openSse(
  request: FastifyRequest,
  reply: FastifyReply,
  config: CollectorConfig,
): { send: (data: string, event?: string) => void; comment: (text: string) => void } {
  reply.raw.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
    "x-accel-buffering": "no",
    ...sseCorsHeaders(request, config),
  });
  // Defeat proxy buffering and prompt the browser to open the stream.
  reply.raw.write(": connected\n\n");
  reply.hijack();

  const send = (data: string, event?: string): void => {
    if (reply.raw.writableEnded) return;
    if (event) reply.raw.write(`event: ${event}\n`);
    reply.raw.write(`data: ${data}\n\n`);
  };
  const comment = (text: string): void => {
    if (!reply.raw.writableEnded) reply.raw.write(`: ${text}\n\n`);
  };
  void request;
  return { send, comment };
}

/**
 * Live SSE endpoints (ADR 0032 §3): presence (aggregate, always on), the
 * project firehose (drives live dashboard updates), and the per-session
 * live-follow tail (gated by raw-session retention, like replay). All fan out
 * from the in-process bus and are bounded (ADR §6).
 */
export const liveRoutes: FastifyPluginAsync<Options> = async (app, { store, config, liveBus }) => {
  const r = app.withTypeProvider<ZodTypeProvider>();
  let connections = 0;

  /** Reserve a live connection slot, or send 503 when at capacity (ADR §6). */
  function acquireSlot(reply: FastifyReply): boolean {
    if (connections >= config.liveMaxConnections) {
      void reply.code(503).send({ error: "live connection limit reached" });
      return false;
    }
    connections += 1;
    return true;
  }

  // Server-to-server: exchange an API key for a short-lived live token (ADR §7).
  r.post("/api/v1/live/token", async (req, reply) => {
    const key = req.headers["x-api-key"];
    if (typeof key !== "string" || key.length === 0) {
      return reply.code(401).send({ error: "missing api key" });
    }
    const projectId = await store.resolveApiKey(key);
    if (!projectId) {
      return reply.code(401).send({ error: "invalid api key" });
    }
    const { token, expiresAt } = mintLiveToken(
      projectId,
      config.liveTokenSecret,
      config.liveTokenTtlMs,
    );
    return reply.send({ token, expiresAt });
  });

  // Aggregate presence: pushes a snapshot immediately, then on an interval that
  // doubles as the heartbeat. Privacy-safe → not gated by raw retention (ADR §3a).
  r.get("/api/v1/live/presence", { schema: { querystring: tokenQuery } }, (req, reply) => {
    const projectId = authLiveToken(req, reply, config);
    if (!projectId) return;
    if (!acquireSlot(reply)) return;

    const { send } = openSse(req, reply, config);
    const push = (): void => send(JSON.stringify(liveBus.presence(projectId)), "presence");
    push();
    const timer = setInterval(push, config.livePresenceIntervalMs);

    req.raw.on("close", () => {
      clearInterval(timer);
      connections -= 1;
    });
  });

  // Project firehose: every arriving event (optionally filtered by type). Drives
  // the dashboard's in-place panel/feed updates (ADR §3). Payloads carry no more
  // than the aggregate read API already exposes unless raw retention is on.
  r.get("/api/v1/live/stream", { schema: { querystring: streamQuery } }, (req, reply) => {
    const projectId = authLiveToken(req, reply, config);
    if (!projectId) return;
    if (!acquireSlot(reply)) return;

    const types = req.query.types
      ? new Set(
          req.query.types
            .split(",")
            .map((t) => t.trim())
            .filter(Boolean),
        )
      : undefined;

    const { send, comment } = openSse(req, reply, config);
    const sub = liveBus.subscribe({ projectId, types });
    const heartbeat = setInterval(() => comment("ping"), HEARTBEAT_MS);

    const pump = async (): Promise<void> => {
      for await (const event of sub) send(JSON.stringify(event), "event");
    };
    void pump();

    req.raw.on("close", () => {
      clearInterval(heartbeat);
      sub.close();
      connections -= 1;
    });
  });

  // Per-session live-follow tail for live replay. Gated by raw-session retention,
  // identical to historical replay (ADR 0003/0006). Sends connect-time backfill
  // from the bounded ring, then live events.
  r.get(
    "/api/v1/live/sessions/:id",
    { schema: { params: z.object({ id: z.string().min(1).max(128) }), querystring: tokenQuery } },
    (req, reply) => {
      const projectId = authLiveToken(req, reply, config);
      if (!projectId) return;
      if (!config.enableRawSessionRetention) {
        void reply.code(403).send({ error: "raw session retention is disabled" });
        return;
      }
      if (!acquireSlot(reply)) return;

      const sessionId = req.params.id;
      const { send, comment } = openSse(req, reply, config);
      const sub = liveBus.subscribe({ projectId, sessionId });

      for (const event of liveBus.recentForSession(projectId, sessionId)) {
        send(JSON.stringify(event), "event");
      }

      const heartbeat = setInterval(() => comment("ping"), HEARTBEAT_MS);
      const pump = async (): Promise<void> => {
        for await (const event of sub) send(JSON.stringify(event), "event");
      };
      void pump();

      req.raw.on("close", () => {
        clearInterval(heartbeat);
        sub.close();
        connections -= 1;
      });
    },
  );
};
