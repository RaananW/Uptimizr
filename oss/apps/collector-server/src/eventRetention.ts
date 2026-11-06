import type { FastifyInstance } from "fastify";
import { MS_PER_DAY, PRUNE_INTERVAL_MS } from "./audit.js";
import type { CollectorConfig } from "./config.js";
import type { CollectorStore } from "./store.js";

/**
 * The first line of a sweep error. A database error can quote the rows it failed
 * on, in its message and in its stack, and event content must not reach the log.
 */
function errorSummary(err: unknown): string {
  return (err instanceof Error ? err.message : String(err)).split("\n", 1)[0]!;
}

/**
 * Start the event retention sweep (ADR 0052): delete events older than
 * `config.eventRetentionDays` now, then every {@link PRUNE_INTERVAL_MS}. The
 * shape is the audit sweep's: the delete is idempotent, so a restart loop or
 * several collector instances sharing one database cost nothing; a failure is
 * logged and the next sweep retries; the timer is `unref`'d so it never keeps
 * the process alive. Returns a stop function.
 *
 * `eventRetentionDays <= 0` (the default) disables the sweep and keeps events
 * indefinitely. Only the cutoff is ever logged, never event content.
 */
export function startEventRetention(
  app: FastifyInstance,
  store: CollectorStore,
  config: CollectorConfig,
): () => void {
  if (config.eventRetentionDays <= 0) return () => {};

  const sweep = (): void => {
    const cutoff = Date.now() - config.eventRetentionDays * MS_PER_DAY;
    try {
      void store
        .pruneEvents(cutoff)
        .then(() => {
          app.log.info({ cutoff: new Date(cutoff).toISOString() }, "event retention sweep done");
        })
        .catch((err: unknown) => {
          app.log.warn({ error: errorSummary(err) }, "event retention sweep failed");
        });
    } catch (err) {
      app.log.warn({ error: errorSummary(err) }, "event retention sweep failed");
    }
  };

  sweep();
  const timer = setInterval(sweep, PRUNE_INTERVAL_MS);
  timer.unref?.();
  return () => clearInterval(timer);
}
