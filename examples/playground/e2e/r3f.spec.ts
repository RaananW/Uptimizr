import { expect, test } from "@playwright/test";

import { API_KEY, COLLECTOR_URL } from "./constants.js";
import {
  bootEngine,
  enableAllCapture,
  readSessionEvents,
  waitForEventTypes,
} from "./helpers/capture.js";

/**
 * react-three-fiber capture round trip (#12). R3F renders through three but owns
 * its own `<Canvas>` inside `#engineRoot` (not the shared `#renderCanvas`) and
 * exposes neither the scene switcher nor replay, so it cannot ride the shared
 * `driveInteractions` flow. This spec drives the interaction set the R3F
 * playground does support — pointer move/down/up/click over its canvas and a
 * centre pick of the box the auto-rotating camera always looks at — and asserts
 * every channel survives the browser → SDK → collector → DuckDB round trip.
 */

const REQUIRED = [
  "session_start",
  "frame_perf",
  "camera_sample", // the playground auto-rotates the camera, so poses keep flowing
  "pointer_move",
  "pointer_down",
  "pointer_up",
  "pointer_click",
  "mesh_interaction", // centre pick → the box at the camera's look-at target
  "custom", // the playground's `box_picked` event
] as const;

test("[r3f] captures the interaction set end to end", async ({ page, request }) => {
  await enableAllCapture(page, "r3f");
  const sessionId = await bootEngine(page, "r3f");

  // R3F mounts its own canvas inside the engine root.
  const canvas = page.locator("#engineRoot canvas");
  await canvas.waitFor();
  const box = (await canvas.boundingBox())!;
  const at = (fx: number, fy: number): { x: number; y: number } => ({
    x: box.x + box.width * fx,
    y: box.y + box.height * fy,
  });

  // Pointer moves (throttled to 250 ms in the connector) across the lower canvas.
  for (const [fx, fy] of [
    [0.4, 0.7],
    [0.55, 0.72],
    [0.7, 0.66],
  ] as const) {
    const p = at(fx, fy);
    await page.mouse.move(p.x, p.y, { steps: 4 });
    await page.waitForTimeout(300);
  }

  // Centre pick: the camera orbits around (0, 1, 0), where the middle box sits, so
  // the screen centre always resolves to it → mesh_interaction + `box_picked`.
  const centre = at(0.5, 0.5);
  await page.mouse.move(centre.x, centre.y, { steps: 4 });
  await page.mouse.click(centre.x, centre.y);

  // Discrete down/up off-centre to bracket button capture.
  const side = at(0.7, 0.66);
  await page.mouse.move(side.x, side.y, { steps: 2 });
  await page.mouse.down();
  await page.mouse.up();

  const seen = await waitForEventTypes(request, sessionId, REQUIRED);
  for (const type of REQUIRED) {
    expect(seen, `r3f should capture ${type}`).toContain(type);
  }

  const events = await readSessionEvents(request, sessionId);

  // The session is attributed to the r3f connector (provenance, ADR 0018).
  const start = events.find((e) => e.type === "session_start") as unknown as
    { connector?: { name?: string } } | undefined;
  expect(start?.connector?.name).toBe("r3f");

  // The connector's own raycast (mesh_interaction) agrees with R3F's event system
  // (the playground's `box_picked` custom event) on which box the centre click hit.
  const pick = events.find((e) => e.type === "mesh_interaction") as unknown as
    { mesh?: string } | undefined;
  const picked = events.find((e) => e.type === "custom") as unknown as
    { name?: string; props?: { box?: string } } | undefined;
  expect(picked?.name).toBe("box_picked");
  expect(picked?.props?.box).toMatch(/^box-\d+$/);
  expect(pick?.mesh).toBe(picked?.props?.box);

  // Pointer events carry the mouse input source (ADR 0011).
  const sources = new Set(
    events.map((e) => e.source).filter((s): s is string => typeof s === "string"),
  );
  expect(sources).toContain("mouse");

  // The aggregations the dashboard renders are populated for this session.
  const counts = await request
    .get(`${COLLECTOR_URL}/api/v1/event-counts?session=${sessionId}`, {
      headers: { "x-api-key": API_KEY },
    })
    .then((r) => r.json() as Promise<{ event_type: string; count: number }[]>);
  const countedTypes = new Set(counts.map((c) => c.event_type));
  expect(countedTypes).toContain("pointer_click");
  expect(countedTypes).toContain("mesh_interaction");
});
