import type { AnyEvent } from "@uptimizr/schema";

/**
 * Server-authoritative enrichment: stamp every event with the derived cookieless
 * `visitorId`, overriding anything the client may have sent. Order is preserved
 * so the stored stream stays replay-complete.
 */
export function enrichEvents(events: readonly AnyEvent[], visitorId: string): AnyEvent[] {
  return events.map((event) => ({ ...event, visitorId }));
}
