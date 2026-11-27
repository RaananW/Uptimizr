import { describe, expect, it, vi } from "vitest";
import { CLICK_DRAG_THRESHOLD_PX, createClickGuard } from "../clickGuard.js";

describe("createClickGuard", () => {
  it("treats a release within the threshold as a click", () => {
    const guard = createClickGuard();
    guard.press({ clientX: 100, clientY: 100 });
    expect(guard.isDrag({ clientX: 106, clientY: 108 })).toBe(false); // 10px exactly
  });

  it("treats a release past the threshold as a drag", () => {
    const guard = createClickGuard();
    guard.press({ clientX: 100, clientY: 100 });
    expect(guard.isDrag({ clientX: 100 + CLICK_DRAG_THRESHOLD_PX + 1, clientY: 100 })).toBe(true);
  });

  it("consumes the press, so a later click without a press passes", () => {
    const guard = createClickGuard();
    guard.press({ clientX: 0, clientY: 0 });
    expect(guard.isDrag({ clientX: 500, clientY: 0 })).toBe(true);
    // Keyboard activation / element.click(): no press recorded.
    expect(guard.isDrag({ clientX: 500, clientY: 0 })).toBe(false);
  });

  it("passes a click whose coordinates are missing", () => {
    const guard = createClickGuard();
    guard.press({});
    expect(guard.isDrag({ clientX: 900, clientY: 900 })).toBe(false);
    guard.press({ clientX: 0, clientY: 0 });
    expect(guard.isDrag({})).toBe(false);
  });

  it("never treats a click as a drag under Pointer Lock", () => {
    vi.stubGlobal("document", { pointerLockElement: {} });
    try {
      const guard = createClickGuard();
      // Turning with the button held: even if the coordinates drifted, it is a click.
      guard.press({ clientX: 100, clientY: 100 });
      expect(guard.isDrag({ clientX: 400, clientY: 100 })).toBe(false);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("honours a custom threshold", () => {
    const guard = createClickGuard(2);
    guard.press({ clientX: 0, clientY: 0 });
    expect(guard.isDrag({ clientX: 3, clientY: 0 })).toBe(true);
  });
});
