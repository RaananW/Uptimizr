import { expect, test } from "@playwright/test";

import { waitForEventTypes, readSessionEvents } from "./helpers/capture.js";

/**
 * Web-export connector round trip (ADR 0045, #111).
 *
 * Unity / Godot / Unreal compile to WebAssembly and render into a bare `<canvas>`
 * with no live JS scene, so they capture in two tiers via `@uptimizr/web-export`:
 *
 *  - a **JS-only tier** (no engine code) — pointer move/click/down/up heatmaps and
 *    rAF `frame_perf`, driven purely from the canvas DOM; and
 *  - a **bridged tier** — a thin engine-side shim pushes world-space pose / picks /
 *    perf across the WASM↔JS boundary (`camera_sample`, `mesh_interaction`).
 *
 * The harness page (`/web-export-e2e.html`) boots the real `@uptimizr/unity`
 * connector and exposes the started session + bridge on `window.__webExport`. This
 * spec drives both tiers and asserts every channel survives the browser → SDK →
 * collector → DuckDB round trip. It covers the shippable JS-only tier end to end.
 */

const REQUIRED = [
  "session_start",
  "pointer_move",
  "pointer_click",
  "pointer_down",
  "pointer_up",
  "frame_perf", // emitted by the JS-only rAF loop and by bridge.pushPerf
  "camera_sample", // bridge.pushPose
  "mesh_interaction", // bridge.pushPick
] as const;

test("web-export JS-only tier + bridge round-trips to the collector", async ({ page, request }) => {
  await page.goto("/web-export-e2e.html");

  // The connector starts synchronously on load and stamps an in-memory session id.
  await page.waitForFunction(() => typeof window.__webExport?.sessionId === "string");
  const sessionId = await page.evaluate(() => window.__webExport!.sessionId);
  expect(sessionId, "web-export session id should be stamped").toBeTruthy();

  // --- JS-only tier: synthesize real DOM pointer input over the canvas ---
  const canvas = page.locator("#webExportCanvas");
  await canvas.waitFor();
  // Several moves (throttled to 250ms in the tier) plus a down/up/click cycle.
  for (const [fx, fy] of [
    [0.3, 0.4],
    [0.5, 0.5],
    [0.7, 0.6],
  ] as const) {
    const box = (await canvas.boundingBox())!;
    await page.mouse.move(box.x + box.width * fx, box.y + box.height * fy);
    await page.waitForTimeout(300); // clear the pointer-move throttle window
  }
  const box = (await canvas.boundingBox())!;
  await page.mouse.move(box.x + box.width * 0.5, box.y + box.height * 0.5);
  await page.mouse.down();
  await page.mouse.up(); // down + up + click

  // --- Bridged tier: push world-space samples exactly as an engine shim would ---
  await page.evaluate(() => {
    const b = window.__webExport!.bridge!;
    // protocolVersion lets a shim assert compatibility before pushing.
    if (b.protocolVersion !== 1) throw new Error(`unexpected bridge version ${b.protocolVersion}`);
    b.pushPose([0, 1.6, 0], [0, 0, 1], [0, 1, 0], Math.PI / 3);
    b.pushPose([1, 1.6, 2], [0, 0, -1], [0, 1, 0], Math.PI / 3);
    b.pushPick("crate", [2, 0.5, 3]);
    b.pushPerf(60, 0);
  });

  const seen = await waitForEventTypes(request, sessionId, REQUIRED);
  for (const type of REQUIRED) {
    expect(seen, `web-export should capture ${type}`).toContain(type);
  }

  // The bridge is the single normalization point: Unity's native frame is canonical
  // (left-handed, y-up, meters), so the pushed pick survives unchanged.
  const events = await readSessionEvents(request, sessionId);
  const pick = events.find((e) => e.type === "mesh_interaction") as unknown as
    | { mesh?: string; point?: number[] }
    | undefined;
  expect(pick?.mesh, "pick carries the developer-named object").toBe("crate");
  expect(pick?.point, "Unity pick point is canonical (identity)").toEqual([2, 0.5, 3]);

  // The session is attributed to the unity connector (provenance, ADR 0018).
  const start = events.find((e) => e.type === "session_start") as unknown as
    | { connector?: { name?: string } }
    | undefined;
  expect(start?.connector?.name).toBe("unity");
});
