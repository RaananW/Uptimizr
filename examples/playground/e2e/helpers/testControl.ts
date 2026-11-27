/**
 * Drive the playground's test-only control (`window.__playgroundTest`, exposed
 * when the page is opened with `?e2e=1`, which `bootEngine` always adds). Key
 * presses don't reach a page under Pointer Lock in a headless browser, so a spec
 * moves the first-person camera through this instead of walking it.
 */
import { expect, type Page } from "@playwright/test";

import type { PlaygroundTestControl } from "../../src/engine.js";

type Control = { __playgroundTest?: PlaygroundTestControl };

/** The area the playground is tracking now (a section id, or the scene id). */
export function currentScene(page: Page): Promise<string> {
  return page.evaluate(() => (window as unknown as Control).__playgroundTest!.currentScene());
}

/** Stand in the middle of `sectionId` and wait until the playground tracks it. */
export async function enterSection(page: Page, sectionId: string): Promise<void> {
  await page.evaluate(
    (id) => (window as unknown as Control).__playgroundTest!.enterSection(id),
    sectionId,
  );
  await expect.poll(() => currentScene(page), { timeout: 5_000 }).toBe(sectionId);
}

/**
 * Point the camera at a world point. A spec whose clicks must hit something (a
 * replay draws a ray only for a click with a hit point) aims first.
 */
export async function aimAt(page: Page, [x, y, z]: [number, number, number]): Promise<void> {
  await page.evaluate(
    ([px, py, pz]) => (window as unknown as Control).__playgroundTest!.aimCamera(px, py, pz),
    [x, y, z] as const,
  );
}

/** Move the camera to a world point and wait until the playground tracks `expectScene`. */
export async function teleportTo(
  page: Page,
  [x, y, z]: [number, number, number],
  expectScene: string,
): Promise<void> {
  await page.evaluate(
    ([px, py, pz]) => (window as unknown as Control).__playgroundTest!.teleportCamera(px, py, pz),
    [x, y, z] as const,
  );
  await expect.poll(() => currentScene(page), { timeout: 5_000 }).toBe(expectScene);
}
