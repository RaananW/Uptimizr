import { expect, test, type APIRequestContext, type Page } from "@playwright/test";

import { API_KEY, COLLECTOR_URL, DASHBOARD_URL, PROJECT_ID } from "./constants.js";
import { waitForEventTypes } from "./helpers/capture.js";

/**
 * Full-stack spec for the guardian / boundary-touch spatial analytics (#157, ADR 0048).
 *
 * `xr_boundary_proximity` is emitted entirely on-device when a room-scale headset
 * comes within a near threshold of its play-space boundary — one event per approach,
 * carrying only a coarse voxel-binnable `position` and a `durationMs`. The boundary
 * polygon / room geometry is *never* transmitted. Positioned approaches voxel-bin into
 * `GET /api/v1/heatmaps/boundary` (the dashboard's **Guardian boundary heatmap (3D)**
 * panel, reusing the world-heatmap render path), and per-session approach counts roll up
 * via `GET /api/v1/xr/boundary-contacts` (the **Guardian boundary contacts** comfort panel).
 *
 * A headless WebGL runner can't enter an immersive room-scale XR session, so the events are
 * seeded by a single batched POST straight to the collector's public ingest endpoint —
 * exercising the same collector → DuckDB → query API → dashboard path the SDK would. We keep
 * seeding to one POST so we don't flood the shared ingest rate-limiter and starve sibling specs.
 */

/** World position two approaches share -> same voxel (2,0,3) at cellSize 1. */
const HOTSPOT: [number, number, number] = [2.3, 0.4, 3.1];
/** A lone approach in a different voxel (10,0,0). */
const OUTLIER: [number, number, number] = [10.1, 0, 0.2];

const HEAVY_SESSION = "xr-room-heavy";
const LIGHT_SESSION = "xr-room-light";

/** Seed on-device boundary-proximity approaches via the public ingest API. */
async function seedBoundaryApproaches(request: APIRequestContext): Promise<void> {
  const now = Date.now();
  const base = { projectId: PROJECT_ID, sdkVersion: "0.0.0-e2e", sceneId: "arena" };
  const approach = (
    sessionId: string,
    ts: number,
    position: [number, number, number],
    durationMs: number,
  ) => ({
    ...base,
    type: "xr_boundary_proximity" as const,
    sessionId,
    ts,
    position,
    durationMs,
  });

  const events = [
    // xr-room-heavy: three approaches — two fold into the hotspot voxel, one is the outlier.
    approach(HEAVY_SESSION, now - 8_000, HOTSPOT, 1500),
    approach(HEAVY_SESSION, now - 5_000, HOTSPOT, 1200),
    approach(HEAVY_SESSION, now - 2_000, OUTLIER, 800),
    // xr-room-light: a single approach at the hotspot.
    approach(LIGHT_SESSION, now - 3_000, HOTSPOT, 600),
  ];

  const res = await request.post(`${COLLECTOR_URL}/api/v1/collect`, {
    data: { events },
  });
  expect(
    res.ok(),
    `seeding boundary approaches should succeed (got ${res.status()}: ${await res.text()})`,
  ).toBeTruthy();
}

interface HeatmapVoxel {
  vx: number;
  vy: number;
  vz: number;
  count: number;
}

interface BoundaryContactRow {
  session_id: string;
  contacts: number;
  near_ms: number;
}

/** GET a collector read model, honouring the read rate-limiter. */
async function readModel<T>(request: APIRequestContext, path: string): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    const res = await request.get(`${COLLECTOR_URL}${path}`, {
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
      `read ${path} should succeed (got ${res.status()}: ${await res.text()})`,
    ).toBeTruthy();
    return (await res.json()) as T;
  }
}

const voxel = (rows: HeatmapVoxel[], vx: number, vy: number, vz: number) =>
  rows.find((r) => Number(r.vx) === vx && Number(r.vy) === vy && Number(r.vz) === vz);

test("boundary heatmap + contacts bin xr_boundary_proximity across the full stack (#157)", async ({
  request,
}) => {
  await seedBoundaryApproaches(request);
  await waitForEventTypes(request, HEAVY_SESSION, ["xr_boundary_proximity"]);
  await waitForEventTypes(request, LIGHT_SESSION, ["xr_boundary_proximity"]);

  // Heatmap: both hotspot approaches (heavy) + the light approach fold into voxel (2,0,3);
  // the outlier sits at (10,0,0). Four positioned approaches total.
  const heatmap = await readModel<HeatmapVoxel[]>(request, "/api/v1/heatmaps/boundary?cellSize=1");
  expect(voxel(heatmap, 2, 0, 3)?.count).toBe(3);
  expect(voxel(heatmap, 10, 0, 0)?.count).toBe(1);
  expect(heatmap.reduce((n, r) => n + Number(r.count), 0)).toBe(4);

  // Stats: two occupied voxels, four total contacts.
  const stats = await readModel<{ cellSize: number; cells: number; hits: number }>(
    request,
    "/api/v1/heatmaps/boundary/stats?cellSize=1",
  );
  expect(Number(stats.cells)).toBe(2);
  expect(Number(stats.hits)).toBe(4);

  // Contacts: per-session approach counts + summed near-zone time (durationMs).
  const contacts = await readModel<BoundaryContactRow[]>(request, "/api/v1/xr/boundary-contacts");
  const heavy = contacts.find((r) => r.session_id === HEAVY_SESSION);
  const light = contacts.find((r) => r.session_id === LIGHT_SESSION);
  expect(Number(heavy?.contacts)).toBe(3);
  expect(Number(heavy?.near_ms)).toBe(3500);
  expect(Number(light?.contacts)).toBe(1);
  expect(Number(light?.near_ms)).toBe(600);
});

test("dashboard renders the guardian boundary heatmap + contacts panels (#157)", async ({
  page,
  request,
}) => {
  await seedBoundaryApproaches(request);
  await waitForEventTypes(request, HEAVY_SESSION, ["xr_boundary_proximity"]);

  await loadDashboard(page);

  const heatmapPanel = page
    .locator("section")
    .filter({ has: page.getByRole("heading", { name: "Guardian boundary heatmap (3D)" }) })
    .last();
  await expect(
    heatmapPanel.getByRole("heading", { name: "Guardian boundary heatmap (3D)" }),
  ).toBeVisible({ timeout: 20_000 });

  const contactsPanel = page
    .locator("section")
    .filter({ has: page.getByRole("heading", { name: "Guardian boundary contacts" }) })
    .last();
  await expect(
    contactsPanel.getByRole("heading", { name: "Guardian boundary contacts" }),
  ).toBeVisible({ timeout: 20_000 });
  // The seeded approaches populate the summary (not the empty state).
  await expect(contactsPanel.getByText("Contacts", { exact: true })).toBeVisible();
  await expect(contactsPanel.getByText("Sessions", { exact: true })).toBeVisible();
});

/** Open the dashboard pointed at the e2e collector and load the data. */
async function loadDashboard(page: Page): Promise<void> {
  await page.goto(DASHBOARD_URL);
  await page.getByPlaceholder("http://localhost:4318").fill(COLLECTOR_URL);
  await page.getByPlaceholder("utk_…").fill(API_KEY);
  await page.getByRole("button", { name: /load/i }).click();
}
