import { expect, test, type APIRequestContext, type Page } from "@playwright/test";

import { API_KEY, COLLECTOR_URL, DASHBOARD_URL, PROJECT_ID } from "./constants.js";
import { waitForEventTypes } from "./helpers/capture.js";

/**
 * Full-stack spec for the always-on rendering-technology panel (#120, ADR 0021
 * part 1). `session_start.graphics` is always-on (every connector reports it), so
 * unlike Engine diagnostics there is no opt-in empty state. We seed two
 * `session_start` events with distinct graphics blocks straight to the public
 * ingest endpoint — exercising the same collector → DuckDB → query API → dashboard
 * path the SDK would — rather than driving full engine sessions, which would flood
 * the shared ingest rate-limiter and starve sibling specs.
 */
async function seedSessions(request: APIRequestContext, prefix: string): Promise<string[]> {
  const now = Date.now();
  const sessions = [
    {
      sessionId: `${prefix}-gpu`,
      graphics: { api: "webgpu", backend: "metal", apiVersion: "1.0", shadingLanguage: "wgsl" },
    },
    {
      sessionId: `${prefix}-gl`,
      graphics: { api: "webgl2", backend: "opengl", apiVersion: "3.0", shadingLanguage: "glsl-es" },
    },
  ];
  const res = await request.post(`${COLLECTOR_URL}/api/v1/collect`, {
    data: {
      events: sessions.map((s, i) => ({
        type: "session_start" as const,
        projectId: PROJECT_ID,
        sessionId: s.sessionId,
        sdkVersion: "0.0.0-e2e",
        ts: now + i,
        graphics: s.graphics,
      })),
    },
  });
  expect(
    res.ok(),
    `seeding sessions should succeed (got ${res.status()}: ${await res.text()})`,
  ).toBeTruthy();
  return sessions.map((s) => s.sessionId);
}

async function loadDashboard(page: Page): Promise<void> {
  await page.goto(DASHBOARD_URL);
  await page.getByPlaceholder("http://localhost:4318").fill(COLLECTOR_URL);
  await page.getByPlaceholder("utk_…").fill(API_KEY);
  await page.getByRole("button", { name: /load/i }).click();
}

test("rendering-technology panel renders the always-on api/backend/shading-language mix", async ({
  page,
  request,
}) => {
  const [gpu] = await seedSessions(request, `e2e-rt-${Date.now()}`);
  await waitForEventTypes(request, gpu, ["session_start"]);

  await loadDashboard(page);

  const panel = page
    .locator("section")
    .filter({ has: page.getByRole("heading", { name: "Rendering technology" }) })
    .last();
  await expect(panel.getByRole("heading", { name: "Rendering technology" })).toBeVisible({
    timeout: 20_000,
  });
  await expect(panel.getByText("By API", { exact: true })).toBeVisible();
  await expect(panel.getByText("By backend", { exact: true })).toBeVisible();
  await expect(panel.getByText("By shading language", { exact: true })).toBeVisible();
  await expect(panel.getByText("webgpu")).toBeVisible();
  await expect(panel.getByText("webgl2")).toBeVisible();
  await expect(panel.getByText("metal")).toBeVisible();
  await expect(panel.getByText("wgsl")).toBeVisible();
  // Always-on, so the panel is never an opt-in empty state.
  await expect(panel.getByText("No sessions in range.")).toHaveCount(0);
});
