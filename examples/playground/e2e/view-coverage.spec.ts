import { expect, test, type APIRequestContext, type Page } from "@playwright/test";

import { API_KEY, COLLECTOR_URL, DASHBOARD_URL, PROJECT_ID } from "./constants.js";
import { waitForEventTypes } from "./helpers/capture.js";

/**
 * Full-stack spec for the 360° view-coverage gauge (#146). The coverage
 * histogram is derived entirely from the `camera_sample` direction stream, so we
 * seed camera samples straight to the public ingest endpoint — exercising the
 * same collector → DuckDB → query API → dashboard path the SDK would — rather
 * than driving full engine sessions, which would flood the shared ingest
 * rate-limiter and starve sibling specs.
 *
 * With the dashboard's default 36×36 dome grid a handful of samples covers only a
 * sliver of the sphere, so the seeded session lands in the bottom (<25%) band —
 * exactly the "they barely looked around" signal the panel exists to surface. The
 * bucket-boundary maths (25/50/75/100%) is covered exhaustively by the
 * `@uptimizr/db` unit test; here we assert the real round trip renders the panel
 * with data instead of its empty state.
 */
async function seedCameraSamples(request: APIRequestContext, sessionId: string): Promise<void> {
  const now = Date.now();
  // A spread of forward directions around the horizon so the session visits
  // several distinct dome cells (still a small fraction of the 36×36 grid).
  const events = Array.from({ length: 24 }, (_, i) => {
    const a = (i / 24) * Math.PI * 2;
    return {
      type: "camera_sample" as const,
      projectId: PROJECT_ID,
      sessionId,
      sdkVersion: "0.0.0-e2e",
      ts: now + i,
      position: [0, 0, 0] as [number, number, number],
      direction: [Math.cos(a), Math.sin(a) * 0.3, Math.sin(a)] as [number, number, number],
    };
  });
  const res = await request.post(`${COLLECTOR_URL}/api/v1/collect`, { data: { events } });
  expect(
    res.ok(),
    `seeding camera samples should succeed (got ${res.status()}: ${await res.text()})`,
  ).toBeTruthy();
}

async function loadDashboard(page: Page): Promise<void> {
  await page.goto(DASHBOARD_URL);
  await page.getByPlaceholder("http://localhost:4318").fill(COLLECTOR_URL);
  await page.getByPlaceholder("utk_…").fill(API_KEY);
  await page.getByRole("button", { name: /load/i }).click();
}

test("view-coverage panel renders the per-session coverage histogram", async ({
  page,
  request,
}) => {
  const sessionId = `e2e-coverage-${Date.now()}`;
  await seedCameraSamples(request, sessionId);
  await waitForEventTypes(request, sessionId, ["camera_sample"]);

  await loadDashboard(page);

  const panel = page
    .locator("section")
    .filter({ has: page.getByRole("heading", { name: "View coverage" }) })
    .last();
  await expect(panel.getByRole("heading", { name: "View coverage" })).toBeVisible({
    timeout: 20_000,
  });

  // The headline stat and the four fixed coverage bands are present with data,
  // not the empty state.
  await expect(panel.getByText("Sessions that saw <25% of the object")).toBeVisible();
  await expect(panel.getByText("0–25%", { exact: true })).toBeVisible();
  await expect(panel.getByText("75–100%", { exact: true })).toBeVisible();
  await expect(panel.getByText("No view-direction samples in range.")).toHaveCount(0);
});
