import { expect, test, type Frame, type Page } from "@playwright/test";

/**
 * The built demo, end to end: playground → service-worker collector → DuckDB-Wasm
 * → dashboard. Each case clicks and drags in the playground and checks the stored
 * session holds exactly the clicks made (none for a camera drag). The lobby cases
 * then open the session in the dashboard and check the view re-reads it when a
 * new click lands, without leaving and coming back.
 *
 * The demo runs its own collector in a service worker, separate from the real
 * server the playground specs use, which is why it gets its own smoke test.
 */

/** The demo's one project accepts this key (see `src/store/constants.ts`). */
const DEMO_KEY = "demo-read-key";

interface StoredEvent {
  type: string;
  ts: number;
}

interface Point {
  x: number;
  y: number;
}

test.beforeEach(async ({ page }) => {
  // The guide is on for a first visit; its overlay is not what these test.
  await page.addInitScript(() => {
    try {
      localStorage.setItem("uptimizr.demo.guide.enabled", "false");
    } catch {
      /* storage blocked: the guide just shows */
    }
  });
  await page.goto("/");
  await page.getByRole("button", { name: "Prepare demo" }).click();
  await expect(page.locator("iframe[title='Uptimizr dashboard']")).toBeVisible({
    timeout: 90_000,
  });
});

function playgroundFrame(page: Page): Frame {
  const frame = page.frames().find((f) => f.url().includes("/playground/"));
  if (!frame) throw new Error("no playground frame");
  return frame;
}

/** Load `engine` in `scene` in the playground pane and return its session id. */
async function startPlayground(page: Page, engine: string, scene: string): Promise<string> {
  const frame = playgroundFrame(page);
  await frame.goto(`/playground/index.html?engine=${engine}&scene=${scene}`);
  const sessionId = frame.locator("#sessionId");
  await expect(sessionId).not.toHaveText("…", { timeout: 60_000 });
  // Let the scene finish loading its meshes before aiming at them.
  await page.waitForTimeout(2_000);
  return ((await sessionId.textContent()) ?? "").trim();
}

/** A point in the playground pane, as fractions of its size, in page coordinates. */
async function inPlayground(page: Page, fx: number, fy: number): Promise<Point> {
  const box = await page.locator("iframe[title='Uptimizr playground']").boundingBox();
  if (!box) throw new Error("playground pane not laid out");
  return { x: Math.round(box.x + box.width * fx), y: Math.round(box.y + box.height * fy) };
}

/** The session as the demo stored it, read through its service-worker API. */
async function stored(page: Page, sessionId: string): Promise<StoredEvent[]> {
  return playgroundFrame(page).evaluate(
    async ([id, key]) => {
      const res = await fetch(`/api/v1/sessions/${id}/events`, { headers: { "x-api-key": key } });
      return res.ok ? ((await res.json()) as { type: string; ts: number }[]) : [];
    },
    [sessionId, DEMO_KEY] as const,
  );
}

const clicksIn = (events: StoredEvent[]): number =>
  events.filter((e) => e.type === "pointer_click").length;

/** Wait until the stored session holds `n` clicks, then check no extra one lands later. */
async function expectStoredClicks(page: Page, sessionId: string, n: number): Promise<void> {
  await expect
    .poll(async () => clicksIn(await stored(page, sessionId)), { timeout: 30_000 })
    .toBeGreaterThanOrEqual(n);
  await page.waitForTimeout(4_000); // past the SDK's flush interval
  expect(clicksIn(await stored(page, sessionId)), "no extra pointer_click").toBe(n);
}

async function drag(page: Page, from: Point, dx: number): Promise<void> {
  await page.mouse.move(from.x, from.y, { steps: 2 });
  await page.mouse.down();
  for (let i = 1; i <= 6; i++) await page.mouse.move(from.x + (dx * i) / 6, from.y, { steps: 2 });
  await page.mouse.up();
}

/**
 * Open the session from the dashboard's live roster, then click once more in
 * the playground: the session view must re-read the session and see that click.
 */
async function expectSessionViewFollows(
  page: Page,
  sessionId: string,
  clickAt: Point,
  clicksAfter: number,
): Promise<void> {
  const dash = page.frameLocator("iframe[title='Uptimizr dashboard']");
  await dash
    .getByRole("button", { name: new RegExp(sessionId.slice(0, 8)) })
    .first()
    .click({ timeout: 30_000 });
  const reread = page.waitForResponse(
    async (r) => {
      if (!r.url().includes(`/api/v1/sessions/${sessionId}/events`)) return false;
      // The dashboard's own read, not the spec's (which goes through the playground frame).
      if (r.frame().url().includes("/playground/")) return false;
      try {
        return clicksIn((await r.json()) as StoredEvent[]) >= clicksAfter;
      } catch {
        return false;
      }
    },
    { timeout: 30_000 },
  );
  await page.waitForTimeout(1_500);
  await page.mouse.click(clickAt.x, clickAt.y);
  await reread;
}

/**
 * Click the playground's "click to explore" overlay until the pointer is locked.
 * On a slow runner the first click sometimes did not take within 5 s. Clicking
 * the overlay again is safe: the overlay keeps its click off the canvas, so it is
 * never recorded.
 */
async function engageLock(page: Page, frame: Frame, at: Point): Promise<void> {
  const locked = (): Promise<boolean> => frame.evaluate(() => document.pointerLockElement != null);
  for (let attempt = 0; attempt < 3; attempt++) {
    if (await frame.locator(".lock-overlay:not(.lock-overlay--hidden)").isVisible()) {
      await page.mouse.click(at.x, at.y);
    }
    try {
      await expect.poll(locked, { timeout: 10_000 }).toBe(true);
      return;
    } catch {
      /* try the overlay again */
    }
  }
  throw new Error("the pointer lock never engaged");
}

for (const engine of ["three", "babylon"] as const) {
  test(`[${engine} · lobby] clicks are stored, drags are not, the session view follows`, async ({
    page,
  }) => {
    const sessionId = await startPlayground(page, engine, "lobby");
    const box = await inPlayground(page, 0.5, 0.52);

    for (let i = 0; i < 3; i++) {
      await page.mouse.click(box.x, box.y);
      await page.waitForTimeout(300);
    }
    await drag(page, box, 180); // an orbit drag: no click
    await drag(page, { x: box.x - 180, y: box.y }, 180); // …even one that ends on the box
    for (let i = 0; i < 3; i++) {
      await page.mouse.click(box.x, box.y);
      await page.waitForTimeout(220);
    }
    await expectStoredClicks(page, sessionId, 6);
    await expectSessionViewFollows(page, sessionId, box, 7);
  });
}

test("[three · atrium · locked] every locked click is stored", async ({ page }) => {
  const sessionId = await startPlayground(page, "three", "atrium");
  const centre = await inPlayground(page, 0.5, 0.5);
  const frame = playgroundFrame(page);

  await engageLock(page, frame, centre);
  for (let i = 0; i < 3; i++) {
    await page.mouse.click(centre.x, centre.y);
    await page.waitForTimeout(300);
  }
  // Clicking while turning is covered per engine by the playground's interaction
  // matrix; here a drag's mouse moves took seconds each on a SwiftShader runner.
  await frame.evaluate(() => document.exitPointerLock());
  await expectStoredClicks(page, sessionId, 3);
});
