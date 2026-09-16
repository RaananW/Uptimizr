import type { FastifyInstance } from "fastify";
import { serializeAuditParams } from "@uptimizr/db";
import type { CollectorConfig } from "./config.js";
import type { CollectorStore } from "./store.js";
import { isDashboardRequest } from "./auth.js";

/**
 * Agent audit log plumbing (#309, ADR 0051 §7).
 *
 * Every authenticated request made with a key that is not the dashboard's own
 * session is recorded: which key, which endpoint, the (bounded, redacted)
 * parameters, the row count, the duration and the status.
 *
 * Two invariants hold everywhere in here:
 *
 * - **It never blocks the response.** The row is written from an `onResponse`
 *   hook, after the reply has been flushed.
 * - **It never fails a request.** Every store call is fire-and-forget with its
 *   rejection swallowed into a log line; an unavailable audit table degrades
 *   the log, not the API.
 */

/** How often the retention sweep runs. Daily is plenty for a 30-day window. */
const PRUNE_INTERVAL_MS = 6 * 60 * 60 * 1000;

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * Register the audit hooks on `app`:
 *
 * - `preSerialization` captures the row count when a handler returned an array
 *   (streamed/hijacked responses simply have none);
 * - `onResponse` writes the row for authenticated, non-dashboard requests.
 */
export function registerAuditHooks(
  app: FastifyInstance,
  store: CollectorStore,
  config: CollectorConfig,
): void {
  app.addHook("preSerialization", async (request, _reply, payload) => {
    if (Array.isArray(payload)) request.auditRowCount = payload.length;
    return payload;
  });

  app.addHook("onResponse", async (request, reply) => {
    const resolved = request.resolvedKey;
    if (!resolved) return;
    if (!config.auditDashboardRequests && isDashboardRequest(request)) return;
    // `reply.elapsedTime` is the ms between the request arriving and the
    // response being sent — exactly the duration the audit log wants.
    const durationMs = Math.round(reply.elapsedTime);
    try {
      void store
        .recordAudit({
          projectId: resolved.projectId,
          keyId: resolved.keyId,
          surface: "http",
          // The route pattern (`/api/v1/sessions/:id/events`), not the raw URL:
          // it groups cleanly and cannot carry a querystring credential.
          toolOrPath: request.routeOptions.url ?? new URL(request.url, "http://x").pathname,
          params: serializeAuditParams(request.query),
          rowCount: request.auditRowCount,
          durationMs,
          status: reply.statusCode,
        })
        .catch((err: unknown) => {
          request.log.warn({ err }, "failed to write agent audit row");
        });
    } catch (err) {
      // A synchronous throw from the store (or a store that does not implement
      // the audit surface at all) must never surface on the request path.
      request.log.warn({ err }, "failed to write agent audit row");
    }
  });
}

/**
 * Start the retention sweep: delete audit rows older than
 * `config.auditRetentionDays` now, then every {@link PRUNE_INTERVAL_MS}. The
 * delete is idempotent, so a restart loop or several collector instances
 * sharing one database cost nothing. Returns a stop function; the timer is
 * `unref`'d so it never keeps the process alive.
 *
 * `auditRetentionDays === 0` disables the sweep (keep rows indefinitely).
 */
export function startAuditRetention(
  app: FastifyInstance,
  store: CollectorStore,
  config: CollectorConfig,
): () => void {
  if (config.auditRetentionDays <= 0) return () => {};

  const sweep = (): void => {
    const cutoff = Date.now() - config.auditRetentionDays * MS_PER_DAY;
    try {
      void store.pruneAudit(cutoff).catch((err: unknown) => {
        app.log.warn({ err }, "agent audit retention sweep failed");
      });
    } catch (err) {
      app.log.warn({ err }, "agent audit retention sweep failed");
    }
  };

  sweep();
  const timer = setInterval(sweep, PRUNE_INTERVAL_MS);
  timer.unref?.();
  return () => clearInterval(timer);
}
