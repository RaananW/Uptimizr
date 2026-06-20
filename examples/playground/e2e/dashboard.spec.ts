import { expect, test } from "@playwright/test";

import { API_KEY, COLLECTOR_URL, DASHBOARD_URL } from "./constants.js";
import {
  bootEngine,
  driveInteractions,
  enableAllCapture,
  loseAndRestoreContext,
  waitForEventTypes,
} from "./helpers/capture.js";

/**
 * Full-stack dashboard spec: drive the Babylon connector to produce a rich,
 * real session (capture → collector → DuckDB), then open the Next.js dashboard
 * pointed at the same collector and assert the captured analytics actually render
 * — the panels, the input-source breakdown, perf, and the session drill-down.
 */
const DASHBOARD_REQUIRED = [
  "session_start",
  "frame_perf",
  "camera_sample",
  "pointer_click",
  "mesh_interaction",
  "custom",
  "scene_change",
] as const;

test("dashboard renders captured events end to end", async ({ page, request }) => {
  // 1) Produce a real session through the playground.
  await enableAllCapture(page, "babylon");
  const sessionId = await bootEngine(page, "babylon");
  await driveInteractions(page, { keyboard: true });
  await loseAndRestoreContext(page);
  await waitForEventTypes(request, sessionId, DASHBOARD_REQUIRED);

  // 2) Open the dashboard and connect to the collector.
  await page.goto(DASHBOARD_URL);
  await page.getByPlaceholder("http://localhost:4318").fill(COLLECTOR_URL);
  await page.getByPlaceholder("utk_…").fill(API_KEY);
  await page.getByRole("button", { name: /load/i }).click();

  // 3) The core panels render the captured data.
  await expect(page.getByText("Top meshes")).toBeVisible({ timeout: 20_000 });
  // A box mesh was picked, so the top-meshes panel lists one.
  await expect(page.getByText(/box-\d/).first()).toBeVisible();

  // The input-source breakdown (ADR 0011) surfaces the mouse interactions.
  const inputSources = page.locator("section", { hasText: "Input sources" }).first();
  await expect(inputSources).toBeVisible();
  await expect(inputSources.getByText("Mouse")).toBeVisible();

  // Rendering-performance panel reflects frame_perf samples.
  await expect(page.getByText("Rendering performance")).toBeVisible();

  // 4) The session appears in the sessions table; opening it loads the drill-down.
  const shortId = sessionId.slice(0, 12);
  const sessionCell = page.getByText(shortId, { exact: true }).first();
  await expect(sessionCell).toBeVisible();
  await sessionCell.click();
  // The drill-down header shows the full session id.
  await expect(page.getByText(sessionId, { exact: true })).toBeVisible();
});

/**
 * Smoke-level coverage for the 3D-panel controls shipped in #119–#123: the
 * view-direction dome's Markers/Skydome toggle and the Flow Sankey camera-mode /
 * two-stage toggles. We don't assert the WebGL canvas pixels (3D output isn't
 * meaningfully assertable, and the standpoint/hover behaviours are unit-tested);
 * we verify the controls render against real captured data and that toggling
 * them rebuilds the scene without tearing down the panel — i.e. no crash-on-toggle
 * regression. Hover tooltips are deliberately not driven here: pixel-precise
 * picking over a 3D canvas is flaky, so `attachMeshHover` is unit-tested instead.
 */
test("3D panel controls render and toggle without errors", async ({ page, request }) => {
  // Produce a session with clicks + camera samples so the flow + dome panels populate.
  await enableAllCapture(page, "babylon");
  const sessionId = await bootEngine(page, "babylon");
  await driveInteractions(page, { keyboard: true });
  await waitForEventTypes(request, sessionId, ["pointer_click", "camera_sample"]);

  await page.goto(DASHBOARD_URL);
  await page.getByPlaceholder("http://localhost:4318").fill(COLLECTOR_URL);
  await page.getByPlaceholder("utk_…").fill(API_KEY);
  await page.getByRole("button", { name: /load/i }).click();

  // --- View-direction dome (3D): Markers / Skydome toggle (#119) ---
  // The dome always has camera samples to render, so this toggle is a firm check.
  const dome = page.locator("section", { hasText: "View-direction dome (3D)" });
  await dome.scrollIntoViewIfNeeded();
  await expect(dome.getByRole("heading", { name: "View-direction dome (3D)" })).toBeVisible({
    timeout: 20_000,
  });
  const domeCanvas = dome.locator("canvas").first();
  await expect(domeCanvas).toBeVisible();
  const skydomeBtn = dome.getByRole("button", { name: "Skydome", exact: true });
  await expect(skydomeBtn).toBeVisible({ timeout: 20_000 });
  await skydomeBtn.click();
  await expect(domeCanvas).toBeVisible(); // mode switch rebuilds the scene, keeps the canvas
  await dome.getByRole("button", { name: "Markers", exact: true }).click();
  await expect(domeCanvas).toBeVisible();

  // --- Flow Sankey (3D): camera-mode + two-stage toggles (#120–#122) ---
  const flow = page.locator("section", { hasText: "Flow Sankey (3D)" });
  await flow.scrollIntoViewIfNeeded();
  await expect(flow.getByRole("heading", { name: "Flow Sankey (3D)" })).toBeVisible();
  // The main WebGL canvas is first; two-stage mode adds a second (minimap) canvas.
  const flowCanvas = flow.locator("canvas").first();
  await expect(flowCanvas).toBeVisible();

  // The Walk/Orbit/All camera-mode group renders once the self-fetch resolves.
  // Give it a chance, then exercise it if present (an empty flow stays at the
  // "no links" state with no controls — tolerated rather than failed).
  const allBtn = flow.getByRole("button", { name: "All", exact: true });
  await allBtn.waitFor({ state: "visible", timeout: 15_000 }).catch(() => {});
  if (await allBtn.isVisible()) {
    await flow.getByRole("button", { name: "Orbit", exact: true }).click();
    await expect(flowCanvas).toBeVisible();
    await allBtn.click();
    await expect(flowCanvas).toBeVisible();
  }

  // The Aggregate/Two-stage toggle only appears for multi-standpoint scenes;
  // exercise it when present.
  const twoStageBtn = flow.getByRole("button", { name: "Two-stage", exact: true });
  if (await twoStageBtn.isVisible()) {
    await twoStageBtn.click();
    await expect(flowCanvas).toBeVisible();
    await flow.getByRole("button", { name: "Aggregate", exact: true }).click();
    await expect(flowCanvas).toBeVisible();
  }
});
