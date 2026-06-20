import { describe, expect, it, vi } from "vitest";

// Lite is WebGPU-only with no headless/Null engine, so the engine free functions
// are mocked to capture the buffers the driver builds (pure structural stubs).
const lite = vi.hoisted(() => {
  const mesh: Record<string, unknown> = { name: "", material: undefined, visible: undefined };
  return {
    mesh,
    createBox: vi.fn(() => mesh),
    createStandardMaterial: vi.fn(() => ({
      emissiveColor: [0, 0, 0],
      diffuseColor: [0, 0, 0],
      specularColor: [0, 0, 0],
      alpha: 1,
      disableLighting: false,
    })),
    addToScene: vi.fn(),
    removeFromScene: vi.fn(),
    setThinInstances: vi.fn(),
    setThinInstanceColors: vi.fn(),
    setThinInstanceCount: vi.fn(),
    flushThinInstances: vi.fn(),
    onBeforeRender: vi.fn(),
  };
});

vi.mock("@babylonjs/lite", () => ({
  createBox: lite.createBox,
  createStandardMaterial: lite.createStandardMaterial,
  addToScene: lite.addToScene,
  removeFromScene: lite.removeFromScene,
  setThinInstances: lite.setThinInstances,
  setThinInstanceColors: lite.setThinInstanceColors,
  setThinInstanceCount: lite.setThinInstanceCount,
  flushThinInstances: lite.flushThinInstances,
  onBeforeRender: lite.onBeforeRender,
}));

import { createBabylonLiteHeatmapDriver } from "../drivers/babylon-lite.js";

function makeScene() {
  return { surface: { engine: {} } } as never;
}

describe("createBabylonLiteHeatmapDriver", () => {
  it("builds a column-major scale+translation matrix buffer for each voxel", () => {
    lite.setThinInstances.mockClear();
    lite.setThinInstanceColors.mockClear();
    const driver = createBabylonLiteHeatmapDriver({ scene: makeScene(), name: "heat" });

    driver.render([
      { position: [1, 2, 3], scale: 0.9, color: [1, 0, 0, 1] },
      { position: [4, 5, 6], scale: 0.5, color: [0, 0, 1, 0.5] },
    ]);

    const [, matrices, count] = lite.setThinInstances.mock.calls[0]!;
    const m = matrices as Float32Array;
    expect(count).toBe(2);
    expect(m).toHaveLength(32);
    // Instance 0: scale on the diagonal (0/5/10), translation at 12/13/14.
    // (Float32 rounds 0.9, so compare with tolerance.)
    expect(m[0]).toBeCloseTo(0.9, 6);
    expect(m[5]).toBeCloseTo(0.9, 6);
    expect(m[10]).toBeCloseTo(0.9, 6);
    expect([m[12], m[13], m[14], m[15]]).toEqual([1, 2, 3, 1]);
    // Instance 1.
    expect([m[16], m[21], m[26]]).toEqual([0.5, 0.5, 0.5]);
    expect([m[28], m[29], m[30], m[31]]).toEqual([4, 5, 6, 1]);

    const colors = lite.setThinInstanceColors.mock.calls[0]![1] as Float32Array;
    expect(Array.from(colors)).toEqual([1, 0, 0, 1, 0, 0, 1, 0.5]);
  });

  it("clears the instance count and hides the box on empty render", () => {
    lite.setThinInstanceCount.mockClear();
    const driver = createBabylonLiteHeatmapDriver({ scene: makeScene(), name: "heat" });
    driver.render([{ position: [0, 0, 0], scale: 1, color: [1, 1, 1, 1] }]);
    driver.render([]);

    expect(lite.setThinInstanceCount).toHaveBeenCalledWith(lite.mesh, 0);
    expect(lite.mesh.visible).toBe(false);
  });

  it("toggles visibility only when instances are built", () => {
    const driver = createBabylonLiteHeatmapDriver({ scene: makeScene(), name: "heat" });
    // Nothing built yet → stays hidden.
    driver.setVisible(true);
    expect(lite.mesh.visible).toBe(false);

    driver.render([{ position: [0, 0, 0], scale: 1, color: [1, 1, 1, 1] }]);
    driver.setVisible(false);
    expect(lite.mesh.visible).toBe(false);
    driver.setVisible(true);
    expect(lite.mesh.visible).toBe(true);
  });

  it("removes the box from the scene on dispose", () => {
    lite.removeFromScene.mockClear();
    const driver = createBabylonLiteHeatmapDriver({ scene: makeScene(), name: "heat" });
    driver.dispose();
    expect(lite.removeFromScene).toHaveBeenCalledWith(expect.anything(), lite.mesh);
  });
});

describe("createBabylonLiteHeatmapDriver follow mode", () => {
  it("offsets instance translations by the follow vector on the first render", () => {
    lite.setThinInstances.mockClear();
    const offset: readonly [number, number, number] = [10, 0, -5];
    const driver = createBabylonLiteHeatmapDriver({
      scene: makeScene(),
      name: "gaze",
      follow: () => offset,
      // no frameHook: registration falls back to the mocked onBeforeRender
    });

    driver.render([{ position: [1, 2, 3], scale: 1, color: [1, 1, 1, 1] }]);

    const m = lite.setThinInstances.mock.calls.at(-1)![1] as Float32Array;
    // base translation [1,2,3] + offset [10,0,-5].
    expect([m[12], m[13], m[14]]).toEqual([11, 2, -2]);
  });

  it("re-applies the live camera offset every frame via the injected frame hook", () => {
    lite.setThinInstances.mockClear();
    let frameCb: ((deltaMs: number) => void) | undefined;
    const frameHook = vi.fn((_scene: unknown, cb: (deltaMs: number) => void) => {
      frameCb = cb;
    });
    let offset: readonly [number, number, number] = [0, 0, 0];
    const driver = createBabylonLiteHeatmapDriver({
      scene: makeScene(),
      name: "gaze",
      follow: () => offset,
      frameHook: frameHook as never,
    });
    expect(frameHook).toHaveBeenCalledTimes(1);

    driver.render([{ position: [1, 0, 0], scale: 1, color: [1, 1, 1, 1] }]);

    // Camera moves; the next frame re-offsets from the origin-relative base.
    offset = [5, 5, 5];
    frameCb?.(16);
    const m = lite.setThinInstances.mock.calls.at(-1)![1] as Float32Array;
    expect([m[12], m[13], m[14]]).toEqual([6, 5, 5]);
  });

  it("no-ops the frame hook after dispose", () => {
    let frameCb: ((deltaMs: number) => void) | undefined;
    const frameHook = vi.fn((_scene: unknown, cb: (deltaMs: number) => void) => {
      frameCb = cb;
    });
    const driver = createBabylonLiteHeatmapDriver({
      scene: makeScene(),
      name: "gaze",
      follow: () => [1, 1, 1],
      frameHook: frameHook as never,
    });
    driver.render([{ position: [0, 0, 0], scale: 1, color: [1, 1, 1, 1] }]);
    driver.dispose();

    lite.setThinInstances.mockClear();
    frameCb?.(16);
    expect(lite.setThinInstances).not.toHaveBeenCalled();
  });
});
