import type { FastifyReply, FastifyRequest } from "fastify";
import type { ApiKeyCapability, MetadataAuthorKind, ResolvedApiKey } from "@uptimizr/db";
import type { CollectorStore } from "./store.js";

/**
 * Request-boundary authentication and capability checks for the collector
 * (#309, ADR 0051 §7).
 *
 * A key resolves to a **capability set**, not a single capability, so the same
 * plumbing serves reads (`query`), raw per-session access (`query:raw`, which
 * additionally requires `ENABLE_RAW_SESSION_RETENTION` — ADR 0003) and the
 * metadata write path (`annotate`, whose endpoints arrive with #310).
 *
 * Resolution happens once per request, in an `onRequest` hook, so that:
 *
 * 1. the rate limiter can key on the API key id and honour the key's own
 *    per-key budget before any handler runs, and
 * 2. handlers and the audit hook read the already-resolved key instead of
 *    hitting the metadata store again.
 */

declare module "fastify" {
  interface FastifyRequest {
    /**
     * What this request's `x-api-key` resolved to, or `null` when
     * unauthenticated. This is the key's **record** — project, key id,
     * capabilities, rate limit — and deliberately never the key itself, which
     * is read from the header and discarded.
     */
    resolvedKey: ResolvedApiKey | null;
    /** Rows in the response body, when it serialized to an array (audit log). */
    auditRowCount: number | null;
  }
}

/** Header a first-party UI sets to identify itself (see `isDashboardRequest`). */
export const CLIENT_HEADER = "x-uptimizr-client";

/**
 * Whether this request is "the dashboard's own session" — the requests the
 * audit log deliberately skips so an agent's activity is not buried under a
 * dashboard's panel refreshes.
 *
 * It is identified by the `x-uptimizr-client: dashboard` header that
 * `@uptimizr/react`'s `CollectorApi` sets by default; the in-browser assistant
 * and any other agent client send a different value (or none) and are audited.
 *
 * This is a **volume filter, not a security boundary**: anyone holding the key
 * could send the header, and anyone holding the key can already do everything
 * the key allows. Set `AUDIT_DASHBOARD_REQUESTS=1` to record every
 * authenticated request without exception.
 */
export function isDashboardRequest(request: FastifyRequest): boolean {
  return request.headers[CLIENT_HEADER] === "dashboard";
}

/**
 * Who a metadata write (#310, ADR 0051 §5) is attributed to.
 *
 * It reuses the surface marker the audit log already distinguishes on rather
 * than inventing a second notion of "who": the dashboard's own session is a
 * **person** clicking in a UI, and everything else holding an `annotate` key —
 * an MCP client, the in-browser assistant writing up its own answer, a
 * scheduled report — is an **agent**.
 *
 * It is derived from the request, never read from the payload, so a stored row
 * cannot claim an authorship its writer did not send. Like the audit filter it
 * is an honest label, not a security boundary.
 */
export function metadataAuthorKind(request: FastifyRequest): MetadataAuthorKind {
  return isDashboardRequest(request) ? "user" : "agent";
}

/**
 * Resolve the request's `x-api-key` into {@link FastifyRequest.resolvedKey}.
 * Never replies and never throws: an absent, unknown or revoked key simply
 * leaves `resolvedKey` null, and the helpers below turn that into a 401.
 */
export async function attachApiKey(request: FastifyRequest, store: CollectorStore): Promise<void> {
  const header = request.headers["x-api-key"];
  if (typeof header !== "string" || header.length === 0) return;
  try {
    request.resolvedKey = await store.resolveApiKey(header);
  } catch (err) {
    request.log.warn({ err }, "api key resolution failed");
  }
}

/** The 403 body for each capability a request can be refused for. */
const CAPABILITY_REFUSALS: Record<ApiKeyCapability, string> = {
  query: "api key not permitted to read",
  "query:raw": "api key not permitted to read raw session data",
  annotate: "api key not permitted to write metadata",
  ingest: "api key not permitted to ingest",
};

/**
 * Require an authenticated key holding `capability`. Sends a 401 (no/invalid
 * key) or 403 (key lacks the capability) and returns `null` on refusal.
 *
 * Reads are always scoped to the authenticated project — a client-supplied
 * project id is never trusted.
 */
export async function requireCapability(
  request: FastifyRequest,
  reply: FastifyReply,
  store: CollectorStore,
  capability: ApiKeyCapability,
): Promise<ResolvedApiKey | null> {
  const header = request.headers["x-api-key"];
  if (typeof header !== "string" || header.length === 0) {
    await reply.code(401).send({ error: "missing api key" });
    return null;
  }
  // The `onRequest` hook has normally resolved this already; fall back to a
  // direct lookup so the helper is usable from a plugin registered without it.
  if (!request.resolvedKey) await attachApiKey(request, store);
  const resolved = request.resolvedKey;
  if (!resolved) {
    await reply.code(401).send({ error: "invalid api key" });
    return null;
  }
  if (!resolved.capabilities.includes(capability)) {
    await reply.code(403).send({ error: CAPABILITY_REFUSALS[capability] });
    return null;
  }
  return resolved;
}
