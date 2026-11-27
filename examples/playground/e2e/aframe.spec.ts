import { expect, test } from "@playwright/test";

import { API_KEY, COLLECTOR_URL } from "./constants.js";
import { serveAframeFromCache } from "./helpers/aframe.js";
import { bootEngine, readSessionEvents, waitForEventTypes } from "./helpers/capture.js";

/**
 * A-Frame capture round trip (#12). The playground loads A-Frame from its official
 * CDN; `serveAframeFromCache` serves it from a per-run in-memory copy.
 *
 * A-Frame is declarative: the `uptimizr` component owns the client, so there is no
 * capture panel — the three connector's defaults apply (camera, pointer, clicks,
 * buttons, mesh picks, perf, camera gestures). WebXR itself has no headless
 * trigger; the XR collector is covered by unit tests in `@uptimizr/three` and
 * `@uptimizr/aframe`.
 */

const REQUIRED = [
  "session_start",
  "frame_perf",
  "camera_sample", // look-controls drag rotates the camera → poses flow
  "camera_gesture", // …and the drag classifies as a navigation gesture (ADR 0025)
  "pointer_move",
  "pointer_down",
  "pointer_up",
  "pointer_click",
  "mesh_interaction", // click on the centre box (named via the `named-mesh` component)
] as const;

test("[aframe] captures the interaction set end to end", async ({ page, request }) => {
  await serveAframeFromCache(page);

  const sessionId = await bootEngine(page, "aframe");

  const canvas = page.locator("a-scene canvas.a-canvas");
  await canvas.waitFor();
  const box = (await canvas.boundingBox())!;
  const at = (fx: number, fy: number): { x: number; y: number } => ({
    x: box.x + box.width * fx,
    y: box.y + box.height * fy,
  });

  // Pointer moves (throttled to 250 ms) across the lower canvas.
  for (const [fx, fy] of [
    [0.4, 0.7],
    [0.55, 0.72],
    [0.7, 0.66],
  ] as const) {
    const p = at(fx, fy);
    await page.mouse.move(p.x, p.y, { steps: 4 });
    await page.waitForTimeout(300);
  }

  // Click the centre box. The camera sits at (0, 1.6, 4) looking down −Z and
  // `box-1` is at (0, 1, −4), so it lands just below screen centre.
  const target = at(0.5, 0.55);
  await page.mouse.move(target.x, target.y, { steps: 4 });
  await page.mouse.click(target.x, target.y);

  // Discrete down/up off-centre to bracket button capture.
  const side = at(0.7, 0.66);
  await page.mouse.move(side.x, side.y, { steps: 2 });
  await page.mouse.down();
  await page.mouse.up();

  // Look-controls drag → the camera rotates (camera_sample) and the drag classifies
  // as a camera_gesture.
  const from = at(0.3, 0.6);
  await page.mouse.move(from.x, from.y, { steps: 2 });
  await page.mouse.down();
  for (let i = 1; i <= 8; i += 1) {
    await page.mouse.move(from.x + i * 30, from.y + i * 6, { steps: 2 });
    await page.waitForTimeout(40);
  }
  await page.mouse.up();

  const seen = await waitForEventTypes(request, sessionId, REQUIRED);
  for (const type of REQUIRED) {
    expect(seen, `aframe should capture ${type}`).toContain(type);
  }

  const events = await readSessionEvents(request, sessionId);

  // The session is attributed to the aframe connector (provenance, ADR 0018).
  const start = events.find((e) => e.type === "session_start") as unknown as
    { connector?: { name?: string } } | undefined;
  expect(start?.connector?.name).toBe("aframe");

  // The pick carries the entity id the playground copies onto the mesh name.
  const pick = events.find((e) => e.type === "mesh_interaction") as unknown as
    { mesh?: string } | undefined;
  expect(pick?.mesh).toBe("box-1");

  const sources = new Set(
    events.map((e) => e.source).filter((s): s is string => typeof s === "string"),
  );
  expect(sources).toContain("mouse");

  // The declarative `sceneId` attribute tags every event (ADR 0010, #259).
  const scenes = new Set(
    events.map((e) => e.sceneId).filter((s): s is string => typeof s === "string"),
  );
  expect(scenes).toContain("lobby");

  const counts = await request
    .get(`${COLLECTOR_URL}/api/v1/event-counts?session=${sessionId}`, {
      headers: { "x-api-key": API_KEY },
    })
    .then((r) => r.json() as Promise<{ event_type: string; count: number }[]>);
  const countedTypes = new Set(counts.map((c) => c.event_type));
  expect(countedTypes).toContain("pointer_click");
  expect(countedTypes).toContain("mesh_interaction");
});
