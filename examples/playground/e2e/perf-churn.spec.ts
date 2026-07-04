import { expect, test, type APIRequestContext, type Page } from "@playwright/test";

import { API_KEY, COLLECTOR_URL, DASHBOARD_URL, PROJECT_ID } from "./constants.js";
import { waitForEventTypes } from "./helpers/capture.js";

/**
 * Full-stack spec for the perf-driven churn overlay (#144).
 *
 * The panel reports a *perf-correlated churn rate*: of the sessions that ended in
 * range, the share that ended shortly after an FPS dip (a `frame_perf` sample
 * below the threshold) or a `compile_stall`, within the configured window. A real
 * headless WebGL run reliably produces neither a sub-30-FPS dip nor a slow compile
 * stall right before an unload, so the correlated case can't be triggered
 * deterministically by driving an engine. Instead we seed one session with a
 * fixed timeline — session_start → low-FPS frame_perf → compile_stall →
 * session_end — via a single batched POST to the public ingest endpoint,
 * exercising the same collector → DuckDB → query API → dashboard path the SDK
 * would. One POST keeps us off the shared ingest rate-limiter (see
 * graphics-diagnostics.spec.ts).
 */

/**
 * Seed a session whose end is preceded — inside the default 30s window — by both a
 * sub-threshold `frame_perf` sample and a slow `compile_stall`, so the churn query
 * attributes it to both causes.
 */
async function seedChurnSession(request: APIRequestContext, sessionId: string): Promise<void> {
  const end = Date.now();
  const baseEvent = {
    projectId: PROJECT_ID,
    sessionId,
    sdkVersion: "0.0.0-e2e",
  };
  const res = await request.post(`${COLLECTOR_URL}/api/v1/collect`, {
    data: {
      events: [
        { ...baseEvent, type: "session_start", ts: end - 10_000 },
        // Low-FPS dip 3s before the end → inside the 30s window, below the 30-FPS threshold.
        { ...baseEvent, type: "frame_perf", ts: end - 3_000, fps: 5 },
        // A 500ms compile stall 2s before the end → at/above the 100ms floor.
        { ...baseEvent, type: "compile_stall", ts: end - 2_000, durationMs: 500, phase: "shader" },
        { ...baseEvent, type: "session_end", ts: end, reason: "hidden", durationMs: 10_000 },
      ],
    },
  });
  expect(
    res.ok(),
    `seeding churn session should succeed (got ${res.status()}: ${await res.text()})`,
  ).toBeTruthy();
}

/** Open the dashboard pointed at the e2e collector and load the data. */
async function loadDashboard(page: Page): Promise<void> {
  await page.goto(DASHBOARD_URL);
  await page.getByPlaceholder("http://localhost:4318").fill(COLLECTOR_URL);
  await page.getByPlaceholder("utk_…").fill(API_KEY);
  await page.getByRole("button", { name: /load/i }).click();
}

test("perf-driven churn panel correlates a perf dip with the seeded session's early end", async ({
  page,
  request,
}) => {
  const sessionId = `e2e-churn-${Date.now()}`;
  await seedChurnSession(request, sessionId);
  await waitForEventTypes(request, sessionId, [
    "session_start",
    "frame_perf",
    "compile_stall",
    "session_end",
  ]);

  await loadDashboard(page);

  const panel = page
    .locator("section")
    .filter({ has: page.getByRole("heading", { name: "Perf-driven churn" }) })
    .last();
  await expect(panel.getByRole("heading", { name: "Perf-driven churn" })).toBeVisible({
    timeout: 20_000,
  });

  // The headline stats render (the seeded session guarantees at least one ended,
  // churned session), so the empty state must be gone.
  await expect(panel.getByText("No ended sessions in range.")).toHaveCount(0);
  await expect(panel.getByText("Perf-correlated churn", { exact: true })).toBeVisible();
  await expect(panel.getByText("Ended sessions", { exact: true })).toBeVisible();

  // Both cause bars render: the seeded session was hit by a low-FPS dip AND a stall.
  await expect(panel.getByText("Churn by cause", { exact: true })).toBeVisible();
  await expect(panel.getByText("FPS dip", { exact: true })).toBeVisible();
  await expect(panel.getByText("Compile stall", { exact: true })).toBeVisible();
});
