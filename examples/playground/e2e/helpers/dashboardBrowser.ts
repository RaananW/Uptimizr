/**
 * Open the dashboard in its own browser, not just its own context.
 *
 * A spec that drives the playground while a live dashboard renders beside it
 * shares one GPU process when both live in one browser, and in CI that GPU is
 * SwiftShader, on the CPU. The dashboard's replay and 3D panels then queue the
 * playground's WebGL work behind theirs, and its input handling stalled until
 * a `mouse.move` timed out. A second browser has its own GPU process.
 */
import { chromium, type BrowserContextOptions, type Page } from "@playwright/test";

import { API_KEY, COLLECTOR_URL, DASHBOARD_URL } from "../constants.js";

export interface DashboardBrowser {
  page: Page;
  close(): Promise<void>;
}

/** Launch a browser, open the dashboard and connect it to the e2e collector. */
export async function openDashboardBrowser(
  options: BrowserContextOptions = {},
): Promise<DashboardBrowser> {
  const browser = await chromium.launch();
  const context = await browser.newContext(options);
  const page = await context.newPage();
  await page.goto(DASHBOARD_URL);
  await page.getByPlaceholder("http://localhost:4318").fill(COLLECTOR_URL);
  await page.getByPlaceholder("utk_…").fill(API_KEY);
  await page.getByRole("button", { name: /load/i }).click();
  return { page, close: () => browser.close() };
}
