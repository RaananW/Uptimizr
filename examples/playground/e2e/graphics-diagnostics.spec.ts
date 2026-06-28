import { expect, test, type APIRequestContext, type Page } from "@playwright/test";

import { API_KEY, COLLECTOR_URL, DASHBOARD_URL, PROJECT_ID } from "./constants.js";
import { waitForEventTypes } from "./helpers/capture.js";

/**
 * Full-stack spec for the opt-in engine-diagnostics panel (#16, ADR 0021 part 2).
 *
 * `graphics_diagnostic` capture is **off by default**, so the realistic browser
 * run produces none — the panel must show its explicit opt-in empty state rather
 * than reading as broken. We can't deterministically trigger a real WebGPU device
 * loss in the headless WebGL runner, so the populated case is seeded by a single
 * batched POST of three diagnostics (two discrete markers + one per-session rollup)
 * straight to the collector's public ingest endpoint — exercising the same
 * collector → DuckDB → query API → dashboard path the SDK would. We deliberately do
 * NOT drive a real engine session here: a full capture run floods the shared ingest
 * rate-limiter and starves sibling specs that sort after this one, so seeding stays
 * to one POST.
 */

/** Seed `graphics_diagnostic` events for `sessionId` via the public ingest API. */
async function seedDiagnostics(request: APIRequestContext, sessionId: string): Promise<void> {
  const now = Date.now();
  const baseEvent = {
    type: "graphics_diagnostic" as const,
    projectId: PROJECT_ID,
    sessionId,
    sdkVersion: "0.0.0-e2e",
  };
  const res = await request.post(`${COLLECTOR_URL}/api/v1/collect`, {
    data: {
      events: [
        // Two discrete WebGPU device-lost markers (no `count`): fold in as 1 each.
        { ...baseEvent, ts: now, severity: "fatal", category: "device-lost", backend: "webgpu" },
        {
          ...baseEvent,
          ts: now + 1,
          severity: "fatal",
          category: "device-lost",
          backend: "webgpu",
        },
        // A per-session rollup of 5 WebGL2 validation warnings: folds in as 5.
        {
          ...baseEvent,
          ts: now + 2,
          severity: "warning",
          category: "validation",
          backend: "webgl2",
          count: 5,
        },
      ],
    },
  });
  expect(
    res.ok(),
    `seeding diagnostics should succeed (got ${res.status()}: ${await res.text()})`,
  ).toBeTruthy();
}

/** Open the dashboard pointed at the e2e collector and load the data. */
async function loadDashboard(page: Page): Promise<void> {
  await page.goto(DASHBOARD_URL);
  await page.getByPlaceholder("http://localhost:4318").fill(COLLECTOR_URL);
  await page.getByPlaceholder("utk_…").fill(API_KEY);
  await page.getByRole("button", { name: /load/i }).click();
}

test("engine-diagnostics panel shows the opt-in empty state when capture is off", async ({
  page,
}) => {
  // The seeded store carries rich analytics but no graphics_diagnostic events
  // (capture is off by default), so the panel must show its opt-in empty state.
  await loadDashboard(page);

  const panel = page
    .locator("section")
    .filter({ has: page.getByRole("heading", { name: "Engine diagnostics" }) })
    .last();
  await expect(panel.getByRole("heading", { name: "Engine diagnostics" })).toBeVisible({
    timeout: 20_000,
  });
  // The empty state makes the opt-in nature explicit so it doesn't read as broken.
  await expect(panel.getByText("No engine diagnostics in range.")).toBeVisible();
  await expect(panel.getByText(/opt-in and off by default/i)).toBeVisible();
  await expect(panel.getByText(/captureGraphicsDiagnostics/)).toBeVisible();
  // No breakdown groups are rendered when there is nothing to show.
  await expect(panel.getByText("By severity", { exact: true })).toHaveCount(0);
});

test("engine-diagnostics panel renders counts by severity/category/backend when data exists", async ({
  page,
  request,
}) => {
  // Pure-ingest seed (one batched POST) — no engine session, so we don't flood the
  // shared rate-limiter. The synthetic session shows up via listSessions, so the
  // dashboard reaches its ready state and the panel renders the seeded counts.
  const sessionId = `e2e-diag-${Date.now()}`;
  await seedDiagnostics(request, sessionId);
  await waitForEventTypes(request, sessionId, ["graphics_diagnostic"]);

  await loadDashboard(page);

  const panel = page
    .locator("section")
    .filter({ has: page.getByRole("heading", { name: "Engine diagnostics" }) })
    .last();
  await expect(panel.getByRole("heading", { name: "Engine diagnostics" })).toBeVisible({
    timeout: 20_000,
  });
  // The three breakdown groups render with the seeded categories/backends.
  await expect(panel.getByText("By severity", { exact: true })).toBeVisible();
  await expect(panel.getByText("By category", { exact: true })).toBeVisible();
  await expect(panel.getByText("By backend", { exact: true })).toBeVisible();
  await expect(panel.getByText("device-lost")).toBeVisible();
  await expect(panel.getByText("validation")).toBeVisible();
  await expect(panel.getByText("webgpu")).toBeVisible();
  await expect(panel.getByText("webgl2")).toBeVisible();
  // The opt-in empty copy is gone once incidents exist.
  await expect(panel.getByText("No engine diagnostics in range.")).toHaveCount(0);
});
