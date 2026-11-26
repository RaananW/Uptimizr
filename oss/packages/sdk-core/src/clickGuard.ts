/**
 * Telling a click from a drag for connectors that capture `pointer_click` from
 * the DOM `click` event (three.js, PlayCanvas, Babylon Lite, web exports).
 *
 * The browser fires `click` after any press and release on the same element, so
 * an orbit or pan drag (OrbitControls, an engine's own camera) ends with a
 * `click` too. Babylon's own tap logic drops a release that travelled further
 * than `Scene.DragMovementThreshold` (10 px) from its press; this guard applies
 * the same rule to the DOM connectors so a camera drag is never recorded as a
 * click on every engine.
 */

/**
 * The furthest the pointer may travel, in CSS pixels, between press and release
 * for the release to still count as a click. Matches Babylon's
 * `Scene.DragMovementThreshold`.
 */
export const CLICK_DRAG_THRESHOLD_PX = 10;

/** The fields the guard reads off a `pointerdown` / `click` event. */
export interface ClickGuardEventLike {
  clientX?: number;
  clientY?: number;
}

/** See {@link createClickGuard}. */
export interface ClickGuard {
  /** Record a press. Wire this to the canvas's `pointerdown`. */
  press(ev: ClickGuardEventLike): void;
  /**
   * Whether this `click` ended a drag: the pointer was released further than the
   * threshold from where it was pressed. Consumes the recorded press. A `click`
   * with no recorded press (keyboard activation, `element.click()`) is a click.
   */
  isDrag(ev: ClickGuardEventLike): boolean;
}

/**
 * Create a press-to-release distance guard for DOM `click` capture. Under
 * Pointer Lock the cursor is frozen, so press and release share a position and
 * every click passes, which is what a crosshair click should do.
 */
export function createClickGuard(thresholdPx: number = CLICK_DRAG_THRESHOLD_PX): ClickGuard {
  let pressed: { x: number; y: number } | null = null;
  return {
    press(ev) {
      pressed =
        typeof ev.clientX === "number" && typeof ev.clientY === "number"
          ? { x: ev.clientX, y: ev.clientY }
          : null;
    },
    isDrag(ev) {
      const start = pressed;
      pressed = null;
      if (!start || typeof ev.clientX !== "number" || typeof ev.clientY !== "number") {
        return false;
      }
      return Math.hypot(ev.clientX - start.x, ev.clientY - start.y) > thresholdPx;
    },
  };
}
