import { expect, test, type APIRequestContext, type Page } from "@playwright/test";

import { API_KEY, COLLECTOR_URL, DASHBOARD_URL, PROJECT_ID } from "./constants.js";
import { waitForEventTypes } from "./helpers/capture.js";

/**
 * Full-stack spec for the Load → bounce funnel panel (#152). The panel buckets
 * sessions by their initial `asset_load` load time and reports the bounce rate per
 * band — a bounce being a session that produced no interaction (`pointer_*` /
 * `mesh_interaction` / `camera_gesture`) at or after loading. It is derived from
 * existing events (no schema change), so we seed a mix of fast/slow loads with and
 * without a follow-up interaction straight to the public ingest endpoint —
 * exercising the same collector → DuckDB → query API → dashboard path the SDK would
 * — rather than driving full engine sessions, which would flood the shared ingest
 * rate-limiter and starve sibling specs.
 */
interface SeedSession {
  sessionId: string;
  loadMs: number;
  /** Whether the session produces an interaction after loading (engaged) or not (bounce). */
  engaged: boolean;
}

async function seedSessions(request: APIRequestContext, prefix: string): Promise<SeedSession[]> {
  const now = Date.now();
  const sessions: SeedSession[] = [
    { sessionId: `${prefix}-fast-engaged`, loadMs: 500, engaged: true },
    { sessionId: `${prefix}-fast-bounce`, loadMs: 500, engaged: false },
    { sessionId: `${prefix}-slow-bounce`, loadMs: 6000, engaged: false },
  ];

  const events = sessions.flatMap((s, i) => {
    const loadTs = now + i;
    const start = {
      type: "session_start" as const,
      projectId: PROJECT_ID,
      sessionId: s.sessionId,
      sdkVersion: "0.0.0-e2e",
      ts: loadTs - 1,
      scene: { cameraType: "arc-rotate" as const, cameraName: "cam", meshCount: 3 },
    };
    const load = {
      type: "asset_load" as const,
      projectId: PROJECT_ID,
      sessionId: s.sessionId,
      sdkVersion: "0.0.0-e2e",
      ts: loadTs,
      name: "scene.glb",
      loadMs: s.loadMs,
    };
    if (!s.engaged) return [start, load];
    return [
      start,
      load,
      {
        type: "pointer_click" as const,
        projectId: PROJECT_ID,
        sessionId: s.sessionId,
        sdkVersion: "0.0.0-e2e",
        ts: loadTs + 1000,
        screen: [0.5, 0.5] as [number, number],
        button: 0,
      },
    ];
  });

  const res = await request.post(`${COLLECTOR_URL}/api/v1/collect`, { data: { events } });
  expect(
    res.ok(),
    `seeding sessions should succeed (got ${res.status()}: ${await res.text()})`,
  ).toBeTruthy();
  return sessions;
}

async function loadDashboard(page: Page): Promise<void> {
  await page.goto(DASHBOARD_URL);
  await page.getByPlaceholder("http://localhost:4318").fill(COLLECTOR_URL);
  await page.getByPlaceholder("utk_…").fill(API_KEY);
  await page.getByRole("button", { name: /load/i }).click();
}

test("load-bounce funnel panel renders bounce rate per asset-load band", async ({
  page,
  request,
}) => {
  const seeded = await seedSessions(request, `e2e-lb-${Date.now()}`);
  // Wait for both event types to land: the engaged session carries the pointer_click.
  await waitForEventTypes(request, `${seeded[0].sessionId}`, ["asset_load", "pointer_click"]);
  await waitForEventTypes(request, `${seeded[2].sessionId}`, ["asset_load"]);

  await loadDashboard(page);

  const panel = page
    .locator("section")
    .filter({ has: page.getByRole("heading", { name: "Load → bounce funnel" }) })
    .last();
  await expect(panel.getByRole("heading", { name: "Load → bounce funnel" })).toBeVisible({
    timeout: 20_000,
  });

  // The fastest and slowest bands must be labelled, and bounce copy must render.
  await expect(panel.getByText("< 1 s", { exact: true })).toBeVisible();
  await expect(panel.getByText("≥ 5 s", { exact: true })).toBeVisible();
  await expect(panel.getByText(/bounced/).first()).toBeVisible();
  // Real data seeded, so never the empty state.
  await expect(panel.getByText(/No .*asset_load.* events in range/)).toHaveCount(0);
});
