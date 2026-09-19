/**
 * A shared budget for held-open SSE connections (ADR 0032 §6).
 *
 * The live endpoints and the conditional-subscription stream (#311) are the
 * same kind of resource: a socket the collector keeps open, a subscriber on an
 * in-process bus, and a heartbeat timer. `LIVE_MAX_CONNECTIONS` is meant to
 * bound *that*, so they draw on one counter rather than one each — otherwise the
 * setting silently means "up to 2 × max", and grows every time another SSE
 * surface is added.
 */
export interface ConnectionLimiter {
  /** Take a slot, or `false` when the budget is exhausted. */
  acquire(): boolean;
  /** Return a slot. Never drops below zero, so a double release is harmless. */
  release(): void;
  /** Slots currently held (for tests). */
  readonly open: number;
  /** The configured ceiling. */
  readonly max: number;
}

/** Create a limiter over `max` concurrent connections. */
export function createConnectionLimiter(max: number): ConnectionLimiter {
  const ceiling = Math.max(0, Math.trunc(max));
  let open = 0;
  return {
    acquire() {
      if (open >= ceiling) return false;
      open += 1;
      return true;
    },
    release() {
      if (open > 0) open -= 1;
    },
    get open() {
      return open;
    },
    get max() {
      return ceiling;
    },
  };
}
