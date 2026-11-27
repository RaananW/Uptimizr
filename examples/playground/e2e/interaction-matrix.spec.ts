import { expect, test, type Page } from "@playwright/test";

import { serveAframeFromCache } from "./helpers/aframe.js";
import { bootEngine, enableAllCapture, readSessionEvents } from "./helpers/capture.js";
import { enterSection, teleportTo } from "./helpers/testControl.js";

/**
 * Every click counts, and nothing else does: engine × camera mode × gesture.
 *
 * Each case boots one engine in one scene, performs a fixed list of gestures,
 * and counts what it did. The stored session must then hold exactly that many
 * `pointer_click`s per gesture — one for a click, none for a camera drag, five
 * for a burst of five — and no pick for a gesture that made no click. The other
 * capture specs only check that a kind of event arrived, so a connector that
 * kept 3 of 10 clicks, or recorded a drag as a click, passed them.
 *
 * Every batch the page sends must also be accepted. The harness keeps the
 * collector's default ingest rate limit, so a scene that sends too often (an
 * animated character streaming `node_transform`s) shows up here as refused
 * batches, as it would in production.
 *
 * The camera modes:
 * - **orbit** — a viewer scene with an orbit camera: dragging moves the camera.
 * - **locked** — a first-person scene under Pointer Lock (three.js, PlayCanvas):
 *   the click is aimed with the crosshair, and moving the mouse with the button
 *   held is looking around, so it is still a click.
 * - **drag-look** — Babylon's first-person camera, which looks by dragging
 *   without a lock: a drag is not a click.
 *
 * In the large `expanse` scene each case also moves into another section and
 * back (through the playground's test control, `?e2e=1`), and each click there
 * must count and be tagged with the section it was made in.
 *
 * Pull requests run a subset; `E2E_MATRIX=full` runs every engine in every
 * scene it builds. Babylon Lite is WebGPU-only and headless Chromium has no
 * adapter, so it is covered by its connector's unit tests.
 */

type Mode = "orbit" | "locked" | "drag-look";

interface MatrixCase {
  engine: string;
  scene: string;
  mode: Mode;
}

const PR_CASES: MatrixCase[] = [
  { engine: "babylon", scene: "lobby", mode: "orbit" },
  { engine: "three", scene: "lobby", mode: "orbit" },
  { engine: "playcanvas", scene: "lobby", mode: "orbit" },
  { engine: "r3f", scene: "lobby", mode: "orbit" },
  { engine: "aframe", scene: "lobby", mode: "orbit" },
  { engine: "babylon", scene: "atrium", mode: "drag-look" },
  { engine: "three", scene: "atrium", mode: "locked" },
  { engine: "playcanvas", scene: "atrium", mode: "locked" },
  { engine: "three", scene: "expanse", mode: "locked" },
];

const FULL_ONLY_CASES: MatrixCase[] = [
  { engine: "babylon", scene: "showcase", mode: "orbit" },
  { engine: "three", scene: "showcase", mode: "orbit" },
  { engine: "playcanvas", scene: "showcase", mode: "orbit" },
  { engine: "babylon", scene: "gallery", mode: "drag-look" },
  { engine: "three", scene: "gallery", mode: "locked" },
  { engine: "playcanvas", scene: "gallery", mode: "locked" },
  { engine: "babylon", scene: "expanse", mode: "drag-look" },
  { engine: "playcanvas", scene: "expanse", mode: "locked" },
];

const CASES = process.env.E2E_MATRIX === "full" ? [...PR_CASES, ...FULL_ONLY_CASES] : PR_CASES;

/** A point in the viewport, as fractions of its size. */
interface At {
  x: number;
  y: number;
}

interface GestureContext {
  page: Page;
  at(fx: number, fy: number): At;
  /** Where the scene's pick target sits (the demo box in viewer scenes). */
  target: At;
}

interface Gesture {
  name: string;
  /** How many `pointer_click`s the gesture must record. */
  clicks: number;
  /** The area those clicks must be tagged with (`sceneId`), when it matters. */
  scene?: string;
  run(ctx: GestureContext): Promise<void>;
}

/** Press, move `dx, dy` in `steps` moves, release. */
async function dragBy(page: Page, from: At, dx: number, dy: number, steps = 6): Promise<void> {
  await page.mouse.move(from.x, from.y, { steps: 2 });
  await page.mouse.down();
  for (let i = 1; i <= steps; i += 1) {
    await page.mouse.move(from.x + (dx * i) / steps, from.y + (dy * i) / steps, { steps: 2 });
  }
  await page.mouse.up();
}

async function clickBurst(page: Page, p: At, n: number, gapMs: number): Promise<void> {
  for (let i = 0; i < n; i += 1) {
    await page.mouse.click(p.x, p.y);
    if (i < n - 1) await page.waitForTimeout(gapMs);
  }
}

async function pointerLocked(page: Page): Promise<boolean> {
  return page.evaluate(() => document.pointerLockElement != null);
}

const ORBIT_GESTURES: Gesture[] = [
  {
    name: "click on the target",
    clicks: 1,
    run: ({ page, target }) => page.mouse.click(target.x, target.y),
  },
  {
    name: "click on empty space",
    clicks: 1,
    run: async ({ page, at }) => {
      const p = at(0.85, 0.3);
      await page.mouse.click(p.x, p.y);
    },
  },
  {
    // Hands shake: a press and release a few pixels apart is still a click.
    name: "click with a 6 px wobble",
    clicks: 1,
    run: ({ page, target }) => dragBy(page, target, 4, 4, 2),
  },
  {
    name: "orbit drag starting on the target",
    clicks: 0,
    run: ({ page, target }) => dragBy(page, target, 150, 30),
  },
  {
    // The DOM click lands on the target; only the drag rule keeps it out.
    name: "orbit drag ending on the target",
    clicks: 0,
    run: ({ page, target }) => dragBy(page, { x: target.x - 160, y: target.y + 30 }, 160, -30),
  },
  {
    name: "burst of 5 clicks",
    clicks: 5,
    run: ({ page, target }) => clickBurst(page, target, 5, 220),
  },
  {
    name: "wheel zoom",
    clicks: 0,
    run: async ({ page, target }) => {
      await page.mouse.move(target.x, target.y);
      await page.mouse.wheel(0, -240);
      await page.mouse.wheel(0, 200);
    },
  },
];

const LOCKED_GESTURES: Gesture[] = [
  {
    // The overlay takes the lock-engaging click, so it never reaches the canvas.
    name: "engage the lock from the overlay",
    clicks: 0,
    run: async ({ page, at }) => {
      const c = at(0.5, 0.5);
      await page.mouse.click(c.x, c.y);
      await expect.poll(() => pointerLocked(page), { timeout: 5_000 }).toBe(true);
    },
  },
  {
    name: "locked click",
    clicks: 1,
    run: async ({ page, at }) => {
      const c = at(0.5, 0.5);
      await page.mouse.click(c.x, c.y);
    },
  },
  {
    // Turning with the button held is aiming, not dragging.
    name: "locked click while turning",
    clicks: 1,
    run: ({ page, at }) => dragBy(page, at(0.5, 0.5), 120, 10),
  },
  {
    name: "burst of 5 locked clicks",
    clicks: 5,
    run: ({ page, at }) => clickBurst(page, at(0.5, 0.5), 5, 220),
  },
  {
    name: "release the lock and engage it again",
    clicks: 0,
    run: async ({ page, at }) => {
      await page.evaluate(() => document.exitPointerLock());
      await expect.poll(() => pointerLocked(page), { timeout: 5_000 }).toBe(false);
      await expect(page.locator(".lock-overlay")).toBeVisible();
      // Chromium refuses a re-lock straight after an exit.
      await page.waitForTimeout(1_200);
      const c = at(0.5, 0.5);
      await page.mouse.click(c.x, c.y);
      await expect.poll(() => pointerLocked(page), { timeout: 5_000 }).toBe(true);
    },
  },
  {
    name: "locked click after engaging again",
    clicks: 1,
    run: async ({ page, at }) => {
      const c = at(0.5, 0.5);
      await page.mouse.click(c.x, c.y);
    },
  },
];

const DRAG_LOOK_GESTURES: Gesture[] = [
  {
    name: "click",
    clicks: 1,
    run: async ({ page, at }) => {
      const c = at(0.5, 0.5);
      await page.mouse.click(c.x, c.y);
    },
  },
  {
    name: "look drag",
    clicks: 0,
    run: ({ page, at }) => dragBy(page, at(0.4, 0.5), 160, 20),
  },
  {
    name: "click with a 6 px wobble",
    clicks: 1,
    run: ({ page, at }) => dragBy(page, at(0.5, 0.5), 4, 4, 2),
  },
  {
    name: "burst of 5 clicks",
    clicks: 5,
    run: ({ page, at }) => clickBurst(page, at(0.5, 0.5), 5, 220),
  },
];

/**
 * Large scenes: move to another section and click there, then back. The click
 * must count, and must be tagged with the section it was made in. The camera
 * moves through the playground's test control, because key presses don't reach a
 * page under Pointer Lock in a headless browser.
 */
const EXPANSE_SPAWN: [number, number, number] = [0, 1.8, -260];
const SECTION_GESTURES: Gesture[] = [
  {
    name: "walk into the gardens",
    clicks: 0,
    run: ({ page }) => enterSection(page, "expanse-gardens"),
  },
  {
    name: "click in the gardens",
    clicks: 1,
    scene: "expanse-gardens",
    run: async ({ page, at }) => {
      const c = at(0.5, 0.5);
      await page.mouse.click(c.x, c.y);
    },
  },
  {
    name: "walk back to the plaza",
    clicks: 0,
    run: ({ page }) => teleportTo(page, EXPANSE_SPAWN, "expanse-plaza"),
  },
  {
    name: "click in the plaza",
    clicks: 1,
    scene: "expanse-plaza",
    run: async ({ page, at }) => {
      const c = at(0.5, 0.5);
      await page.mouse.click(c.x, c.y);
    },
  },
];

const GESTURES: Record<Mode, Gesture[]> = {
  orbit: ORBIT_GESTURES,
  locked: LOCKED_GESTURES,
  "drag-look": DRAG_LOOK_GESTURES,
};

/** Where each engine's demo box sits in the lobby, as viewport fractions. */
function targetFor(c: MatrixCase): { fx: number; fy: number } {
  if (c.engine === "aframe") return { fx: 0.5, fy: 0.55 };
  return { fx: 0.5, fy: 0.52 };
}

/** Time between gestures, so a late event can't land in the next one's window. */
const SETTLE_MS = 600;
/** How long after a gesture ends its events may still be stamped. */
const WINDOW_TAIL_MS = 450;
/** Past the SDK's 3 s flush, so anything sent late has arrived. */
const FLUSH_WAIT_MS = 4_000;

for (const c of CASES) {
  test(`[${c.engine} · ${c.scene} · ${c.mode}] every click counts, nothing else does`, async ({
    page,
    request,
  }) => {
    test.setTimeout(90_000);
    if (c.engine === "aframe") await serveAframeFromCache(page);
    else await enableAllCapture(page, c.engine);
    // Delivery, for the failure message: a whole gesture with nothing stored is
    // a refused batch (a 429 from the ingest rate limit, say), not a lost click.
    const collect = { sent: 0, refused: new Map<number, number>() };
    page.on("response", (r) => {
      if (!r.url().includes("/api/v1/collect") || r.request().method() !== "POST") return;
      collect.sent += 1;
      if (!r.ok()) collect.refused.set(r.status(), (collect.refused.get(r.status()) ?? 0) + 1);
    });
    const sessionId = await bootEngine(page, c.engine, c.scene);
    if (c.mode === "locked") await expect(page.locator(".lock-overlay")).toBeVisible();
    // Let the scene finish loading its meshes before aiming at them.
    await page.waitForTimeout(1_500);

    const { width, height } = page.viewportSize() ?? { width: 1280, height: 720 };
    const at = (fx: number, fy: number): At => ({
      x: Math.round(width * fx),
      y: Math.round(height * fy),
    });
    const t = targetFor(c);
    const ctx: GestureContext = { page, at, target: at(t.fx, t.fy) };

    // Run each gesture, stamping its window on the page's clock (the SDK's).
    const windows: { gesture: Gesture; from: number; to: number }[] = [];
    const gestures = [...GESTURES[c.mode], ...(c.scene === "expanse" ? SECTION_GESTURES : [])];
    for (const gesture of gestures) {
      const from = await page.evaluate(() => Date.now());
      await gesture.run(ctx);
      const to = await page.evaluate(() => Date.now());
      windows.push({ gesture, from, to: to + WINDOW_TAIL_MS });
      await page.waitForTimeout(SETTLE_MS);
    }
    if (c.mode === "locked") await page.evaluate(() => document.exitPointerLock());

    // Wait for the expected total (or give up and let the per-gesture table
    // below say which gesture lost clicks), then one more flush so extras show.
    const expectedTotal = windows.reduce((n, w) => n + w.gesture.clicks, 0);
    for (const deadline = Date.now() + 20_000; Date.now() < deadline;) {
      const stored = (await readSessionEvents(request, sessionId)).filter(
        (e) => e.type === "pointer_click",
      ).length;
      if (stored >= expectedTotal) break;
      await page.waitForTimeout(750);
    }
    await page.waitForTimeout(FLUSH_WAIT_MS);
    const events = await readSessionEvents(request, sessionId);

    // Attribute every click and pick to the gesture whose window holds it.
    const counted = (type: string, w: { from: number; to: number }): number =>
      events.filter((e) => e.type === type && e.ts >= w.from && e.ts <= w.to).length;
    const actual = windows.map((w) => ({
      gesture: w.gesture.name,
      clicks: counted("pointer_click", w),
      picks: counted("mesh_interaction", w),
      // For the failure table: whether the presses arrived, and whether
      // anything at all was stored during the gesture.
      downs: counted("pointer_down", w),
      ups: counted("pointer_up", w),
      all: events.filter((e) => e.ts >= w.from && e.ts <= w.to).length,
    }));
    const outside = events.filter(
      (e) =>
        (e.type === "pointer_click" || e.type === "mesh_interaction") &&
        !windows.some((w) => e.ts >= w.from && e.ts <= w.to),
    );

    const table = actual
      .map(
        (a, i) =>
          `  ${a.gesture}: ${a.clicks} click(s), expected ${windows[i]!.gesture.clicks}` +
          ` (${a.downs} down, ${a.ups} up, ${a.picks} pick, ${a.all} events stored)`,
      )
      .join("\n");
    const refused = [...collect.refused].map(([status, n]) => `${n}× ${status}`).join(", ");
    const delivery = `${collect.sent} batches sent${refused ? `, refused: ${refused}` : ""}`;
    expect(
      actual.map((a) => a.clicks),
      `pointer_click per gesture (${delivery}):\n${table}`,
    ).toEqual(windows.map((w) => w.gesture.clicks));
    // Every batch must get through: the SDK paces its sends to stay under the
    // collector's default ingest rate limit, which this harness keeps.
    expect(refused, "no batch refused by the collector").toBe("");
    // A click is tagged with the area it was made in.
    for (const w of windows) {
      if (!w.gesture.scene) continue;
      const scenes = events
        .filter((e) => e.type === "pointer_click" && e.ts >= w.from && e.ts <= w.to)
        .map((e) => e.sceneId);
      expect(scenes, `"${w.gesture.name}" clicks should be tagged with their area`).toEqual(
        scenes.map(() => w.gesture.scene),
      );
    }
    // A gesture that made no click makes no pick either.
    for (const [i, a] of actual.entries()) {
      if (windows[i]!.gesture.clicks === 0) {
        expect(a.picks, `"${a.gesture}" should record no pick`).toBe(0);
      }
    }
    expect(
      outside.map((e) => `${e.type}@${e.ts}`),
      "no click or pick outside a gesture",
    ).toEqual([]);
  });
}
