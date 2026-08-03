import { expect, test, type APIRequestContext, type Page } from "@playwright/test";

import { API_KEY, COLLECTOR_URL, DASHBOARD_URL, PROJECT_ID } from "./constants.js";
import { waitForEventTypes } from "./helpers/capture.js";

/**
 * Full-stack spec for the AR placement funnel panel (#156, ADR 0048).
 *
 * The panel reads retail "view in your room" placement friction from
 * `ar_placement` settles — time-to-place distribution, re-placement (attempts)
 * distribution, and coarse surface breakdown. A real headless WebGL run can't
 * enter an immersive AR session with hit-testing, so the settles are seeded by a
 * single batched POST straight to the public ingest endpoint, exercising the same
 * collector → DuckDB → query API → dashboard path the SDK's
 * `babylonArPlacementCollector` would. We seed a mix of surfaces, attempt counts,
 * and time-to-place buckets across two sessions.
 */

/** Seed `ar_placement` settle events via the public ingest API. */
async function seedPlacements(request: APIRequestContext): Promise<void> {
  const now = Date.now();
  const base = { projectId: PROJECT_ID, sdkVersion: "0.0.0-e2e", sceneId: "showroom" };
  const placement = (
    sessionId: string,
    ts: number,
    opts: {
      mesh: string;
      position: [number, number, number];
      surface: "floor" | "wall" | "table" | "ceiling" | "unknown";
      attempts: number;
      timeToPlaceMs: number;
      scale: number;
      final: boolean;
    },
  ) => ({
    ...base,
    type: "ar_placement" as const,
    sessionId,
    ts,
    ...opts,
  });

  const events = [
    // ar-1: placed a sofa on the floor after one re-placement, quick settle.
    placement("ar-1", now - 20_000, {
      mesh: "Sofa",
      position: [1, 0, 2],
      surface: "floor",
      attempts: 1,
      timeToPlaceMs: 1_500,
      scale: 1,
      final: false,
    }),
    placement("ar-1", now - 12_000, {
      mesh: "Sofa",
      position: [1.2, 0, 2.1],
      surface: "floor",
      attempts: 2,
      timeToPlaceMs: 6_200,
      scale: 0.8,
      final: true,
    }),
    // ar-2: hung a picture on the wall after several tries, slow settle, enlarged.
    placement("ar-2", now - 8_000, {
      mesh: "Picture",
      position: [-2, 1.4, 0],
      surface: "wall",
      attempts: 3,
      timeToPlaceMs: 9_800,
      scale: 1.25,
      final: true,
    }),
    // ar-2: a lamp settled on a table on the first try.
    placement("ar-2", now - 4_000, {
      mesh: "Lamp",
      position: [0.5, 0.75, 0.5],
      surface: "table",
      attempts: 1,
      timeToPlaceMs: 2_100,
      scale: 1,
      final: false,
    }),
  ];

  const res = await request.post(`${COLLECTOR_URL}/api/v1/collect`, {
    data: { events },
  });
  expect(
    res.ok(),
    `seeding ar_placement should succeed (got ${res.status()}: ${await res.text()})`,
  ).toBeTruthy();
}

/** Open the dashboard pointed at the e2e collector and load the data. */
async function loadDashboard(page: Page): Promise<void> {
  await page.goto(DASHBOARD_URL);
  await page.getByPlaceholder("http://localhost:4318").fill(COLLECTOR_URL);
  await page.getByPlaceholder("utk_…").fill(API_KEY);
  await page.getByRole("button", { name: /load/i }).click();
}

test("AR placement funnel panel renders the seeded placement friction", async ({
  page,
  request,
}) => {
  await seedPlacements(request);
  await waitForEventTypes(request, "ar-1", ["ar_placement"]);
  await loadDashboard(page);

  const panel = page
    .locator("section")
    .filter({ has: page.getByRole("heading", { name: "AR placement funnel" }) })
    .last();
  await expect(panel.getByRole("heading", { name: "AR placement funnel" })).toBeVisible({
    timeout: 20_000,
  });

  // All three sub-sections render (not the empty state).
  await expect(panel.getByText("Time to place", { exact: true })).toBeVisible();
  await expect(panel.getByText("Re-placement attempts", { exact: true })).toBeVisible();
  await expect(panel.getByText("Surface breakdown (× avg scale)", { exact: true })).toBeVisible();

  // The seeded surfaces show up in the breakdown.
  await expect(panel.getByText("floor", { exact: true })).toBeVisible();
  await expect(panel.getByText("wall", { exact: true })).toBeVisible();
  await expect(panel.getByText("table", { exact: true })).toBeVisible();
});
