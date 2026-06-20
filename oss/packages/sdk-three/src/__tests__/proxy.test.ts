import { describe, expect, it } from "vitest";
import type { Scene } from "three";
import { scanSceneProxy } from "../proxy.js";
import type { Aabb } from "@uptimizr/schema";

interface FakeMeshConfig {
  name: string;
  /** Native (three.js, right-handed) world AABB `[minX,minY,minZ,maxX,maxY,maxZ]`. */
  box: Aabb;
  isMesh?: boolean;
  visible?: boolean;
  indices?: number;
}

function fakeMesh(cfg: FakeMeshConfig) {
  return {
    isMesh: cfg.isMesh ?? true,
    name: cfg.name,
    visible: cfg.visible ?? true,
    geometry: { index: { count: cfg.indices ?? 36 } },
    _box: cfg.box,
  };
}

function fakeScene(nodes: unknown[]): Scene {
  return {
    traverse(cb: (o: unknown) => void) {
      for (const n of nodes) cb(n);
    },
  } as unknown as Scene;
}

const boundsOf = (m: unknown): Aabb | undefined => (m as { _box?: Aabb })._box;

describe("scanSceneProxy", () => {
  it("normalizes each mesh AABB to canonical (Z negated, min/max swapped) (ADR 0018)", () => {
    // Native box spans z in [1, 3]; canonical negates Z, so it becomes [-3, -1].
    const scene = fakeScene([fakeMesh({ name: "box", box: [0, 0, 1, 1, 1, 3] })]);
    const proxy = scanSceneProxy(scene, { sceneId: "lobby", boundsOf });

    expect(proxy.meshes[0]!.aabb).toEqual([0, 0, -3, 1, 1, -1]);
    expect(proxy.bounds).toEqual([0, 0, -3, 1, 1, -1]);
    expect(proxy.handedness).toBe("right");
    expect(proxy.kind).toBe("aabb");
  });

  it("captures per-mesh world AABBs and overall bounds", () => {
    const scene = fakeScene([
      fakeMesh({ name: "floor", box: [-2, 0, -2, 2, 0.1, 2] }),
      fakeMesh({ name: "box", box: [0, 0, 0, 1, 2, 1] }),
    ]);
    const proxy = scanSceneProxy(scene, { sceneId: "lobby", boundsOf });

    expect(proxy.meshes).toHaveLength(2);
    expect(proxy.meshCount).toBe(2);
    expect(proxy.meshes[0]!.triangles).toBe(12);
    expect(proxy.sdkVersion).toBeTruthy();
  });

  it("skips overlay meshes, invisible meshes, and non-mesh nodes", () => {
    const scene = fakeScene([
      fakeMesh({ name: "uptimizr-heatmap", box: [-9, -9, -9, 9, 9, 9] }),
      fakeMesh({ name: "hidden", box: [0, 0, 0, 1, 1, 1], visible: false }),
      fakeMesh({ name: "light", box: [0, 0, 0, 1, 1, 1], isMesh: false }),
      fakeMesh({ name: "real", box: [0, 0, 0, 1, 1, 1] }),
    ]);
    const proxy = scanSceneProxy(scene, { sceneId: "lobby", boundsOf });
    expect(proxy.meshes.map((m) => m.name)).toEqual(["real"]);
  });

  it("produces a stable content hash for identical geometry and a different one when it changes", () => {
    const build = (h: number) =>
      scanSceneProxy(fakeScene([fakeMesh({ name: "box", box: [0, 0, 0, 1, h, 1] })]), {
        sceneId: "lobby",
        now: () => 123,
        boundsOf,
      });
    expect(build(2).contentHash).toBe(build(2).contentHash);
    expect(build(2).contentHash).not.toBe(build(3).contentHash);
  });

  it("caps the mesh list to the largest by volume but reports the full count", () => {
    const scene = fakeScene([
      fakeMesh({ name: "small", box: [0, 0, 0, 1, 1, 1] }),
      fakeMesh({ name: "big", box: [0, 0, 0, 10, 10, 10] }),
      fakeMesh({ name: "mid", box: [0, 0, 0, 3, 3, 3] }),
    ]);
    const proxy = scanSceneProxy(scene, { sceneId: "lobby", maxMeshes: 2, boundsOf });
    expect(proxy.meshCount).toBe(3);
    expect(proxy.meshes.map((m) => m.name)).toEqual(["big", "mid"]);
  });

  it("returns zeroed bounds for an empty scene", () => {
    const proxy = scanSceneProxy(fakeScene([]), { sceneId: "lobby", boundsOf });
    expect(proxy.meshes).toEqual([]);
    expect(proxy.meshCount).toBe(0);
    expect(proxy.bounds).toEqual([0, 0, 0, 0, 0, 0]);
  });

  it("records path + canonical world transform from hierarchy + matrixWorld (ADR 0033)", () => {
    const nodes: unknown[] = [];
    const scene = fakeScene(nodes);
    const machine = { name: "Machine", parent: scene };
    const wheel = {
      isMesh: true,
      name: "Wheel",
      visible: true,
      geometry: { index: { count: 36 } },
      _box: [0, 0, 0, 1, 1, 1] as Aabb,
      parent: machine,
      // Column-major translate (1, 2, 3); three is right-handed so Z negates.
      matrixWorld: { elements: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 1, 2, 3, 1] },
    };
    nodes.push(wheel);

    const proxy = scanSceneProxy(scene, { sceneId: "lobby", boundsOf });
    const m = proxy.meshes.find((x) => x.name === "Wheel")!;
    expect(m.path).toBe("Machine/Wheel");
    expect(m.world?.position[0]).toBeCloseTo(1);
    expect(m.world?.position[1]).toBeCloseTo(2);
    expect(m.world?.position[2]).toBeCloseTo(-3);
    expect(m.world?.rotation).toEqual([0, 0, 0, 1]);
  });

  it("omits path/world when no hierarchy or world matrix is available", () => {
    const scene = fakeScene([fakeMesh({ name: "loose", box: [0, 0, 0, 1, 1, 1] })]);
    const proxy = scanSceneProxy(scene, { sceneId: "lobby", boundsOf });
    expect(proxy.meshes[0]!.path).toBeUndefined();
    expect(proxy.meshes[0]!.world).toBeUndefined();
  });
});
