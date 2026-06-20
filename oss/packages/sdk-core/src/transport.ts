import type { CollectRequest } from "@uptimizr/schema";
import type { Transport } from "./types.js";

/**
 * Default browser transport.
 *
 * Prefers `navigator.sendBeacon` so in-flight batches survive page unload, and
 * falls back to `fetch` with `keepalive` (and finally a plain `fetch`) in
 * environments where beacon is unavailable (including Node for tests).
 */
export function createBeaconTransport(endpoint: string): Transport {
  const url = endpoint.replace(/\/$/, "") + "/api/v1/collect";

  return {
    async send(batch: CollectRequest): Promise<boolean> {
      const payload = JSON.stringify(batch);

      const nav = (globalThis as { navigator?: Navigator }).navigator;
      if (nav && typeof nav.sendBeacon === "function") {
        const blob = new Blob([payload], { type: "application/json" });
        return nav.sendBeacon(url, blob);
      }

      const fetchFn = (globalThis as { fetch?: typeof fetch }).fetch;
      if (typeof fetchFn !== "function") {
        return false;
      }

      try {
        const res = await fetchFn(url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: payload,
          keepalive: payload.length < 64_000,
        });
        return res.ok;
      } catch {
        return false;
      }
    },
  };
}
