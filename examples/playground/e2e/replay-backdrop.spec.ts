import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { expect, test } from "@playwright/test";

import { driveInteractions, openControls } from "./helpers/capture.js";

/**
 * Issue #80 — replay over a loaded `.glb` backdrop.
 *
 * The Babylon engine exposes a "Load a .glb backdrop" control that loads an
 * arbitrary asset into the scene via `@uptimizr/replay/babylon`'s
 * `loadSceneBackdrop`, then the existing replay path re-drives the captured
 * session (camera / pointer / picks + actor `node_transform`, ADR 0033) over it.
 *
 * This spec drives the real browser → SDK → collector → replay round trip:
 * it captures a short session, loads `models/Fox.glb` as a backdrop, and replays
 * the session over the loaded model — asserting the backdrop meshes are present
 * and that replay completes.
 */

// A small (~160 KB) glTF binary shipped with the playground, read off disk so
// Playwright can hand it to the `<input type="file">` backdrop control.
const FOX_GLB = resolve(dirname(fileURLToPath(import.meta.url)), "../public/models/Fox.glb");

test("[babylon] loads a .glb backdrop and replays a session over it", async ({ page }) => {
  await page.goto("/?engine=babylon");

  // Collector reachable + session stamped.
  await expect(page.locator("#connDot")).toHaveClass(/ok/);
  await expect(page.locator("#sessionId")).not.toHaveText("…");

  // Capture a short session (camera moves, a pick, a scene switch).
  await driveInteractions(page);

  // The backdrop control lives in the controls panel (Babylon-only capability).
  await openControls(page);
  await expect(page.locator("#backdropSection")).toBeVisible();

  // Load Fox.glb as the scene backdrop.
  await page.locator("#backdropFile").setInputFiles(FOX_GLB);
  await page.locator("#backdropButton").click();

  // The status confirms the model loaded with a positive mesh count.
  const backdropStatus = page.locator("#backdropStatus");
  await expect(backdropStatus).toContainText(/Backdrop loaded/i, { timeout: 20_000 });
  const statusText = (await backdropStatus.textContent()) ?? "";
  const meshCount = Number(/\((\d+)\s+meshes\)/.exec(statusText)?.[1] ?? "0");
  expect(meshCount).toBeGreaterThan(0);

  // The "Remove backdrop" button is enabled once a backdrop is loaded.
  await expect(page.locator("#backdropClearButton")).toBeEnabled();

  // Flush the live session, then replay it by its own id — re-driving the
  // captured camera/pointer events over the loaded Fox model.
  const flushed = page.waitForResponse(
    (res) =>
      res.url().includes("/api/v1/collect") &&
      res.request().method() === "POST" &&
      res.status() === 200,
  );
  await page.locator("#replayCurrentButton").click();
  await flushed;

  // Replay runs to completion against the backdrop-augmented scene.
  await expect(page.locator("#status")).toContainText(/Replay complete/i, { timeout: 20_000 });
});

test("[babylon] re-drives a walkable session with an actor over a backdrop", async ({ page }) => {
  // The first-person walkable scene loads a rigged NPC driven as an actor
  // (`node_transform`, ADR 0033). Loading a backdrop on top and replaying
  // confirms actor/subtree re-drive coexists with a freshly loaded model.
  await page.goto("/?engine=babylon&camera=first-person");

  await expect(page.locator("#connDot")).toHaveClass(/ok/);
  await expect(page.locator("#cameraMode")).toHaveText("first-person");
  await expect(page.locator("#sessionId")).not.toHaveText("…");

  // Walk a little so the session has camera motion to re-drive.
  const { width, height } = page.viewportSize() ?? { width: 1280, height: 720 };
  await page.mouse.click(Math.round(width * 0.6), Math.round(height * 0.72));
  for (const key of ["KeyW", "KeyD"]) {
    await page.keyboard.down(key);
    await page.waitForTimeout(350);
    await page.keyboard.up(key);
  }

  await openControls(page);
  await page.locator("#backdropFile").setInputFiles(FOX_GLB);
  await page.locator("#backdropButton").click();
  await expect(page.locator("#backdropStatus")).toContainText(/Backdrop loaded/i, {
    timeout: 20_000,
  });

  const flushed = page.waitForResponse(
    (res) =>
      res.url().includes("/api/v1/collect") &&
      res.request().method() === "POST" &&
      res.status() === 200,
  );
  await page.locator("#replayCurrentButton").click();
  await flushed;

  await expect(page.locator("#status")).toContainText(/Replay complete/i, { timeout: 20_000 });
});
