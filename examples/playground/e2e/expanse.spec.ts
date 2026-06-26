import { expect, test, type APIRequestContext } from "@playwright/test";

import { API_KEY, COLLECTOR_URL } from "./constants.js";
import { bootEngine, enableAllCapture, openControls } from "./helpers/capture.js";

/**
 * The "expanse" scene (ADR 0040) end to end, across every engine that builds it
 * (Babylon, three.js, PlayCanvas). It is a deliberately large (~360 × 560 world-unit),
 * walkable, multi-level scene — the manual + automated test bed for large-scene
 * analytics that the unit/parity specs can only approximate with synthetic bounds.
 * Each engine shares one layout (geometry + height field + section boxes), so this spec
 * asserts the two large-scene behaviours that only a genuinely big, real scene exercises,
 * proving they hold regardless of connector:
 *
 * - **Section auto-switching (§5).** The spawn is in the plaza, so on entry the
 *   connector calls `setScene` and the tracked area becomes `expanse-plaza` — one
 *   continuous space tracked as distinct, named sub-areas without manual seams.
 * - **Bounds-driven default cell size (§1).** After the scene proxy registers the
 *   world's (large) bounds, `GET /heatmaps/world/stats` with **no** `cellSize`
 *   derives a coarse cell from those bounds — far above the `0.5` fixed default a
 *   small scene would get — proving resolution scales with scene extent.
 */

interface SpatialStats {
  cellSize: number;
  cells: number;
  hits: number;
}

async function getJson<T>(request: APIRequestContext, url: string): Promise<T> {
  const res = await request.get(url, { headers: { "x-api-key": API_KEY } });
  expect(res.ok(), `${url} should succeed (got ${res.status()}: ${await res.text()})`).toBeTruthy();
  return (await res.json()) as T;
}

for (const engine of ["babylon", "three", "playcanvas"] as const) {
  test(`[${engine}] large multi-level scene auto-switches sections and derives a bounds-driven cell size`, async ({
    page,
    request,
  }) => {
    await enableAllCapture(page, engine);
    await bootEngine(page, engine, "expanse");

    // 1) On entry the camera is in the plaza section, so the tracked scene id flips
    //    from the catalog "expanse" to the active sub-area "expanse-plaza" (§5).
    await expect(page.locator("#currentScene")).toHaveText("expanse-plaza");

    // 2) Register the scene proxy so the collector stores the world's large bounds
    //    (ADR 0014). The button lives in the controls panel, which boots collapsed.
    await openControls(page);
    await page.locator("#registerProxyButton").click();
    await expect(page.locator("#heatmapStatus")).toContainText(
      /Registered proxy for "expanse-plaza"/,
    );

    // 3) With bounds registered, the stats endpoint derives a coarse cell size from
    //    them when `cellSize` is omitted (§1). A ~560-unit longest axis over ~64 target
    //    cells lands near ~8.8 u — an order of magnitude above the 0.5 fixed default a
    //    small scene falls back to. Poll: the PUT is durable but read-after-write over
    //    the embedded store can lag a beat.
    await expect
      .poll(
        async () => {
          const stats = await getJson<SpatialStats>(
            request,
            `${COLLECTOR_URL}/api/v1/heatmaps/world/stats?scene=expanse-plaza`,
          );
          return stats.cellSize;
        },
        { timeout: 15_000 },
      )
      .toBeGreaterThanOrEqual(4);
  });
}
