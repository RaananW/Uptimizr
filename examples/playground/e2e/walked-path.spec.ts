import { expect, test, type APIRequestContext, type Page } from "@playwright/test";

import { API_KEY, COLLECTOR_URL, DASHBOARD_URL, PROJECT_ID } from "./constants.js";
import { waitForEventTypes } from "./helpers/capture.js";

/**
 * Full-stack spec for the walked-path panel's height encoding (#92, ADR 0026).
 *
 * The session drill-down draws a first-person session's `camera_sample` positions as a
 * top-down route. Since #92 the line is color-coded by camera height (world Y) with a
 * low/high legend, so stairs, ramps, and floor changes read in plan view; a route whose
 * height barely varies is drawn flat and says so; and the encoding is a per-viewer ⚙
 * setting. The panel shows only for sessions recorded with a first-person (`free`) camera.
 *
 * A headless runner can't walk a staircase, so three sessions are seeded by one batched
 * POST to the public ingest endpoint — the same collector → DuckDB → query API → dashboard
 * path the SDK would take.
 */

const STAIRS_SESSION = "walk-stairs-session-1";
const LEVEL_SESSION = "walk-level-session-1";
const ORBIT_SESSION = "orbit-cam-session-1";

/** Seed a first-person stair climb, a first-person level walk, and an orbit session. */
async function seedSessions(request: APIRequestContext): Promise<void> {
  const now = Date.now();
  const base = { projectId: PROJECT_ID, sdkVersion: "0.0.0-e2e", sceneId: "lobby" };
  const start = (sessionId: string, cameraType: "free" | "arc-rotate", ts: number) => ({
    ...base,
    type: "session_start" as const,
    sessionId,
    ts,
    scene: { cameraType },
  });
  const sample = (sessionId: string, ts: number, position: [number, number, number]) => ({
    ...base,
    type: "camera_sample" as const,
    sessionId,
    ts,
    position,
    direction: [0, 0, 1] as [number, number, number],
  });

  const events = [start(STAIRS_SESSION, "free", now - 60_000)];
  // Across the lobby at eye height, then up a staircase to a balcony four metres higher.
  for (let i = 0; i < 20; i++) {
    const t = i / 19;
    const y = t < 0.5 ? 1.6 : 1.6 + ((t - 0.5) / 0.5) * 4;
    events.push(sample(STAIRS_SESSION, now - 60_000 + i * 1000, [t * 10, y, t * 6]));
  }
  events.push(start(LEVEL_SESSION, "free", now - 40_000));
  for (let i = 0; i < 20; i++) {
    const t = i / 19;
    events.push(sample(LEVEL_SESSION, now - 40_000 + i * 1000, [t * 10, 1.6, t * 6]));
  }
  events.push(start(ORBIT_SESSION, "arc-rotate", now - 20_000));
  for (let i = 0; i < 5; i++) {
    events.push(sample(ORBIT_SESSION, now - 20_000 + i * 1000, [Math.cos(i), 2, Math.sin(i)]));
  }

  const res = await request.post(`${COLLECTOR_URL}/api/v1/collect`, { data: { events } });
  expect(
    res.ok(),
    `seeding walked-path sessions should succeed (got ${res.status()}: ${await res.text()})`,
  ).toBeTruthy();
}

/** Open the dashboard pointed at the e2e collector and load the data. */
async function loadDashboard(page: Page): Promise<void> {
  await page.goto(DASHBOARD_URL);
  await page.getByPlaceholder("http://localhost:4318").fill(COLLECTOR_URL);
  await page.getByPlaceholder("utk_…").fill(API_KEY);
  await page.getByRole("button", { name: /load/i }).click();
  await expect(page.getByRole("heading", { name: "Sessions" })).toBeVisible({ timeout: 20_000 });
}

/**
 * Open one session's drill-down from the sessions table. The table shows a 12-char
 * prefix and the drill-down header the full id, so ids longer than 12 chars keep
 * the two distinguishable (the table is on the session surface too).
 */
async function openSession(page: Page, sessionId: string): Promise<void> {
  await page.getByText(sessionId.slice(0, 12), { exact: true }).first().click();
  await expect(page.getByText(sessionId, { exact: true })).toBeVisible();
}

const walkedPath = (page: Page) =>
  page.locator("section", { has: page.getByRole("heading", { name: "Walked path" }) }).first();

test("walked path color-codes camera height with a legend and a per-viewer toggle (#92)", async ({
  page,
  request,
}) => {
  await seedSessions(request);
  await waitForEventTypes(request, STAIRS_SESSION, ["session_start", "camera_sample"]);
  await waitForEventTypes(request, LEVEL_SESSION, ["camera_sample"]);
  await waitForEventTypes(request, ORBIT_SESSION, ["camera_sample"]);

  await loadDashboard(page);

  // The staircase session: the panel renders with the height legend spanning the
  // route's lowest and highest camera positions.
  await openSession(page, STAIRS_SESSION);
  const stairs = walkedPath(page);
  await expect(stairs.getByRole("heading", { name: "Walked path" })).toBeVisible({
    timeout: 20_000,
  });
  await expect(stairs.getByText("Camera height", { exact: true })).toBeVisible();
  await expect(stairs.getByText("1.6 m", { exact: true })).toBeVisible();
  await expect(stairs.getByText("5.6 m", { exact: true })).toBeVisible();

  // The ⚙ menu exposes the "Color by height" toggle; switching it off removes the legend.
  await stairs.getByRole("button", { name: "Walked path settings" }).click();
  const toggle = stairs.getByRole("checkbox");
  await expect(toggle).toBeChecked();
  await toggle.uncheck();
  await expect(stairs.getByText("Camera height", { exact: true })).toHaveCount(0);
  await toggle.check();
  await expect(stairs.getByText("Camera height", { exact: true })).toBeVisible();

  // A level route stays one color and says so instead of stretching the ramp over noise.
  await page.getByRole("button", { name: /all sessions/i }).click();
  await openSession(page, LEVEL_SESSION);
  const level = walkedPath(page);
  await expect(level.getByRole("heading", { name: "Walked path" })).toBeVisible({
    timeout: 20_000,
  });
  await expect(level.getByText(/Level route/)).toBeVisible();
  await expect(level.getByText("Camera height", { exact: true })).toHaveCount(0);

  // An orbit-camera session has no walked path: the panel is gated on the recorded camera type.
  await page.getByRole("button", { name: /all sessions/i }).click();
  await openSession(page, ORBIT_SESSION);
  await expect(page.getByRole("heading", { name: "Top meshes" })).toBeVisible({ timeout: 20_000 });
  await expect(page.getByRole("heading", { name: "Walked path" })).toHaveCount(0);
});
