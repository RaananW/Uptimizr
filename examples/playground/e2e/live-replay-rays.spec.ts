import { expect, test, type Locator, type Page } from "@playwright/test";

import { API_KEY, COLLECTOR_URL, DASHBOARD_URL } from "./constants.js";
import {
  bootEngine,
  enableAllCapture,
  readSessionEvents,
  waitForEventTypes,
  type CapturedEvent,
} from "./helpers/capture.js";
import { aimAt } from "./helpers/testControl.js";

/** A point on the atrium floor, 8 m ahead of the spawn point (0, 1.8, -24). */
const FLOOR_AHEAD: [number, number, number] = [0, 0, -16];

/**
 * Every click of a live session plays in the dashboard's replay, each in turn.
 *
 * The replay draws on a WebGL canvas, so it publishes what it has drawn on the
 * canvas element: `data-click-rays-shown` counts the click rays that have
 * started to play, and `data-click-pulses-shown` how many separate pulses they
 * made (rays starting within half a glow of each other read as one). Two bugs
 * this would have caught:
 *
 * - The live stream dropped events that shared a millisecond with the one
 *   before. A click is a press, a release, the click and the pick, usually in
 *   the same millisecond, so most clicks never drew a ray.
 * - Clicks sent in one SDK batch all played the moment the batch arrived, so
 *   their rays overlapped under a single glow: three clicks, one pulse.
 *
 * The subject is the three.js first-person atrium under Pointer Lock, where
 * the four events of a click always share their timestamp.
 */

async function readCount(canvas: Locator, attr: string): Promise<number> {
  return Number((await canvas.getAttribute(attr)) ?? "0");
}

async function pointerLocked(page: Page): Promise<boolean> {
  return page.evaluate(() => document.pointerLockElement != null);
}

test("[three · atrium · locked] each live click plays its own ray in the replay", async ({
  browser,
  page,
  request,
}) => {
  test.setTimeout(120_000);

  // 1) The live subject: a capturing first-person session.
  await enableAllCapture(page, "three");
  const sessionId = await bootEngine(page, "three", "atrium");
  await expect(page.locator(".lock-overlay")).toBeVisible();
  await waitForEventTypes(request, sessionId, ["session_start", "camera_sample"]);

  // 2) The dashboard, in its own context so both pages keep rendering.
  const dashContext = await browser.newContext({ viewport: { width: 1400, height: 1000 } });
  const dash = await dashContext.newPage();
  await dash.goto(DASHBOARD_URL);
  await dash.getByPlaceholder("http://localhost:4318").fill(COLLECTOR_URL);
  await dash.getByPlaceholder("utk_…").fill(API_KEY);
  await dash.getByRole("button", { name: /load/i }).click();
  const livePanel = dash.locator("section", { hasText: "Live now" }).first();
  const rosterEntry = livePanel.getByRole("button", { name: new RegExp(sessionId.slice(0, 8)) });
  await expect(rosterEntry).toBeVisible({ timeout: 30_000 });
  await rosterEntry.click();
  await expect(dash.getByRole("heading", { name: /Session replay · live/ })).toBeVisible({
    timeout: 20_000,
  });
  await expect(dash.getByText("● LIVE")).toBeVisible({ timeout: 30_000 });
  const canvas = dash.locator("canvas[data-click-rays-shown]");
  await expect(canvas).toHaveCount(1, { timeout: 20_000 });
  const raysBefore = await readCount(canvas, "data-click-rays-shown");
  const pulsesBefore = await readCount(canvas, "data-click-pulses-shown");

  // 3) Lock the pointer and click three times, 900 ms apart. The page's sends
  //    are held until the third click, so all three reach the dashboard
  //    together, as clicks in one SDK batch (or behind a slow network) do.
  await page.bringToFront();
  const { width, height } = page.viewportSize() ?? { width: 1280, height: 720 };
  const cx = Math.round(width / 2);
  const cy = Math.round(height / 2);
  await page.mouse.click(cx, cy); // the overlay takes this one and engages the lock
  await expect.poll(() => pointerLocked(page), { timeout: 5_000 }).toBe(true);
  // A ray is drawn only for a click that hits something, so aim at the floor a
  // few metres ahead of the spawn point rather than wherever the camera ended up
  // facing when the lock engaged (on CI that was sometimes the open sky).
  await page.waitForTimeout(300);
  await aimAt(page, FLOOR_AHEAD);
  let release!: () => void;
  const held = new Promise<void>((resolve) => (release = resolve));
  await page.route("**/api/v1/collect", async (route) => {
    await held;
    await route.continue();
  });
  for (let i = 0; i < 3; i++) {
    await page.mouse.click(cx, cy);
    if (i < 2) await page.waitForTimeout(900);
  }
  // The route stays in place, passing everything through from here on:
  // removing it would race the held requests it is about to continue.
  release();
  await page.evaluate(() => document.exitPointerLock());

  // 4) The replay draws three rays, as three separate pulses. On a failure the
  //    message says whether the clicks were stored (with the hit point a ray
  //    needs), so a lost ray can be told apart from a lost click.
  const diagnose = async (): Promise<string> => {
    const clicks = (await readSessionEvents(request, sessionId)).filter(
      (e) => e.type === "pointer_click",
    ) as (CapturedEvent & { hitPoint?: unknown })[];
    const withHit = clicks.filter((e) => Array.isArray(e.hitPoint)).length;
    const live =
      (await dash
        .getByText(/● LIVE|reconnecting|connecting/)
        .first()
        .textContent()) ?? "";
    return (
      `stored pointer_click: ${clicks.length} (${withHit} with a hit point); ` +
      `canvas: ${await readCount(canvas, "data-click-rays-shown")} rays, ` +
      `${await readCount(canvas, "data-click-pulses-shown")} pulses (before: ${raysBefore} / ` +
      `${pulsesBefore}); live status: "${live.trim()}"`
    );
  };
  try {
    await expect
      .poll(() => readCount(canvas, "data-click-rays-shown"), { timeout: 30_000 })
      .toBe(raysBefore + 3);
    await expect
      .poll(() => readCount(canvas, "data-click-pulses-shown"), { timeout: 5_000 })
      .toBe(pulsesBefore + 3);
  } catch (err) {
    throw new Error(
      `each click should start its own ray: ${await diagnose()}\n${(err as Error).message}`,
      { cause: err },
    );
  } finally {
    await dashContext.close();
  }
});
