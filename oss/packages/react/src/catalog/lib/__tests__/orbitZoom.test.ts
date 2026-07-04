import { describe, expect, it } from "vitest";

import {
  attachDoubleClickFocus,
  resetFocus,
  stepZoom,
  type OrbitFocusCamera,
  type OrbitHome,
} from "../orbitZoom";

// The orbit helpers only touch a few structural surfaces (camera radius/angles,
// scene.pick, canvas dblclick listener), so we drive them with duck-typed fakes
// in the default node env — no Babylon or jsdom needed.

function focusCamera(): OrbitFocusCamera & { target: unknown } {
  return {
    alpha: 0,
    beta: 0,
    radius: 0,
    lowerRadiusLimit: null,
    upperRadiusLimit: null,
    inputs: { removeByType: () => {} },
    target: null,
    setTarget(target: unknown) {
      this.target = target;
      // Babylon rebuilds alpha/beta/radius from position on setTarget; emulate
      // that clobbering so the test proves resetFocus restores them afterwards.
      this.alpha = -1;
      this.beta = -1;
      this.radius = -1;
    },
  };
}

describe("stepZoom", () => {
  it("clamps the radius to the camera limits", () => {
    const cam = focusCamera();
    cam.radius = 10;
    cam.lowerRadiusLimit = 4;
    cam.upperRadiusLimit = 20;
    stepZoom(cam, 0.5);
    expect(cam.radius).toBe(5);
    stepZoom(cam, 0.1); // would be 0.5, clamped to lower limit
    expect(cam.radius).toBe(4);
    stepZoom(cam, 100); // would be 400, clamped to upper limit
    expect(cam.radius).toBe(20);
  });
});

describe("attachDoubleClickFocus", () => {
  function fakeCanvas() {
    const listeners: Record<string, () => void> = {};
    const canvas = {
      addEventListener: (type: string, h: () => void) => {
        listeners[type] = h;
      },
      removeEventListener: (type: string, h: () => void) => {
        if (listeners[type] === h) delete listeners[type];
      },
    } as unknown as HTMLCanvasElement;
    return { canvas, listeners };
  }

  it("re-centers the camera on the double-clicked scene point", () => {
    const cam = focusCamera();
    const point = { x: 1, y: 2, z: 3 };
    const scene = {
      pointerX: 40,
      pointerY: 60,
      pick: () => ({ hit: true, pickedPoint: point }),
    };
    const { canvas, listeners } = fakeCanvas();

    const detach = attachDoubleClickFocus(scene, canvas, cam);
    listeners.dblclick!();
    expect(cam.target).toBe(point);

    detach();
    expect(listeners.dblclick).toBeUndefined();
  });

  it("ignores double-clicks that miss scene geometry", () => {
    const cam = focusCamera();
    const scene = {
      pointerX: 0,
      pointerY: 0,
      pick: () => ({ hit: false, pickedPoint: null }),
    };
    const { canvas, listeners } = fakeCanvas();

    attachDoubleClickFocus(scene, canvas, cam);
    listeners.dblclick!();
    expect(cam.target).toBeNull();
  });
});

describe("resetFocus", () => {
  it("restores the captured home target and framing", () => {
    const cam = focusCamera();
    const home: OrbitHome = { target: { x: 0, y: 0, z: 0 }, alpha: 0.7, beta: 1.1, radius: 12 };

    // Simulate the user having panned/zoomed away.
    cam.alpha = 3;
    cam.beta = 2;
    cam.radius = 99;

    resetFocus(cam, home);
    expect(cam.target).toBe(home.target);
    expect(cam.alpha).toBe(0.7);
    expect(cam.beta).toBe(1.1);
    expect(cam.radius).toBe(12);
  });
});
