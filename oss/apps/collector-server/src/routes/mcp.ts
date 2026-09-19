import { randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { CollectorError, createMcpServer, type CollectorClient } from "@uptimizr/mcp";
import type { ResolvedApiKey } from "@uptimizr/db";
import type { CollectorConfig } from "../config.js";
import type { CollectorStore } from "../store.js";
import { MCP_ROUTE_URL, requireCapability } from "../auth.js";
import { INTERNAL_DISPATCH_HEADER } from "../internalDispatch.js";

interface Options {
  store: CollectorStore;
  config: CollectorConfig;
  /** Per-process token marking the collector's in-process reads (see `internalDispatch.ts`). */
  internalDispatchToken: string;
}

/** How often idle sessions are swept. Cheap; the TTL does the real work. */
const SWEEP_INTERVAL_MS = 60_000;

/** Only the collector's own read API may be reached by an in-process tool call. */
const API_PREFIX = "/api/v1/";

/** Placeholder origin used to normalise a tool's relative path. Never dialled. */
const NORMALIZE_BASE = "http://collector.invalid";

/**
 * One live MCP session: the SDK transport, the `McpServer` bound to it, and the
 * key it belongs to. The session is *identified* by the SDK's session id, but it
 * is *authorised* per request — every request re-resolves its key, and a session
 * may only ever be driven by the key that opened it.
 */
interface McpSession {
  transport: StreamableHTTPServerTransport;
  server: McpServer;
  /** The key row this session belongs to; a different key is refused with 403. */
  keyId: string;
  /**
   * The raw API key the in-process client authenticates its reads with, boxed so
   * the freshest value from the latest authenticated request is used. Kept in
   * memory only, never logged, never written to the audit log.
   */
  keyRef: { current: string };
  /** Epoch ms of the most recent request on this session, for idle expiry. */
  lastSeenMs: number;
}

/** A JSON-RPC error body, so a refusal is still something an MCP client parses. */
function jsonRpcError(code: number, message: string): Record<string, unknown> {
  return { jsonrpc: "2.0", error: { code, message }, id: null };
}

/** Read a header that must be a single string value. */
function headerValue(value: string | string[] | undefined): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * Build the **in-process** collector client a session's tools read through.
 *
 * It re-enters this same Fastify app with `app.inject()` instead of opening a
 * loopback socket: no port, no self-URL configuration, no TLS hop, and nothing
 * a request can influence is ever turned into a network destination. The
 * injected request runs the complete request lifecycle — key resolution,
 * capability check, project scoping, Zod validation, the result-envelope hook
 * and the audit hook — so a tool call and the equivalent `curl` are answered by
 * the same code and recorded in the same log.
 *
 * The tool catalog builds paths from the metric registry and URL-encodes every
 * path parameter, but this is the boundary where an agent-supplied value becomes
 * a request, so the assembled path is normalised and required to stay inside the
 * collector's own read API.
 */
function createInProcessClient(
  app: FastifyInstance,
  keyRef: { current: string },
  internalDispatchToken: string,
): CollectorClient {
  return {
    async get(path, params = {}) {
      const url = new URL(path, NORMALIZE_BASE);
      for (const [key, value] of Object.entries(params)) {
        if (value != null) url.searchParams.set(key, String(value));
      }
      if (!url.pathname.startsWith(API_PREFIX)) {
        throw new CollectorError(`refusing to dispatch outside ${API_PREFIX}`, 400);
      }
      const response = await app.inject({
        method: "GET",
        url: `${url.pathname}${url.search}`,
        headers: {
          "x-api-key": keyRef.current,
          [INTERNAL_DISPATCH_HEADER]: internalDispatchToken,
          accept: "application/json",
        },
      });
      if (response.statusCode < 200 || response.statusCode >= 300) {
        throw new CollectorError(
          response.body || `HTTP ${response.statusCode}`,
          response.statusCode,
        );
      }
      return response.json();
    },
  };
}

/**
 * Collector-hosted MCP over Streamable HTTP (ADR 0051 §7, design sketch §G.1),
 * resolving the transport ADR 0050 §7 deferred pending auth.
 *
 * `POST /mcp` carries JSON-RPC, `GET /mcp` opens the server→client SSE stream,
 * and `DELETE /mcp` ends a session — the three verbs of the Streamable HTTP
 * specification, all on one route so the SDK transport can dispatch them.
 *
 * What this route adds around the transport:
 *
 * - **Auth on every request**, not just on `initialize`: `x-api-key` (or the
 *   `Authorization: Bearer` alias normalised in `auth.ts`) must resolve to a key
 *   holding `query`. Missing/unknown key → `401`, wrong capability → `403`. A
 *   session may only be driven by the key that opened it, so a leaked session id
 *   is worth nothing on its own.
 * - **One `McpServer` per session**, built by `@uptimizr/mcp`'s shared factory
 *   with that key's capability set, so the hosted surface is the same catalog
 *   the stdio package serves and write tools stay gated on the key.
 * - **Bounded sessions**: a global cap (`COLLECTOR_MCP_MAX_SESSIONS` → `503`)
 *   and an idle TTL, the `/mcp` counterpart of the live-SSE connection cap.
 *
 * The plugin is only registered when `COLLECTOR_MCP_HTTP` is on; otherwise
 * `/mcp` does not exist.
 */
export const mcpRoutes: FastifyPluginAsync<Options> = async (
  app,
  { store, config, internalDispatchToken },
) => {
  const sessions = new Map<string, McpSession>();
  /**
   * Sessions whose `initialize` is in flight and has not yet claimed an id.
   * They count against the cap, so two concurrent `initialize` requests cannot
   * both pass a check the other has not yet been counted by.
   */
  const opening = new Set<McpSession>();

  /** Close a session's transport and server, and drop it from the map. */
  async function closeSession(id: string | undefined, session: McpSession): Promise<void> {
    if (id != null) sessions.delete(id);
    try {
      await session.transport.close();
      await session.server.close();
    } catch (err) {
      app.log.warn({ err }, "failed to close mcp session");
    }
  }

  const sweep = setInterval(() => {
    const cutoff = Date.now() - config.mcpSessionTtlMs;
    for (const [id, session] of sessions) {
      if (session.lastSeenMs <= cutoff) void closeSession(id, session);
    }
  }, SWEEP_INTERVAL_MS);
  sweep.unref?.();

  app.addHook("onClose", async () => {
    clearInterval(sweep);
    const open = [...sessions.entries()];
    sessions.clear();
    await Promise.all(open.map(([id, session]) => closeSession(id, session)));
  });

  /**
   * Create a session for `resolved`. Registration in the map happens in
   * `onsessioninitialized`, which the transport fires while it is still handling
   * the `initialize` POST — before its response (an SSE stream that stays open)
   * completes, so the session is addressable by the time the client sees its id.
   */
  function createSession(resolved: ResolvedApiKey, key: string): McpSession {
    const keyRef = { current: key };
    // The transport's callbacks need the session the transport is part of, so
    // they close over a holder the session is dropped into a few lines below —
    // always before any callback can fire, which only happens once the request
    // handler calls `handleRequest`.
    const holder: { session?: McpSession } = {};
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (id) => {
        if (holder.session == null) return;
        // Promote from "opening" to a real session the moment the id exists.
        // This fires while the transport is still writing the `initialize`
        // response, which for an SSE answer outlives the handler — so the slot
        // must be moved here rather than after `handleRequest` resolves.
        opening.delete(holder.session);
        sessions.set(id, holder.session);
      },
      onsessionclosed: (id) => {
        sessions.delete(id);
      },
    });
    const server = createMcpServer(createInProcessClient(app, keyRef, internalDispatchToken), {
      capabilities: resolved.capabilities,
    });
    // Note: `transport.onclose` is deliberately not used here — `server.connect()`
    // claims it for the protocol's own teardown. The map is kept honest by
    // `onsessionclosed` (a client's DELETE) and by `closeSession` on the idle
    // sweep, the orphan path and shutdown, which are the only other ways a
    // session ends.
    const session: McpSession = {
      transport,
      server,
      keyId: resolved.keyId,
      keyRef,
      lastSeenMs: Date.now(),
    };
    holder.session = session;
    return session;
  }

  /**
   * Mirror the CORS decision onto the raw socket. The transport writes its
   * response with `writeHead`, bypassing Fastify's send path (exactly like the
   * live SSE routes), so headers set by the CORS plugin would never be flushed.
   * `Mcp-Session-Id` has to be *exposed* as well, or a browser-based MCP client
   * cannot read the session id it must echo back.
   */
  function applyCorsHeaders(request: FastifyRequest, reply: FastifyReply): void {
    const origin = request.headers.origin;
    if (typeof origin !== "string" || !config.corsOrigins.includes(origin)) return;
    reply.raw.setHeader("access-control-allow-origin", origin);
    reply.raw.setHeader("access-control-expose-headers", "Mcp-Session-Id");
    reply.raw.setHeader("vary", "Origin");
  }

  app.route({
    method: ["POST", "GET", "DELETE"],
    url: MCP_ROUTE_URL,
    handler: async (request, reply): Promise<void> => {
      // Re-authenticate on every request: Streamable HTTP is stateless on the
      // wire, so a session id alone must never be a credential.
      const key = headerValue(request.headers["x-api-key"]);
      if (key == null) {
        await reply.code(401).send(jsonRpcError(-32001, "missing api key"));
        return;
      }
      const resolved = await requireCapability(request, reply, store, "query");
      if (!resolved) return;

      const sessionId = headerValue(request.headers["mcp-session-id"]);
      let session = sessionId != null ? sessions.get(sessionId) : undefined;

      if (sessionId != null && session == null) {
        await reply.code(404).send(jsonRpcError(-32001, "Session not found"));
        return;
      }
      if (session != null) {
        if (session.keyId !== resolved.keyId) {
          await reply.code(403).send(jsonRpcError(-32001, "session belongs to a different key"));
          return;
        }
        session.keyRef.current = key;
        session.lastSeenMs = Date.now();
      } else {
        // No session id: only an `initialize` POST may open one. Everything else
        // gets the transport's own "session id required" answer, stated here
        // because there is no transport to ask yet.
        if (request.method !== "POST" || !isInitializeRequest(request.body)) {
          await reply
            .code(400)
            .send(jsonRpcError(-32000, "Bad Request: Mcp-Session-Id header is required"));
          return;
        }
        if (sessions.size + opening.size >= config.mcpMaxSessions) {
          await reply.code(503).send(jsonRpcError(-32000, "mcp session limit reached"));
          return;
        }
        session = createSession(resolved, key);
        opening.add(session);
        try {
          await session.server.connect(session.transport);
        } catch (err) {
          opening.delete(session);
          await closeSession(undefined, session);
          request.log.error({ err }, "failed to start mcp session");
          await reply.code(500).send(jsonRpcError(-32603, "failed to start mcp session"));
          return;
        }
      }

      const opened = session;
      applyCorsHeaders(request, reply);
      // The transport owns the response from here: it writes the status, the
      // headers and (for an SSE answer) a stream that outlives this handler.
      reply.hijack();
      try {
        await opened.transport.handleRequest(request.raw, reply.raw, request.body);
      } catch (err) {
        request.log.error({ err }, "mcp request failed");
        if (!reply.raw.headersSent) reply.raw.writeHead(500).end();
      } finally {
        // A POST that looked like `initialize` but was refused by the transport
        // never reached `onsessioninitialized`, so it is still "opening" and has
        // no session id — drop the orphan rather than leak its slot.
        if (opening.delete(opened)) await closeSession(undefined, opened);
      }
    },
  });
};
