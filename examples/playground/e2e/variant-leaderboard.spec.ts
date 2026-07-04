import { expect, test, type APIRequestContext, type Page } from "@playwright/test";

import { API_KEY, COLLECTOR_URL, DASHBOARD_URL, PROJECT_ID } from "./constants.js";
import { waitForEventTypes } from "./helpers/capture.js";

/**
 * Full-stack spec for the variant → conversion leaderboard (#150).
 *
 * The leaderboard ranks `custom` variant events (grouped by their `name`) by
 * views, and — once a "success" event is picked in-panel — shows each variant's
 * conversion rate. The signal is deterministic per-variant, so instead of driving
 * a real engine session (which floods the shared ingest rate-limiter, per the
 * graphics-diagnostics spec) we seed a handful of `custom` events straight to the
 * public ingest endpoint. This still exercises the real
 * collector → DuckDB → query API → dashboard path the SDK would.
 *
 * Seeded shape (variant → converting sessions):
 *   red   viewed by sA, sB, sC — sA + sB later fire `checkout` ⇒ 2 / 3 ≈ 67%
 *   blue  viewed by sB, sD     — only sB converts             ⇒ 1 / 2 =  50%
 *   green viewed by sC         — never converts               ⇒ 0 / 1 =   0%
 */

interface SeedEvent {
  sessionId: string;
  name: string;
  ts: number;
}

async function seedVariants(request: APIRequestContext): Promise<void> {
  // Base the timeline safely in the past: the dashboard's default range ends at
  // "now", so future-dated events would be filtered out of the panel.
  const base = Date.now() - 600_000;
  const rows: SeedEvent[] = [
    // sA: red → checkout (converts).
    { sessionId: "vlb-sA", name: "red", ts: base },
    { sessionId: "vlb-sA", name: "checkout", ts: base + 5000 },
    // sB: red → blue → checkout (both red and blue convert).
    { sessionId: "vlb-sB", name: "red", ts: base },
    { sessionId: "vlb-sB", name: "blue", ts: base + 2000 },
    { sessionId: "vlb-sB", name: "checkout", ts: base + 6000 },
    // sC: red → green (no conversion).
    { sessionId: "vlb-sC", name: "red", ts: base },
    { sessionId: "vlb-sC", name: "green", ts: base + 3000 },
    // sD: blue only (no conversion).
    { sessionId: "vlb-sD", name: "blue", ts: base },
  ];
  const res = await request.post(`${COLLECTOR_URL}/api/v1/collect`, {
    data: {
      events: rows.map((r) => ({
        type: "custom" as const,
        projectId: PROJECT_ID,
        sessionId: r.sessionId,
        sdkVersion: "0.0.0-e2e",
        ts: r.ts,
        name: r.name,
      })),
    },
  });
  expect(
    res.ok(),
    `seeding variants should succeed (got ${res.status()}: ${await res.text()})`,
  ).toBeTruthy();
}

async function loadDashboard(page: Page): Promise<void> {
  await page.goto(DASHBOARD_URL);
  await page.getByPlaceholder("http://localhost:4318").fill(COLLECTOR_URL);
  await page.getByPlaceholder("utk_…").fill(API_KEY);
  await page.getByRole("button", { name: /load/i }).click();
}

test("variant leaderboard ranks variants and reveals conversion after picking a success event", async ({
  page,
  request,
}) => {
  await seedVariants(request);
  // The ingest is async; wait until a seeded session's custom event is queryable.
  await waitForEventTypes(request, "vlb-sA", ["custom"]);

  await loadDashboard(page);

  const panel = page.locator("section", { hasText: "Variant → conversion leaderboard" }).first();
  await panel.scrollIntoViewIfNeeded();
  await expect(
    panel.getByRole("heading", { name: /Variant .* conversion leaderboard/ }),
  ).toBeVisible({ timeout: 20_000 });

  // The seeded variants are ranked in the panel body list (not the picker options).
  const list = panel.locator("ol");
  await expect(list.getByText("red", { exact: true })).toBeVisible();
  await expect(list.getByText("blue", { exact: true })).toBeVisible();
  await expect(list.getByText("green", { exact: true })).toBeVisible();

  // Pick the success event; the panel re-fetches and reveals conversion rates.
  await panel.getByRole("combobox").selectOption("checkout");
  await expect(panel.getByText("67%").first()).toBeVisible({ timeout: 20_000 });
  await expect(panel.getByText("50%").first()).toBeVisible();
});
