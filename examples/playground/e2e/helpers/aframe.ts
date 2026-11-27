/**
 * The playground loads A-Frame from its official CDN (it is not a workspace
 * dependency — see `src/engines/aframe.ts`). Specs that boot A-Frame fetch the
 * library once per run (held in memory, never written to disk) and serve every
 * page load from that buffer, so the browser never depends on CDN latency
 * mid-test. If the fetch fails the request falls through to the CDN.
 */
import type { Page } from "@playwright/test";

const AFRAME_CDN_GLOB = "https://aframe.io/releases/*/aframe.min.js";

/** In-memory, per-run cache of the CDN build keyed by URL (`null` = fetch failed). */
const aframeBuilds = new Map<string, Promise<Buffer | null>>();
function fetchAframe(url: string): Promise<Buffer | null> {
  let pending = aframeBuilds.get(url);
  if (!pending) {
    pending = fetch(url)
      .then(async (res) => (res.ok ? Buffer.from(await res.arrayBuffer()) : null))
      .catch(() => null);
    aframeBuilds.set(url, pending);
  }
  return pending;
}

/** Serve the A-Frame CDN build to `page` from the per-run cache. Call before `goto`. */
export async function serveAframeFromCache(page: Page): Promise<void> {
  await page.route(AFRAME_CDN_GLOB, async (route) => {
    const body = await fetchAframe(route.request().url());
    // No buffer → let the browser hit the CDN directly.
    if (!body) return route.continue();
    return route.fulfill({ body, contentType: "application/javascript" });
  });
}
