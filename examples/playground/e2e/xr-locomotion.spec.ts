import { expect, test, type APIRequestContext, type Page } from "@playwright/test";

import { API_KEY, COLLECTOR_URL, DASHBOARD_URL, PROJECT_ID } from "./constants.js";
import { waitForEventTypes } from "./helpers/capture.js";

/**
 * Full-stack spec for the VR comfort & locomotion panel (#148).
 *
 * The panel reads locomotion from existing `camera_gesture` (fly / navigate) and
 * `mesh_interaction { kind: "teleport" }` events for sessions that used an XR
 * input source (ADR 0025) — no schema change. A real headless WebGL run can't
 * enter an immersive XR session, so the XR locomotion is seeded by a single
 * batched POST straight to the public ingest endpoint, exercising the same
 * collector → DuckDB → query API → dashboard path the SDK would. We seed three
 * sessions: a heavy-locomotion XR session that exits early, a light-locomotion
 * XR session that lingers, and a mouse-only control that must be excluded.
 */

/** Seed XR + flat-screen locomotion events via the public ingest API. */
async function seedLocomotion(request: APIRequestContext): Promise<void> {
  const now = Date.now();
  const base = { projectId: PROJECT_ID, sdkVersion: "0.0.0-e2e", sceneId: "arena" };
  const fly = (sessionId: string, ts: number, source: string) => ({
    ...base,
    type: "camera_gesture" as const,
    sessionId,
    ts,
    kind: "fly",
    durationMs: 120,
    source,
  });
  const navigate = (sessionId: string, ts: number, source: string) => ({
    ...base,
    type: "camera_gesture" as const,
    sessionId,
    ts,
    kind: "navigate",
    durationMs: 200,
    source,
  });
  const teleport = (sessionId: string, ts: number) => ({
    ...base,
    type: "mesh_interaction" as const,
    sessionId,
    ts,
    mesh: "floor",
    kind: "teleport",
    source: "xr-controller",
  });

  const events = [
    // xr-heavy: lots of smooth flying in a ~8s window (early exit) + a teleport.
    ...Array.from({ length: 8 }, (_, i) => fly("xr-heavy", now - 8_000 + i * 900, "xr-controller")),
    navigate("xr-heavy", now - 500, "xr-controller"),
    teleport("xr-heavy", now - 400),
    // xr-light: a couple of flies spread over ~90s (lingering session).
    fly("xr-light", now - 90_000, "xr-controller"),
    fly("xr-light", now - 2_000, "xr-controller"),
    // flat-control: mouse-only locomotion — must be excluded from the XR panel.
    fly("flat-control", now - 3_000, "mouse"),
    navigate("flat-control", now - 1_000, "mouse"),
  ];

  const res = await request.post(`${COLLECTOR_URL}/api/v1/collect`, {
    data: { events },
  });
  expect(
    res.ok(),
    `seeding XR locomotion should succeed (got ${res.status()}: ${await res.text()})`,
  ).toBeTruthy();
}

/** Open the dashboard pointed at the e2e collector and load the data. */
async function loadDashboard(page: Page): Promise<void> {
  await page.goto(DASHBOARD_URL);
  await page.getByPlaceholder("http://localhost:4318").fill(COLLECTOR_URL);
  await page.getByPlaceholder("utk_…").fill(API_KEY);
  await page.getByRole("button", { name: /load/i }).click();
}

test("VR comfort & locomotion panel renders the XR locomotion-style mix", async ({
  page,
  request,
}) => {
  await seedLocomotion(request);
  await waitForEventTypes(request, "xr-heavy", ["camera_gesture", "mesh_interaction"]);
  await loadDashboard(page);

  const panel = page
    .locator("section")
    .filter({ has: page.getByRole("heading", { name: "VR comfort & locomotion" }) })
    .last();
  await expect(panel.getByRole("heading", { name: "VR comfort & locomotion" })).toBeVisible({
    timeout: 20_000,
  });

  // The seeded XR sessions populate the style-mix breakdown (not the empty state).
  await expect(panel.getByText("Smooth locomotion", { exact: true })).toBeVisible();
  await expect(panel.getByText("Teleport", { exact: true })).toBeVisible();
  await expect(panel.getByText("Navigate", { exact: true })).toBeVisible();

  // Two XR sessions → the heavy-vs-light comfort correlation table renders.
  await expect(panel.getByText(/locomotion vs\. early exit/i)).toBeVisible();
  await expect(panel.getByText("Heavy", { exact: true })).toBeVisible();
  await expect(panel.getByText("Light", { exact: true })).toBeVisible();
});
