import { expect, test, type APIRequestContext, type Page } from "@playwright/test";

import { API_KEY, COLLECTOR_URL, DASHBOARD_URL, PROJECT_ID } from "./constants.js";
import { waitForEventTypes } from "./helpers/capture.js";

/**
 * Full-stack spec for the tracking-quality panel (#155, ADR 0048).
 *
 * The panel reads XR tracking degradation from the existing `capability_change`
 * event's new `"tracking"` kind — no new event type, no DB migration. Each
 * completed degraded episode carries its length in the shared `visible_ms`
 * column (via the event's `durationMs`) and the `source` that degraded. A real
 * headless WebGL run can't enter an immersive XR session and lose tracking, so
 * the transitions are seeded by a single batched POST straight to the public
 * ingest endpoint, exercising the same collector → DuckDB → query API →
 * dashboard path the SDK would. We seed a hand-tracking session that loses
 * tracking twice, a controller session that loses it once, and a clean XR
 * session that never degrades (and must be excluded).
 */

/** Seed `capability_change { kind: "tracking" }` transitions via the public ingest API. */
async function seedTracking(request: APIRequestContext): Promise<void> {
  const now = Date.now();
  const base = { projectId: PROJECT_ID, sdkVersion: "0.0.0-e2e", sceneId: "arena" };
  const tracking = (
    sessionId: string,
    ts: number,
    source: string,
    durationMs: number,
    handedness?: string,
  ) => ({
    ...base,
    type: "capability_change" as const,
    sessionId,
    ts,
    kind: "tracking",
    from: source === "hand" ? "hand" : "6dof",
    to: "lost",
    reason: "signal-lost",
    source,
    durationMs,
    ...(handedness ? { handedness } : {}),
  });
  // A cheap non-tracking event to bound the whole-session span.
  const marker = (sessionId: string, ts: number, source: string) => ({
    ...base,
    type: "pointer_move" as const,
    sessionId,
    ts,
    source,
  });

  const events = [
    // hand-degraded: two hand-tracking loss episodes (1.2s + 0.6s) over a ~30s span.
    marker("hand-degraded", now - 30_000, "hand"),
    tracking("hand-degraded", now - 25_000, "hand", 1_200, "left"),
    tracking("hand-degraded", now - 10_000, "hand", 600, "left"),
    marker("hand-degraded", now - 1_000, "hand"),
    // ctrl-degraded: one controller-tracking loss episode (2s) over a ~30s span.
    marker("ctrl-degraded", now - 30_000, "xr-controller"),
    tracking("ctrl-degraded", now - 15_000, "xr-controller", 2_000, "right"),
    marker("ctrl-degraded", now - 1_000, "xr-controller"),
    // clean-xr: an XR session that never degrades — must be excluded from the panel.
    marker("clean-xr", now - 20_000, "xr-controller"),
    marker("clean-xr", now - 1_000, "xr-controller"),
  ];

  const res = await request.post(`${COLLECTOR_URL}/api/v1/collect`, {
    data: { events },
  });
  expect(
    res.ok(),
    `seeding XR tracking transitions should succeed (got ${res.status()}: ${await res.text()})`,
  ).toBeTruthy();
}

/** Open the dashboard pointed at the e2e collector and load the data. */
async function loadDashboard(page: Page): Promise<void> {
  await page.goto(DASHBOARD_URL);
  await page.getByPlaceholder("http://localhost:4318").fill(COLLECTOR_URL);
  await page.getByPlaceholder("utk_…").fill(API_KEY);
  await page.getByRole("button", { name: /load/i }).click();
}

test("Tracking quality panel renders the degraded-tracking share split by source", async ({
  page,
  request,
}) => {
  await seedTracking(request);
  await waitForEventTypes(request, "hand-degraded", ["capability_change"]);
  await loadDashboard(page);

  const panel = page
    .locator("section")
    .filter({ has: page.getByRole("heading", { name: "Tracking quality" }) })
    .last();
  await expect(panel.getByRole("heading", { name: "Tracking quality" })).toBeVisible({
    timeout: 20_000,
  });

  // The seeded degraded sessions populate the split breakdown (not the empty state).
  await expect(panel.getByText("Hand tracking", { exact: true })).toBeVisible();
  await expect(panel.getByText("Controller tracking", { exact: true })).toBeVisible();

  // The headline degraded share + episode/session counts render.
  await expect(panel.getByText(/of session time with degraded tracking/i)).toBeVisible();
  await expect(panel.getByText(/episodes/i)).toBeVisible();
});
