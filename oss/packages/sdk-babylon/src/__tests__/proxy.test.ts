import { describe, expect, it } from "vitest";
import type { Scene } from "@babylonjs/core";
import { scanSceneProxy } from "../proxy.js";

interface FakeMeshConfig {
  name: string;
  min: [number, number, number];
  max: [number, number, number];
  vertices?: number;
  indices?: number;
  enabled?: boolean;
}

function fakeMesh(cfg: FakeMeshConfig) {
  return {
    name: cfg.name,
    isEnabled: () => cfg.enabled ?? true,
    getTotalVertices: () => cfg.vertices ?? 24,
    getTotalIndices: () => cfg.indices ?? 36,
    computeWorldMatrix: () => undefined,
    getBoundingInfo: () => ({
      boundingBox: {
        minimumWorld: { x: cfg.min[0], y: cfg.min[1], z: cfg.min[2] },
        maximumWorld: { x: cfg.max[0], y: cfg.max[1], z: cfg.max[2] },
      },
    }),
  };
}

function fakeScene(meshes: unknown[]): Scene {
  return { meshes } as unknown as Scene;
}

describe("scanSceneProxy", () => {
  it("captures per-mesh world AABBs and overall bounds", () => {
    const scene = fakeScene([
      fakeMesh({ name: "floor", min: [-2, 0, -2], max: [2, 0.1, 2] }),
      fakeMesh({ name: "box", min: [0, 0, 0], max: [1, 2, 1] }),
    ]);
    const proxy = scanSceneProxy(scene, { sceneId: "lobby" });

    expect(proxy.kind).toBe("aabb");
    expect(proxy.meshes).toHaveLength(2);
    expect(proxy.meshCount).toBe(2);
    expect(proxy.bounds).toEqual([-2, 0, -2, 2, 2, 2]);
    expect(proxy.meshes[0]!.triangles).toBe(12);
    expect(proxy.sdkVersion).toBeTruthy();
  });

  it("records left-handed by default and right-handed when the scene opts in (ADR 0018)", () => {
    const meshes = [fakeMesh({ name: "box", min: [0, 0, 0], max: [1, 1, 1] })];
    expect(scanSceneProxy(fakeScene(meshes), { sceneId: "lobby" }).handedness).toBe("left");

    const rhScene = { meshes, useRightHandedSystem: true } as unknown as Scene;
    expect(scanSceneProxy(rhScene, { sceneId: "lobby" }).handedness).toBe("right");
  });

  it("records path + world transform from hierarchy + absolute accessors (ADR 0033)", () => {
    const machine = { name: "Machine", parent: null };
    const wheel = {
      name: "Wheel",
      isEnabled: () => true,
      getTotalVertices: () => 24,
      getTotalIndices: () => 36,
      computeWorldMatrix: () => undefined,
      getBoundingInfo: () => ({
        boundingBox: {
          minimumWorld: { x: 0, y: 0, z: 0 },
          maximumWorld: { x: 1, y: 1, z: 1 },
        },
      }),
      parent: machine,
      // Babylon is the canonical frame — used directly, no Z negation.
      absolutePosition: { x: 1, y: 2, z: 3 },
      absoluteRotationQuaternion: { x: 0, y: 0, z: 0, w: 1 },
      absoluteScaling: { x: 1, y: 1, z: 1 },
    };
    const proxy = scanSceneProxy(fakeScene([wheel]), { sceneId: "lobby" });
    const m = proxy.meshes.find((x) => x.name === "Wheel")!;
    expect(m.path).toBe("Machine/Wheel");
    expect(m.world?.position).toEqual([1, 2, 3]);
    expect(m.world?.rotation).toEqual([0, 0, 0, 1]);
  });

  it("skips overlay meshes, disabled meshes, and vertex-less nodes", () => {
    const scene = fakeScene([
      fakeMesh({ name: "uptimizr-heatmap", min: [-9, -9, -9], max: [9, 9, 9] }),
      fakeMesh({ name: "disabled", min: [0, 0, 0], max: [1, 1, 1], enabled: false }),
      fakeMesh({ name: "empty", min: [0, 0, 0], max: [1, 1, 1], vertices: 0 }),
      fakeMesh({ name: "real", min: [0, 0, 0], max: [1, 1, 1] }),
    ]);
    const proxy = scanSceneProxy(scene, { sceneId: "lobby" });
    expect(proxy.meshes.map((m) => m.name)).toEqual(["real"]);
    expect(proxy.bounds).toEqual([0, 0, 0, 1, 1, 1]);
  });

  it("produces a stable content hash for identical geometry and a different one when it changes", () => {
    const build = (h: number) =>
      scanSceneProxy(fakeScene([fakeMesh({ name: "box", min: [0, 0, 0], max: [1, h, 1] })]), {
        sceneId: "lobby",
        now: () => 123,
      });
    expect(build(2).contentHash).toBe(build(2).contentHash);
    expect(build(2).contentHash).not.toBe(build(3).contentHash);
  });

  it("caps the mesh list to the largest by volume but reports the full count", () => {
    const scene = fakeScene([
      fakeMesh({ name: "small", min: [0, 0, 0], max: [1, 1, 1] }),
      fakeMesh({ name: "big", min: [0, 0, 0], max: [10, 10, 10] }),
      fakeMesh({ name: "mid", min: [0, 0, 0], max: [3, 3, 3] }),
    ]);
    const proxy = scanSceneProxy(scene, { sceneId: "lobby", maxMeshes: 2 });
    expect(proxy.meshCount).toBe(3);
    expect(proxy.meshes.map((m) => m.name)).toEqual(["big", "mid"]);
  });

  it("returns zeroed bounds for an empty scene", () => {
    const proxy = scanSceneProxy(fakeScene([]), { sceneId: "lobby" });
    expect(proxy.meshes).toEqual([]);
    expect(proxy.meshCount).toBe(0);
    expect(proxy.bounds).toEqual([0, 0, 0, 0, 0, 0]);
  });
});
