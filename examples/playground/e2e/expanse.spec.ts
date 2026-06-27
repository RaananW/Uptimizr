import { expect, test, type APIRequestContext } from "@playwright/test";

import { API_KEY, COLLECTOR_URL } from "./constants.js";
import { bootEngine, enableAllCapture, openControls } from "./helpers/capture.js";

/**
 * The "expanse" scene (ADR 0040) end to end, across every engine that builds it
 * (Babylon, three.js, PlayCanvas). It is a deliberately large (~360 × 560 world-unit),
 * walkable, multi-level scene — the manual + automated test bed for large-scene
 * analytics that the unit/parity specs can only approximate with synthetic bounds.
 * Each engine shares one layout (geometry + height field + section boxes), so this spec
 * asserts the large-scene behaviours that only a genuinely big, real scene exercises,
 * proving they hold regardless of connector:
 *
 * - **Section auto-switching (§5).** The spawn is in the plaza, so on entry the
 *   connector calls `setScene` and the tracked area becomes `expanse-plaza` — one
 *   continuous space tracked as distinct, named sub-areas without manual seams.
 * - **Per-section scene proxies (§5).** Registering scopes a proxy to EACH section's
 *   own geometry (not one whole-world proxy), so every walkable area — even ones the
 *   visitor hasn't entered yet — gets a backdrop, and an elevated level is framed to
 *   just that level instead of the whole flat world.
 * - **Bounds-driven default cell size (§1).** After a section proxy registers its
 *   (large) bounds, `GET /heatmaps/world/stats` with **no** `cellSize` derives a coarse
 *   cell from those bounds — well above the `0.5` fixed default a small scene would get
 *   — proving resolution scales with scene extent.
 */

interface SpatialStats {
  cellSize: number;
  cells: number;
  hits: number;
}

interface Representation {
  sceneId: string;
  bounds: [number, number, number, number, number, number] | null;
  proxy: { meshCount: number; bounds: number[] } | null;
}

async function getJson<T>(request: APIRequestContext, url: string): Promise<T> {
  const res = await request.get(url, { headers: { "x-api-key": API_KEY } });
  expect(res.ok(), `${url} should succeed (got ${res.status()}: ${await res.text()})`).toBeTruthy();
  return (await res.json()) as T;
}

async function getRepresentation(
  request: APIRequestContext,
  sceneId: string,
): Promise<Representation | null> {
  const res = await request.get(`${COLLECTOR_URL}/api/v1/scenes/${sceneId}/representation`, {
    headers: { "x-api-key": API_KEY },
  });
  if (res.status() === 404) return null;
  expect(res.ok(), `${sceneId} representation (got ${res.status()})`).toBeTruthy();
  return (await res.json()) as Representation;
}

for (const engine of ["babylon", "three", "playcanvas"] as const) {
  test(`[${engine}] large multi-level scene auto-switches sections and registers per-section proxies`, async ({
    page,
    request,
  }) => {
    await enableAllCapture(page, engine);
    await bootEngine(page, engine, "expanse");

    // 1) On entry the camera is in the plaza section, so the tracked scene id flips
    //    from the catalog "expanse" to the active sub-area "expanse-plaza" (§5).
    await expect(page.locator("#currentScene")).toHaveText("expanse-plaza");

    // 2) Register scene proxies. For a sectioned scene this scopes one proxy per
    //    section (ADR 0040 §5), not a single whole-world proxy. The button lives in
    //    the controls panel, which boots collapsed.
    await openControls(page);
    await page.locator("#registerProxyButton").click();
    await expect(page.locator("#heatmapStatus")).toContainText(/Registered \d+ section proxies/);

    // 3) Every section the layout declares gets its own stored representation — even
    //    ones the visitor never entered — so each area's world heatmap has a backdrop.
    //    Read-after-write over the embedded store can lag a beat, so poll.
    const sectionIds = [
      "expanse-plaza",
      "expanse-ramp",
      "expanse-overlook",
      "expanse-tower-l2",
      "expanse-gardens",
    ];
    for (const sceneId of sectionIds) {
      let rep: Representation | null = null;
      await expect
        .poll(
          async () => {
            rep = await getRepresentation(request, sceneId);
            return rep?.proxy?.meshCount ?? 0;
          },
          { timeout: 15_000 },
        )
        .toBeGreaterThan(0);
      expect(rep!.bounds, `${sceneId} should have bounds`).not.toBeNull();
    }

    // 4) Each section proxy is scoped to its own geometry, not the whole ~360 × 560
    //    world. The upper tower level frames to the tower footprint (its full-height
    //    corner columns span all floors, so only its X/Z extent is tower-tight)…
    const towerL2 = await getRepresentation(request, "expanse-tower-l2");
    const [minX, , minZ, maxX, , maxZ] = towerL2!.bounds!;
    expect(maxX - minX, "tower L2 is scoped on X, not the whole world").toBeLessThan(200);
    expect(maxZ - minZ, "tower L2 is scoped on Z, not the whole world").toBeLessThan(200);
    // …and an elevated terrace (the overlook, which has no ground-level geometry)
    //    frames above the ground floor instead of dropping to y ≈ 0.
    const overlook = await getRepresentation(request, "expanse-overlook");
    expect(overlook!.bounds![1], "overlook is framed above the ground floor").toBeGreaterThan(5);
    // …while the overview scene (the spawn/plaza area) owns the world-spanning
    //    ground plane and perimeter walls, so a session replay re-driving across the
    //    whole space keeps its floor/walls as orienting context, not floating boxes.
    const plaza = await getRepresentation(request, "expanse-plaza");
    const [pMinX, , pMinZ, pMaxX, , pMaxZ] = plaza!.bounds!;
    expect(
      Math.max(pMaxX - pMinX, pMaxZ - pMinZ),
      "overview scene spans the world (owns the floor + perimeter walls)",
    ).toBeGreaterThan(300);

    // 5) With the (large) section bounds registered, the stats endpoint derives a
    //    coarse cell size from them when `cellSize` is omitted (§1) — an order of
    //    magnitude above the 0.5 fixed default a small scene falls back to.
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
      .toBeGreaterThanOrEqual(3);
  });
}
