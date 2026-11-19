import { expect, test } from "@playwright/test";

import {
  bootEngine,
  enableAllCapture,
  readSessionEvents,
  waitForEventTypes,
} from "./helpers/capture.js";

/**
 * Hover dwell on ordinary meshes (issue #405), end to end.
 *
 * The playground's Babylon boxes are plain meshes: no action manager, no
 * `enablePointerMoveEvents`, and `scene.constantlyUpdateMeshUnderPointer` is left
 * off. Babylon's own pointer-move pick skips such meshes (its default
 * `pointerMovePredicate` only admits meshes that opted into move events), so a
 * connector that reads `PointerInfo.pickInfo` on moves sees nothing under the
 * pointer. The connector now runs its own bounded pick for moves, so resting the
 * pointer on a box must yield a `hover_dwell` for that box, and the throttled
 * `pointer_move` samples taken over it must carry `hitMesh`.
 *
 * The unit tests feed a ready-made `pickInfo`, which is why they never caught
 * this; only a real Babylon scene exercises the move-pick predicate.
 */

interface StoredEvent {
  type: string;
  ts: number;
  mesh?: string;
  dwellMs?: number;
  hitMesh?: string;
  source?: string;
}

test("[babylon] hover_dwell fires for a plain mesh and pointer_move carries hitMesh (#405)", async ({
  page,
  request,
}) => {
  await enableAllCapture(page, "babylon");
  const sessionId = await bootEngine(page, "babylon");

  const { width, height } = page.viewportSize() ?? { width: 1280, height: 720 };
  const at = (fx: number, fy: number) => ({
    x: Math.round(width * fx),
    y: Math.round(height * fy),
  });

  // 1) Approach the centre box and rest on it well past the 500 ms dwell threshold.
  //    No click: a click would mark the episode as acted and suppress the event.
  const near = at(0.46, 0.52);
  const onBox = at(0.5, 0.52);
  await page.mouse.move(near.x, near.y, { steps: 4 });
  await page.mouse.move(onBox.x, onBox.y, { steps: 6 });
  await page.waitForTimeout(1_200);

  // 2) Move off the box onto the ground in front of it, which closes the episode.
  const offBox = at(0.5, 0.88);
  await page.mouse.move(offBox.x, offBox.y, { steps: 6 });

  await waitForEventTypes(request, sessionId, ["hover_dwell", "pointer_move"]);
  const events = (await readSessionEvents(request, sessionId)) as unknown as StoredEvent[];

  const hovers = events.filter((e) => e.type === "hover_dwell");
  const boxHover = hovers.find((e) => typeof e.mesh === "string" && e.mesh.startsWith("box-"));
  expect(boxHover, `a hover_dwell for a box; got ${JSON.stringify(hovers)}`).toBeTruthy();
  expect(boxHover!.dwellMs ?? 0).toBeGreaterThanOrEqual(500);
  expect(boxHover!.source).toBe("mouse");

  const movesOverBox = events.filter(
    (e) =>
      e.type === "pointer_move" && typeof e.hitMesh === "string" && e.hitMesh.startsWith("box-"),
  );
  expect(movesOverBox.length, "pointer_move samples over the box carry hitMesh").toBeGreaterThan(0);
});
