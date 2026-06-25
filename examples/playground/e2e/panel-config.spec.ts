import { expect, test } from "@playwright/test";

import { API_KEY, COLLECTOR_URL, DASHBOARD_URL } from "./constants.js";
import {
  bootEngine,
  driveInteractions,
  enableAllCapture,
  waitForEventTypes,
} from "./helpers/capture.js";

/**
 * Configurable panels (ADR 0039, #79): a viewer can hide a panel and restore it,
 * and a panel's own settings re-query its data. We drive a real Babylon session
 * so the panels populate, open the dashboard, then exercise the two contracts:
 *
 *   1. Hide → restore: hiding "Top meshes" removes it and surfaces it in the
 *      "Hidden panels" manage bar; restoring brings it back.
 *   2. Per-panel settings: changing the floor-plan's `cellSize` slider re-issues
 *      the position-heatmap query at the new resolution.
 */
test("panels can be hidden, restored, and reconfigured", async ({ page, request }) => {
  await enableAllCapture(page, "babylon");
  const sessionId = await bootEngine(page, "babylon");
  await driveInteractions(page, { keyboard: true });
  await waitForEventTypes(request, sessionId, ["mesh_interaction", "camera_sample"]);

  await page.goto(DASHBOARD_URL);
  await page.getByPlaceholder("http://localhost:4318").fill(COLLECTOR_URL);
  await page.getByPlaceholder("utk_…").fill(API_KEY);
  await page.getByRole("button", { name: /load/i }).click();

  // --- 1) Hide → restore the Top meshes panel ---
  const topMeshes = page.getByRole("heading", { name: "Top meshes" });
  await expect(topMeshes).toBeVisible({ timeout: 20_000 });

  await page.getByRole("button", { name: "Hide Top meshes", exact: true }).click();
  await expect(topMeshes).toHaveCount(0);

  // The manage bar lists the hidden panel; restoring brings it back.
  await expect(page.getByText(/Hidden panels \(\d+\)/)).toBeVisible();
  await page.getByRole("button", { name: "+ Top meshes", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Top meshes" })).toBeVisible();

  // --- 2) Reconfigure the floor-plan cellSize and assert a re-query ---
  const floor = page.locator("section", { hasText: "Floor-plan heatmap" }).first();
  await floor.scrollIntoViewIfNeeded();
  await expect(floor.getByRole("heading", { name: "Floor-plan heatmap" })).toBeVisible({
    timeout: 20_000,
  });

  // Open the panel's ⚙ settings menu, revealing the cellSize slider.
  await floor.getByRole("button", { name: "Floor-plan heatmap settings" }).click();
  const slider = floor.getByRole("slider");
  await expect(slider).toBeVisible();

  // Changing the slider re-issues the position-heatmap query at a larger cellSize
  // (the slider's default is 1; ArrowRight steps it up by 0.25).
  const requeried = page.waitForRequest((req) => {
    if (!req.url().includes("/heatmaps/position")) return false;
    const value = Number(new URL(req.url()).searchParams.get("cellSize"));
    return Number.isFinite(value) && value > 1;
  });
  await slider.focus();
  await slider.press("ArrowRight");
  await requeried;
});
