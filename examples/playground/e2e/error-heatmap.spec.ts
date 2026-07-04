import { expect, test, type APIRequestContext, type Page } from "@playwright/test";

import { API_KEY, COLLECTOR_URL, DASHBOARD_URL, PROJECT_ID } from "./constants.js";
import { waitForEventTypes } from "./helpers/capture.js";

/**
 * Full-stack spec for the spatial error heatmap (#154).
 *
 * Both `runtime_error` and `graphics_diagnostic` can carry an optional, best-effort
 * `position` (the camera pose when they fired). Positioned events voxel-bin into the
 * new `GET /api/v1/heatmaps/errors` read model and the dashboard's **Error heatmap
 * (3D)** panel — revealing *where* in the scene things break, not just *when*.
 *
 * We can't deterministically trigger a real WebGPU device loss or an uncaught error
 * at a chosen world position in the headless WebGL runner, so the positioned events
 * are seeded by a single batched POST straight to the collector's public ingest
 * endpoint — exercising the same collector → DuckDB → query API → dashboard path the
 * SDK would. As with the diagnostics spec we keep seeding to one POST so we don't
 * flood the shared ingest rate-limiter and starve sibling specs.
 */

/** World position two positioned events share -> same voxel (2,0,3) at cellSize 1. */
const HOTSPOT: [number, number, number] = [2.3, 0.4, 3.1];
/** A lone error in a different voxel (10,0,0). */
const OUTLIER: [number, number, number] = [10.1, 0, 0.2];

/** Seed positioned runtime_error + graphics_diagnostic events via the ingest API. */
async function seedPositionedErrors(request: APIRequestContext, sessionId: string): Promise<void> {
  const now = Date.now();
  const base = { projectId: PROJECT_ID, sessionId, sdkVersion: "0.0.0-e2e" };
  const res = await request.post(`${COLLECTOR_URL}/api/v1/collect`, {
    data: {
      events: [
        // A positioned JS error and an engine diagnostic in the SAME voxel — they
        // must aggregate together in the heatmap (count 2 at voxel (2,0,3)).
        {
          ...base,
          type: "runtime_error",
          ts: now,
          kind: "error",
          message: "boom at the hotspot",
          position: HOTSPOT,
        },
        {
          ...base,
          type: "graphics_diagnostic",
          ts: now + 1,
          severity: "error",
          category: "shader-compile",
          backend: "webgl2",
          position: HOTSPOT,
        },
        // A lone error in a different voxel.
        {
          ...base,
          type: "runtime_error",
          ts: now + 2,
          kind: "error",
          message: "boom elsewhere",
          position: OUTLIER,
        },
        // An error with NO position must be excluded from the spatial heatmap.
        {
          ...base,
          type: "runtime_error",
          ts: now + 3,
          kind: "error",
          message: "boom nowhere",
        },
      ],
    },
  });
  expect(
    res.ok(),
    `seeding positioned errors should succeed (got ${res.status()}: ${await res.text()})`,
  ).toBeTruthy();
}

interface HeatmapVoxel {
  vx: number;
  vy: number;
  vz: number;
  count: number;
}

/** Query the error-heatmap read model, honouring the read rate-limiter. */
async function readErrorHeatmap(
  request: APIRequestContext,
  query: string,
): Promise<HeatmapVoxel[]> {
  for (let attempt = 0; ; attempt++) {
    const res = await request.get(`${COLLECTOR_URL}/api/v1/heatmaps/errors?${query}`, {
      headers: { "x-api-key": API_KEY },
    });
    if (res.status() === 429 && attempt < 5) {
      const retryAfter = Number(res.headers()["retry-after"]);
      await new Promise((r) =>
        setTimeout(r, Number.isFinite(retryAfter) ? retryAfter * 1000 : 2000),
      );
      continue;
    }
    expect(
      res.ok(),
      `error-heatmap read should succeed (got ${res.status()}: ${await res.text()})`,
    ).toBeTruthy();
    return (await res.json()) as HeatmapVoxel[];
  }
}

const voxel = (rows: HeatmapVoxel[], vx: number, vy: number, vz: number) =>
  rows.find((r) => Number(r.vx) === vx && Number(r.vy) === vy && Number(r.vz) === vz);

test("error heatmap bins positioned runtime_error + graphics_diagnostic across the full stack (#154)", async ({
  request,
}) => {
  const sessionId = `e2e-errheat-${Date.now()}`;
  await seedPositionedErrors(request, sessionId);
  await waitForEventTypes(request, sessionId, ["runtime_error", "graphics_diagnostic"]);

  // Unfiltered: both HOTSPOT events fold into voxel (2,0,3); the OUTLIER sits at
  // (10,0,0). The position-less error is excluded.
  const all = await readErrorHeatmap(request, "cellSize=1");
  expect(voxel(all, 2, 0, 3)?.count).toBe(2);
  expect(voxel(all, 10, 0, 0)?.count).toBe(1);
  // No voxel accounts for the position-less error (3 positioned hits total).
  expect(all.reduce((n, r) => n + Number(r.count), 0)).toBe(3);

  // A category filter narrows to the engine diagnostic only (one hit at the hotspot).
  const diagnostics = await readErrorHeatmap(request, "cellSize=1&category=shader-compile");
  expect(diagnostics.reduce((n, r) => n + Number(r.count), 0)).toBe(1);
  expect(voxel(diagnostics, 2, 0, 3)?.count).toBe(1);

  // An errorKind filter narrows to the JS runtime errors (hotspot + outlier).
  const errors = await readErrorHeatmap(request, "cellSize=1&errorKind=error");
  expect(errors.reduce((n, r) => n + Number(r.count), 0)).toBe(2);
});

test("dashboard renders the Error heatmap (3D) panel", async ({ page, request }) => {
  const sessionId = `e2e-errheat-panel-${Date.now()}`;
  await seedPositionedErrors(request, sessionId);
  await waitForEventTypes(request, sessionId, ["runtime_error", "graphics_diagnostic"]);

  await loadDashboard(page);

  const panel = page
    .locator("section")
    .filter({ has: page.getByRole("heading", { name: "Error heatmap (3D)" }) })
    .last();
  await expect(panel.getByRole("heading", { name: "Error heatmap (3D)" })).toBeVisible({
    timeout: 20_000,
  });
});

/** Open the dashboard pointed at the e2e collector and load the data. */
async function loadDashboard(page: Page): Promise<void> {
  await page.goto(DASHBOARD_URL);
  await page.getByPlaceholder("http://localhost:4318").fill(COLLECTOR_URL);
  await page.getByPlaceholder("utk_…").fill(API_KEY);
  await page.getByRole("button", { name: /load/i }).click();
}
