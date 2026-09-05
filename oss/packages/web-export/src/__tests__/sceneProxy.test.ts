import { describe, expect, it } from "vitest";
import { sceneProxySchema } from "@uptimizr/schema";
import { buildSceneProxy } from "../sceneProxy.js";
import type { NativeFrame } from "../types.js";

const GODOT: NativeFrame = { handedness: "right", upAxis: "y", unitScale: 1 };
const UNREAL: NativeFrame = { handedness: "left", upAxis: "z", unitScale: 100 };

describe("buildSceneProxy", () => {
  it("produces a wire-correct, canonical proxy", () => {
    const proxy = buildSceneProxy([{ name: "Floor", aabb: [-1, 0, -1, 1, 0, 1] }], {
      sceneId: "lobby",
      frame: GODOT,
      now: () => 123,
    });
    expect(() => sceneProxySchema.parse(proxy)).not.toThrow();
    expect(proxy.upAxis).toBe("y");
    expect(proxy.handedness).toBe("left");
    expect(proxy.unitScale).toBe(1);
    expect(proxy.capturedAt).toBe(123);
    expect(proxy.meshCount).toBe(1);
  });

  it("normalizes node AABBs to the canonical frame (Unreal z-up + cm)", () => {
    const proxy = buildSceneProxy([{ name: "Box", aabb: [-100, -200, -300, 100, 200, 300] }], {
      sceneId: "s",
      frame: UNREAL,
      now: () => 0,
    });
    // [-1,-2,-3,1,2,3] → rebase z-up→y-up → [-1,-3,-2,1,3,2]
    expect(proxy.meshes[0]!.aabb).toEqual([-1, -3, -2, 1, 3, 2]);
  });

  it("computes bounds as the union of all node boxes", () => {
    const proxy = buildSceneProxy(
      [
        { name: "A", aabb: [-1, -1, -1, 0, 0, 0] },
        { name: "B", aabb: [0, 0, 0, 2, 2, 2] },
      ],
      { sceneId: "s", frame: GODOT, now: () => 0 },
    );
    // Godot negates+swaps Z per box; union still spans the same overall extent.
    expect(proxy.bounds[0]).toBe(-1);
    expect(proxy.bounds[3]).toBe(2);
    expect(proxy.meshCount).toBe(2);
  });

  it("is deterministic: same input → same contentHash", () => {
    const a = buildSceneProxy([{ name: "X", aabb: [0, 0, 0, 1, 1, 1] }], {
      sceneId: "s",
      frame: GODOT,
      now: () => 0,
    });
    const b = buildSceneProxy([{ name: "X", aabb: [0, 0, 0, 1, 1, 1] }], {
      sceneId: "s",
      frame: GODOT,
      now: () => 999,
    });
    expect(a.contentHash).toBe(b.contentHash);
  });

  it("caps the mesh list but reports the true total", () => {
    const proxy = buildSceneProxy(
      [
        { name: "small", aabb: [0, 0, 0, 1, 1, 1] },
        { name: "big", aabb: [0, 0, 0, 10, 10, 10] },
      ],
      { sceneId: "s", frame: GODOT, now: () => 0, maxMeshes: 1 },
    );
    expect(proxy.meshes).toHaveLength(1);
    expect(proxy.meshes[0]!.name).toBe("big");
    expect(proxy.meshCount).toBe(2);
  });
});
