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

/** One stored region, as the registry read returns it. */
interface StoredRegion {
  sceneId: string;
  regionId: string;
  label: string;
  description: string | null;
  bounds: [number, number, number, number, number, number];
}

/** One `full` world-heatmap row. */
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

  const stored = await getJson<StoredRegion[]>(
    request,
    `${COLLECTOR_URL}/api/v1/scenes/${scene}/regions`,
  );
  expect(stored.length, "the playground registers two demo regions").toBe(2);

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
    // Labelling ran: all four fields are present on every cluster, `null` where
    // nothing names it (never absent, never a guess).
    expect(cluster, "a labelled cluster carries its region membership").toHaveProperty("regions");
    expect(cluster).toHaveProperty("region");
    expect(cluster).toHaveProperty("nearestMesh");
    expect(cluster).toHaveProperty("distance");
    expect(Array.isArray(cluster.regions)).toBe(true);
    if (cluster.nearestMesh != null) {
      expect(typeof cluster.distance).toBe("number");
      expect(cluster.distance).toBeGreaterThanOrEqual(0);
    } else {
      expect(cluster.distance).toBeNull();
    }
  }

  // 3) Now pin two regions **derived from the captured data** and re-read.
  //
  //    Deriving them (rather than hoping the playground's demo boxes happen to
  //    contain a click, which depends on where the raycasts landed in whatever
  //    scene the engine built) is what makes the containment assertion real: a
  //    hotspot inside a named box MUST come back named, every time. Two nested
  //    boxes, so "every containing region, smallest one reported" is under test:
  //
  //    - `heat-area` — the bounding box of every occupied cell, padded a cell;
  //    - `hotspot`   — one cell either side of the densest cluster's centre,
  //                    strictly inside `heat-area`.
  const cells = await getJson<WorldBin[]>(
    request,
    `${COLLECTOR_URL}/api/v1/heatmaps/world?scene=${scene}&cellSize=${CELL}`,
  );
  expect(cells.length).toBeGreaterThan(0);
  const axis = (pick: (bin: WorldBin) => number, side: "min" | "max"): number => {
    const values = cells.map((bin) => (pick(bin) + 0.5) * CELL);
    return side === "min" ? Math.min(...values) - CELL : Math.max(...values) + CELL;
  };
  const HEAT_AREA: [number, number, number, number, number, number] = [
    axis((b) => b.vx, "min"),
    axis((b) => b.vy, "min"),
    axis((b) => b.vz, "min"),
    axis((b) => b.vx, "max"),
    axis((b) => b.vy, "max"),
    axis((b) => b.vz, "max"),
  ];
  // Clusters come back ordered by weight, so `[0]` is the densest.
  const densest = summary.clusters[0]!;
  const [cx, cy, cz] = densest.centroid.map((index) => (index + 0.5) * CELL) as [
    number,
    number,
    number,
  ];
  const HOTSPOT: [number, number, number, number, number, number] = [
    cx - CELL / 2,
    cy - CELL / 2,
    cz - CELL / 2,
    cx + CELL / 2,
    cy + CELL / 2,
    cz + CELL / 2,
  ];
  // The write replaces the scene's whole set, so the playground's own two regions
  // are resent alongside the derived pair.
  const wrote = await request.put(`${COLLECTOR_URL}/api/v1/scenes/${scene}/regions`, {
    headers: { "x-api-key": API_KEY },
    data: {
      regions: [
        ...stored.map((r) => ({
          id: r.regionId,
          label: r.label,
          bounds: r.bounds,
          ...(r.description != null ? { description: r.description } : {}),
        })),
        { id: "heat-area", label: "Heat area", bounds: HEAT_AREA },
        { id: "hotspot", label: "Hotspot", bounds: HOTSPOT },
      ],
    },
  });
  expect(wrote.status(), await wrote.text()).toBe(200);

  const labelled = await getJson<ClusterSummary>(request, summaryUrl);
  const named = labelled.clusters[0]!;
  // Membership is *every* containing region; both derived boxes contain the
  // densest hotspot by construction.
  expect(named.regions, "the pinned boxes contain the hotspot they were derived from").toEqual(
    expect.arrayContaining(["heat-area", "hotspot"]),
  );
  // `hotspot` is half a cell either side and sits strictly inside `heat-area`;
  // the smaller box by volume is the one reported.
  expect(named.region).toBe("hotspot");
  // The drill hint is now the region **id**, ready to send back as `?region=`.
  expect(named.drill?.region).toBe("hotspot");
  // The reading names the place rather than only a coordinate.
  expect(labelled.reading).toContain("in region `hotspot`");

  // A hint handed straight back really does narrow the query.
  const drilled = await getJson<WorldBin[]>(
    request,
    `${COLLECTOR_URL}/api/v1/heatmaps/world?scene=${scene}&cellSize=${CELL}&region=hotspot`,
  );
  expect(drilled.length).toBeGreaterThan(0);

  // 4) The dashboard's world-heatmap 3D panel wires the same vocabulary into its
  //    hover tooltips. Scoped to the scene, because regions are keyed by scene —
  //    "All scenes" has no single vocabulary to label against.
  //
  //    What is asserted deterministically is the *wiring*: the panel reads the
  //    selected scene's regions, so `voxelHoverLabels` has something to resolve
  //    against, and the Babylon body mounts against real data. The tooltip text
  //    itself is pinned by `@uptimizr/react`'s `spatialLabels` unit suite, which
  //    can check every branch without a GPU; asserting a specific pixel landed on
  //    a thin-instanced voxel in a software-rendered canvas would be a coin flip
  //    (the repo's standing position on 3D output — see `perf-heatmap.spec.ts`).
  //    The hover below is still driven, and its label is checked whenever the
  //    sweep manages to pick a marker.
  const regionsRequest = page.waitForRequest(
    (req) => req.url().includes(`/api/v1/scenes/${scene}/regions`),
    { timeout: 30_000 },
  );
  await page.goto(DASHBOARD_URL);
  await page.getByPlaceholder("http://localhost:4318").fill(COLLECTOR_URL);
  await page.getByPlaceholder("utk_…").fill(API_KEY);
  await page.getByRole("button", { name: /load/i }).click();
  await page.locator('label:has-text("Scene") select').selectOption(scene!);

  // The panel fetches the scene's named boxes — the client-side half of the
  // labelling, and the reason a voxel can be named without a second query shape.
  await regionsRequest;

  const panel = page.locator("section", { hasText: "World heatmap (3D)" }).first();
  await panel.scrollIntoViewIfNeeded();
  const canvas = panel.locator("canvas").first();
  await expect(canvas).toBeVisible({ timeout: 20_000 });

  // Sweep the canvas for a marker. `heat-area` was derived to cover every
  // occupied cell, so any voxel the sweep picks is inside a named region; a
  // sweep that only ever picks the proxy wireframe (or nothing) leaves the
  // tooltip empty, which is not a failure of labelling.
  const box = (await canvas.boundingBox())!;
  const tooltip = panel.locator("div.pointer-events-none.absolute.z-10").first();
  const wanted = /in (Hotspot|Heat area)/;
  let labelText = "";
  for (let i = 0; i < 24 && !wanted.test(labelText); i += 1) {
    const fx = 0.25 + (i % 6) * 0.1;
    const fy = 0.25 + Math.floor(i / 6) * 0.15;
    await page.mouse.move(box.x + box.width * fx, box.y + box.height * fy, { steps: 2 });
    await page.waitForTimeout(80);
    labelText = (await tooltip.textContent().catch(() => "")) ?? "";
  }
  if (labelText.includes("in ")) {
    // A voxel was picked: the tooltip must name the region it falls in, and may
    // also name the mesh — the same labels the summary reports, resolved on the
    // client from the proxy and regions the panel already fetched.
    expect(labelText, "a hovered voxel names the region it falls in").toMatch(wanted);
  }
});
