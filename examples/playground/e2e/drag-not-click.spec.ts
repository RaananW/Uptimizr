import { expect, test } from "@playwright/test";

import { bootEngine, readSessionEvents, waitForEventTypes } from "./helpers/capture.js";

/**
 * A camera drag is not a click (#2 of the demo report). The browser fires a DOM
 * `click` after any press and release on the canvas, including at the end of an
 * orbit drag, and the DOM-click connectors used to record it as a
 * `pointer_click` plus a `mesh_interaction` pick. They now apply Babylon's
 * drag threshold (10 CSS px), so a drag over a mesh records only its
 * `camera_gesture`, while a click in place still records a click and a pick.
 *
 * Drives the real browser → SDK → collector round trip on each engine whose
 * connector captures clicks from the DOM `click` event. Babylon Lite shares the
 * rule but is WebGPU-only, and headless Chromium has no adapter, so its
 * coverage is the connector's unit test.
 */
const DOM_CLICK_ENGINES = ["three", "playcanvas"] as const;

for (const engineId of DOM_CLICK_ENGINES) {
  test(`[${engineId}] an orbit drag records a camera gesture, not a click`, async ({
    page,
    request,
  }) => {
    const sessionId = await bootEngine(page, engineId);
    const { width, height } = page.viewportSize() ?? { width: 1280, height: 720 };
    // The demo box sits at the canvas centre: start every press over it.
    const cx = Math.round(width * 0.5);
    const cy = Math.round(height * 0.52);

    // Three orbit drags that start on the mesh and end well past the threshold.
    for (let d = 0; d < 3; d += 1) {
      await page.mouse.move(cx, cy, { steps: 2 });
      await page.mouse.down();
      for (let i = 1; i <= 6; i += 1) {
        await page.mouse.move(cx + i * 25, cy + i * 5, { steps: 2 });
      }
      await page.mouse.up();
    }

    // The drags arrive as gestures; none of them as a click or a pick.
    await waitForEventTypes(request, sessionId, ["camera_gesture"]);
    const afterDrags = await readSessionEvents(request, sessionId);
    expect(afterDrags.filter((e) => e.type === "pointer_click")).toHaveLength(0);
    expect(afterDrags.filter((e) => e.type === "mesh_interaction")).toHaveLength(0);

    // A real click in place is still a click.
    await page.mouse.click(cx, cy);
    await waitForEventTypes(request, sessionId, ["pointer_click"]);
    const afterClick = await readSessionEvents(request, sessionId);
    expect(afterClick.filter((e) => e.type === "pointer_click")).toHaveLength(1);
  });
}
