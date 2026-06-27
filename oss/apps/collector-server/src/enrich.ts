import type { AnyEvent } from "@uptimizr/schema";
import type { ClientInfo } from "./userAgent.js";

/**
 * Server-authoritative enrichment: stamp every event with the derived cookieless
 * `visitorId`, overriding anything the client may have sent. Order is preserved
 * so the stored stream stays replay-complete.
 *
 * When `client` (the coarse `{ browser, os }` derived from the request
 * User-Agent, ADR 0041) is provided, it is merged into the `device` block of
 * every `session_start` event — server-authoritative, overriding any
 * client-supplied `browser`/`os`. These derived, non-PII families are what the
 * performance panels segment FPS by (ADR 0028 §2). The raw User-Agent is never
 * stored. Other event types are untouched.
 */
export function enrichEvents(
  events: readonly AnyEvent[],
  visitorId: string,
  client?: ClientInfo,
): AnyEvent[] {
  return events.map((event) => {
    const enriched = { ...event, visitorId };
    if (client && event.type === "session_start") {
      const device = { ...(event.device ?? {}), browser: client.browser, os: client.os };
      return { ...enriched, device };
    }
    return enriched;
  });
}
