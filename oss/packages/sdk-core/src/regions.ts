import { sceneRegionsSchema } from "@uptimizr/schema";
import type { SceneRegion } from "@uptimizr/schema";

/**
 * Scene-region registration (ADR 0051 §2 / sketch §B.2) — the authoring
 * counterpart to a connector's `scanSceneProxy`.
 *
 * A scene proxy tells Uptimizr what a scene *looks* like; regions tell it what
 * the places in that scene are *called*. Declaring
 * `[{ id: "entrance", label: "Entrance", bounds: [...] }]` lets every spatial
 * query be drilled by name (`?region=entrance`) and lets summaries and agents
 * answer in words instead of coordinates.
 *
 * ## Security — this is an authenticated write, unlike event capture
 *
 * Event capture is deliberately keyless: `navigator.sendBeacon` cannot attach
 * secret headers, so the public `projectId` is the only credential (ADR 0003).
 * The scene registry is the opposite — like the existing
 * `PUT /scenes/:id/representation` proxy upload, it authenticates with a project
 * **API key** sent as `x-api-key`. That key must therefore NOT be baked into a
 * public production bundle. Call `registerRegions` from a build/deploy script,
 * an internal admin tool, a server-side route, or a developer-only path in your
 * app (the Uptimizr playground registers from its dev UI for exactly this
 * reason). It is a one-off authoring step, not something to run per page load.
 *
 * The key needs the **`annotate`** capability — the dedicated metadata-write
 * capability (ADR 0051 §5/§7), not `query`. Mint one with
 * `uptimizr new-key <projectId> --capabilities annotate`, or
 * `--capabilities query,annotate` if the same key also reads the regions back.
 */

/** Transport/auth settings for a scene-registry write. */
export interface RegisterRegionsOptions {
  /**
   * Collector base URL — the same `endpoint` the capture client is configured
   * with, with or without a trailing slash (e.g. `"http://localhost:4318"`).
   */
  endpoint: string;
  /**
   * Project API key, sent as `x-api-key`. It must hold the `annotate`
   * capability. See the security note above: never ship this in a public
   * bundle.
   */
  apiKey: string;
  /** `fetch` implementation to use. Defaults to the global `fetch`. */
  fetchImpl?: typeof fetch;
  /** Abort signal, so a caller can cancel or time out the request. */
  signal?: AbortSignal;
}

/**
 * Declare `sceneId`'s regions, **replacing** whatever the registry holds for
 * that scene — the call states what the scene's regions are, so removing one is
 * leaving it out and `[]` clears them. Idempotent: registering the same set
 * twice is a no-op in effect.
 *
 * Validates against `sceneRegionsSchema` before sending, so a bad box or a
 * duplicate id fails locally with a precise message instead of a bare `400`.
 * Rejects when the collector refuses the write (the error message carries the
 * status and the response body, truncated).
 *
 * @example
 * ```ts
 * await registerRegions(
 *   "lobby",
 *   [
 *     { id: "entrance", label: "Entrance", bounds: [-5, 0, -5, 5, 3, 0] },
 *     { id: "counter", label: "Checkout counter", bounds: [-1, 0, 1, 1, 2, 3] },
 *   ],
 *   { endpoint: "http://localhost:4318", apiKey: process.env.UPTIMIZR_API_KEY! },
 * );
 * ```
 */
export async function registerRegions(
  sceneId: string,
  regions: readonly SceneRegion[],
  options: RegisterRegionsOptions,
): Promise<void> {
  const parsed = sceneRegionsSchema.parse(regions);
  const doFetch = options.fetchImpl ?? globalThis.fetch;
  if (typeof doFetch !== "function") {
    throw new Error("registerRegions needs a fetch implementation (pass options.fetchImpl).");
  }
  // Trim trailing slashes with a loop rather than a `/\/+$/` regex: the greedy
  // quantifier backtracks from every position, so an endpoint of many slashes
  // costs quadratic time (CodeQL `js/polynomial-redos`). This is linear.
  let base = options.endpoint;
  while (base.endsWith("/")) base = base.slice(0, -1);
  const url = `${base}/api/v1/scenes/${encodeURIComponent(sceneId)}/regions`;
  const response = await doFetch(url, {
    method: "PUT",
    headers: { "content-type": "application/json", "x-api-key": options.apiKey },
    body: JSON.stringify({ regions: parsed }),
    signal: options.signal,
  });
  if (!response.ok) {
    // Surface the collector's own validation message; cap it so a stray HTML
    // error page cannot flood the console.
    const body = await response.text().catch(() => "");
    throw new Error(
      `Uptimizr region registration failed for scene "${sceneId}" ` +
        `(${response.status})${body ? `: ${body.slice(0, 300)}` : ""}`,
    );
  }
}
