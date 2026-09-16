import { expect, test, type APIRequestContext, type Page } from "@playwright/test";

import { API_KEY, COLLECTOR_URL } from "./constants.js";
import {
  bootEngine,
  enableAllCapture,
  openControls,
  waitForEventTypes,
} from "./helpers/capture.js";

/**
 * Scene **regions** (ADR 0051 §2 / sketch §B.2) end to end.
 *
 * Regions give a scene a shared vocabulary for *where* — named, labelled boxes
 * ("the whole scene", "the near half") that humans and agents can talk about and
 * that a spatial query can be drilled into by name. This spec drives the real
 * full-stack path the unit tests can only approximate:
 *
 * 1. The playground registers two regions from its live scene through the SDK
 *    helper `registerRegions` (browser → `PUT /api/v1/scenes/:id/regions` →
 *    DuckDB), with the same transport/auth the scene-proxy upload uses.
 * 2. `GET /api/v1/scenes/:id/regions` returns both, with their labels and boxes,
 *    and the project-wide listing sees them.
 * 3. A spatial endpoint filtered with `region=<id>` returns a **subset** of the
 *    unfiltered result — the registry id really is resolved to the stored box and
 *    applied — while an unknown region id is a `400`, never a silently empty map.
 */

interface StoredRegion {
  sceneId: string;
  regionId: string;
  label: string;
  description: string | null;
  bounds: [number, number, number, number, number, number];
}

interface WorldBin {
  vx: number;
  vy: number;
  vz: number;
  count: number;
}

async function getJson<T>(request: APIRequestContext, url: string): Promise<T> {
  const res = await request.get(url, { headers: { "x-api-key": API_KEY } });
  expect(res.ok(), `${url} should succeed (got ${res.status()}: ${await res.text()})`).toBeTruthy();
  return (await res.json()) as T;
}

/** Click the canvas a few times so the world heatmap has raycast hits to bin. */
async function clickAround(page: Page): Promise<void> {
  const { width, height } = page.viewportSize() ?? { width: 1280, height: 720 };
  for (const [fx, fy] of [
    [0.5, 0.52],
    [0.46, 0.55],
    [0.54, 0.5],
  ] as const) {
    const x = Math.round(width * fx);
    const y = Math.round(height * fy);
    await page.mouse.move(x, y, { steps: 4 });
    await page.mouse.click(x, y);
  }
}

test("playground registers scene regions and filters a spatial query by region id", async ({
  page,
  request,
}) => {
  await enableAllCapture(page, "babylon");
  const sessionId = await bootEngine(page, "babylon");
  const scene = (await page.locator("#currentScene").textContent())?.trim();
  expect(scene, "a scene id should be stamped").toBeTruthy();

  // 1) Register the scene proxy (the regions are derived from the scene's world
  //    bounds), then the regions themselves — both from the playground UI, so the
  //    SDK helper runs in a real browser against the real collector.
  await openControls(page);
  await page.locator("#registerProxyButton").click();
  await expect(page.locator("#heatmapStatus")).toContainText(/Registered proxy|section proxies/);
  await page.locator("#registerRegionsButton").click();
  await expect(page.locator("#heatmapStatus")).toContainText(/Registered 2 regions/);

  // 2) Both regions round-trip through the collector's registry read.
  let stored: StoredRegion[] = [];
  await expect
    .poll(
      async () => {
        stored = await getJson<StoredRegion[]>(
          request,
          `${COLLECTOR_URL}/api/v1/scenes/${scene}/regions`,
        );
        return stored.length;
      },
      { timeout: 15_000 },
    )
    .toBe(2);

  const byId = new Map(stored.map((r) => [r.regionId, r]));
  expect([...byId.keys()].sort()).toEqual(["near-half", "whole-scene"]);
  expect(byId.get("whole-scene")?.label).toBe("Whole scene");
  expect(byId.get("near-half")?.label).toBe("Near half");
  expect(byId.get("near-half")?.description).toContain("lower half");
  for (const region of stored) {
    expect(region.sceneId).toBe(scene);
    expect(region.bounds, `${region.regionId} should carry a 6-number box`).toHaveLength(6);
  }
  // The near half really is a sub-box of the whole scene on X.
  const whole = byId.get("whole-scene")!.bounds;
  const near = byId.get("near-half")!.bounds;
  expect(near[0]).toBe(whole[0]);
  expect(near[3]).toBeLessThanOrEqual(whole[3]);

  // The project-wide listing sees them too (names only, no boxes).
  const listed = await getJson<Array<{ sceneId: string; regionId: string; label: string }>>(
    request,
    `${COLLECTOR_URL}/api/v1/scene-regions`,
  );
  expect(
    listed
      .filter((r) => r.sceneId === scene)
      .map((r) => r.regionId)
      .sort(),
  ).toEqual(["near-half", "whole-scene"]);

  // 3) Produce world-space hits, then check that `region=<id>` narrows the query.
  //    `cellSize` is pinned so both requests bin identically (an unpinned cell
  //    size is derived from the extent, which differs between the whole scene and
  //    half of it).
  await clickAround(page);
  await waitForEventTypes(request, sessionId, ["pointer_click"]);

  const CELL = 0.5;
  const base = `${COLLECTOR_URL}/api/v1/heatmaps/world?scene=${scene}&cellSize=${CELL}`;
  const unfiltered = await getJson<WorldBin[]>(request, base);
  const filtered = await getJson<WorldBin[]>(request, `${base}&region=near-half`);
  expect(
    filtered.length,
    "a region-filtered heatmap is a subset of the unfiltered one",
  ).toBeLessThanOrEqual(unfiltered.length);
  // Every returned cell lies inside the region's box on X. `vx` is a voxel
  // *index* (`floor(x / cellSize)`), so scale it back to world units; one cell
  // of slack covers the cell straddling the boundary.
  for (const bin of filtered) {
    expect(bin.vx * CELL).toBeGreaterThanOrEqual(near[0] - CELL);
    expect(bin.vx * CELL).toBeLessThanOrEqual(near[3] + CELL);
  }
  // The whole-scene region is the widest filter, so it sits between the two.
  const wholeFiltered = await getJson<WorldBin[]>(request, `${base}&region=whole-scene`);
  expect(wholeFiltered.length).toBeGreaterThanOrEqual(filtered.length);
  expect(wholeFiltered.length).toBeLessThanOrEqual(unfiltered.length);

  // 4) A region id that was never registered is a client error, so an agent is
  //    never told "no activity here" because it misspelt the place.
  const unknown = await request.get(`${base}&region=not-a-region`, {
    headers: { "x-api-key": API_KEY },
  });
  expect(unknown.status()).toBe(400);
  expect(await unknown.text()).toContain("unknown region");
});
