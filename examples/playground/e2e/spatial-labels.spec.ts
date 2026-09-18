import { expect, test, type APIRequestContext, type Page } from "@playwright/test";

import { API_KEY, COLLECTOR_URL, DASHBOARD_URL } from "./constants.js";
import {
  bootEngine,
  enableAllCapture,
  openControls,
  waitForEventTypes,
} from "./helpers/capture.js";

/**
 * Spatial **labelling** (#302, ADR 0051 §2 / sketch §B.2) end to end.
 *
 * A hotspot at voxel `(7, 2, 11)` is unreadable. Once a scene has a registered
 * proxy and named regions, the same hotspot can be described in the developer's
 * own words — "on `ground`, in region `near-half`" — and that is what this spec
 * drives, through the real browser → SDK → collector → dashboard path:
 *
 * 1. the playground registers its proxy and its regions from the live scene, and
 *    real clicks produce world-space hits;
 * 2. `GET /api/v1/heatmaps/world?format=summary` returns clusters that carry
 *    `region`, `regions`, `nearestMesh` and `distance`, a `drill.region` hint
 *    that is the **region id** (so it can be sent straight back as `?region=`),
 *    and a `reading` sentence that names the place;
 * 3. the dashboard's world-heatmap 3D panel, scoped to that scene, shows the
 *    same vocabulary in its hover tooltip — the labels are resolved client-side
 *    from the proxy and regions the panel already fetched.
 */

interface LabelledCluster {
  centroid: number[];
  weight: number;
  region: string | null;
  regions: string[];
  nearestMesh: string | null;
  distance: number | null;
  drill?: Record<string, string>;
}

interface ClusterSummary {
  kind: string;
  axes: string[];
  clusters: LabelledCluster[];
  reading: string;
  caveats: string[];
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
    [0.48, 0.53],
    [0.52, 0.51],
    [0.5, 0.5],
  ] as const) {
    const x = Math.round(width * fx);
    const y = Math.round(height * fy);
    await page.mouse.move(x, y, { steps: 4 });
    await page.mouse.click(x, y);
  }
}

test("a summarised world heatmap names its hotspots, and the 3D panel shows the labels", async ({
  page,
  request,
}) => {
  await enableAllCapture(page, "babylon");
  const sessionId = await bootEngine(page, "babylon");
  const scene = (await page.locator("#currentScene").textContent())?.trim();
  expect(scene, "a scene id should be stamped").toBeTruthy();

  // 1) Register the geometry labelling reads: the proxy (mesh boxes) and the
  //    regions (named places), both from the playground UI through the SDK.
  await openControls(page);
  await page.locator("#registerProxyButton").click();
  await expect(page.locator("#heatmapStatus")).toContainText(/Registered proxy|section proxies/);
  await page.locator("#registerRegionsButton").click();
  await expect(page.locator("#heatmapStatus")).toContainText(/Registered 2 regions/);

  await clickAround(page);
  await waitForEventTypes(request, sessionId, ["pointer_click"]);

  // 2) The summary envelope carries the labels.
  const CELL = 0.5;
  const summaryUrl = `${COLLECTOR_URL}/api/v1/heatmaps/world?scene=${scene}&cellSize=${CELL}&format=summary`;
  let summary: ClusterSummary = { kind: "", axes: [], clusters: [], reading: "", caveats: [] };
  await expect
    .poll(
      async () => {
        summary = await getJson<ClusterSummary>(request, summaryUrl);
        return summary.clusters.length;
      },
      { timeout: 20_000 },
    )
    .toBeGreaterThan(0);

  expect(summary.kind).toBe("clusters");
  expect(summary.axes).toEqual(["vx", "vy", "vz"]);
  for (const cluster of summary.clusters) {
    // Labelling ran: the fields are present, and `regions` lists every box the
    // hotspot falls in. The playground's `whole-scene` region covers the scene,
    // so every cluster the clicks produced is inside at least one.
    expect(cluster, "a labelled cluster carries its region membership").toHaveProperty("regions");
    expect(cluster).toHaveProperty("nearestMesh");
    expect(cluster).toHaveProperty("distance");
    expect(cluster.regions).toContain("whole-scene");
    // The reported region is the smallest containing one.
    expect(["whole-scene", "near-half"]).toContain(cluster.region);
    // The drill hint is now a region **id**, ready to send back as `?region=`.
    expect(cluster.drill?.region).toBe(cluster.region);
    if (cluster.nearestMesh != null) {
      expect(typeof cluster.distance).toBe("number");
      expect(cluster.distance).toBeGreaterThanOrEqual(0);
    }
  }

  // The reading names the place rather than only a coordinate.
  expect(summary.reading).toMatch(/in region `(whole-scene|near-half)`/);

  // A hint handed straight back really does narrow the query.
  const densest = summary.clusters[0]!;
  const drilled = await request.get(
    `${COLLECTOR_URL}/api/v1/heatmaps/world?scene=${scene}&cellSize=${CELL}&region=${densest.drill?.region}`,
    { headers: { "x-api-key": API_KEY } },
  );
  expect(drilled.status(), await drilled.text()).toBe(200);

  // 3) The dashboard's 3D panel shows the same vocabulary on hover. Scoped to the
  //    scene, because regions are keyed by scene — "All scenes" has no single
  //    vocabulary to label against.
  await page.goto(DASHBOARD_URL);
  await page.getByPlaceholder("http://localhost:4318").fill(COLLECTOR_URL);
  await page.getByPlaceholder("utk_…").fill(API_KEY);
  await page.getByRole("button", { name: /load/i }).click();
  await page.locator('label:has-text("Scene") select').selectOption(scene!);

  const panel = page.locator("section", { hasText: "World heatmap (3D)" }).first();
  await panel.scrollIntoViewIfNeeded();
  const canvas = panel.locator("canvas").first();
  await expect(canvas).toBeVisible({ timeout: 30_000 });

  // Sweep the canvas until a marker is picked. Thin-instanced voxels are small,
  // so a single hover is a coin flip; the sweep is the reliable way to land one.
  const box = (await canvas.boundingBox())!;
  const tooltip = panel.locator("div.pointer-events-none.absolute.z-10").first();
  let labelText = "";
  for (let i = 0; i < 40 && !/in (Whole scene|Near half)/.test(labelText); i += 1) {
    const fx = 0.25 + (i % 8) * 0.0714;
    const fy = 0.25 + Math.floor(i / 8) * 0.125;
    await page.mouse.move(box.x + box.width * fx, box.y + box.height * fy, { steps: 2 });
    await page.waitForTimeout(120);
    labelText = (await tooltip.textContent().catch(() => "")) ?? "";
  }
  // The tooltip names the region (and, where a box is close enough, the mesh) —
  // the same labels the summary reports, resolved on the client.
  expect(labelText, "a hovered voxel should name the region it falls in").toMatch(
    /in (Whole scene|Near half)/,
  );
});
