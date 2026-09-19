import type { SubscriptionFiring } from "@uptimizr/schema";

/**
 * **In-process fan-out for subscription firings** (#311, sketch §F.3).
 *
 * The SSE half of delivery. It is deliberately *not* the live bus: the live bus
 * carries every ingested event and is hot, whereas this carries at most one
 * message per subscription per cooldown and exists only so
 * `GET /api/v1/subscriptions/stream` has something to read from. Keeping them
 * apart means a firing can never be dropped by a slow live consumer's queue, and
 * a subscription listener can never back-pressure ingest.
 *
 * Listeners are plain callbacks rather than async iterators because the SSE
 * route writes synchronously to a socket; there is nothing to buffer, and
 * nothing to bound beyond the connection cap the route already enforces.
 */

/** What an SSE listener receives. */
export interface SubscriptionStreamMessage {
  firing: SubscriptionFiring;
  /** The same bounded `format=summary` block a webhook would carry. */
  summary: Record<string, unknown> | null;
}

export type SubscriptionStreamListener = (message: SubscriptionStreamMessage) => void;

export interface SubscriptionStreamOptions {
  projectId: string;
  /** Deliver only this subscription's firings; omit for the whole project. */
  subscriptionId?: string;
}

export interface SubscriptionStream {
  /** Register a listener. Returns an idempotent unsubscribe. */
  subscribe(options: SubscriptionStreamOptions, listener: SubscriptionStreamListener): () => void;
  /** Fan a firing out to matching listeners. */
  publish(projectId: string, message: SubscriptionStreamMessage): void;
  /** Open listener count (for tests and the connection accounting). */
  readonly listenerCount: number;
  /** Drop every listener. */
  stop(): void;
}

interface Entry {
  options: SubscriptionStreamOptions;
  listener: SubscriptionStreamListener;
}

/** Create the default in-process subscription stream. */
export function createSubscriptionStream(): SubscriptionStream {
  const entries = new Set<Entry>();

  return {
    subscribe(options, listener) {
      const entry: Entry = { options, listener };
      entries.add(entry);
      return () => {
        entries.delete(entry);
      };
    },

    publish(projectId, message) {
      for (const entry of entries) {
        if (entry.options.projectId !== projectId) continue;
        if (
          entry.options.subscriptionId != null &&
          entry.options.subscriptionId !== message.firing.subscriptionId
        ) {
          continue;
        }
        // A throwing listener is a broken socket, not a reason to abandon the
        // rest of the fan-out.
        try {
          entry.listener(message);
        } catch {
          /* ignore */
        }
      }
    },

    get listenerCount() {
      return entries.size;
    },

    stop() {
      entries.clear();
    },
  };
}
