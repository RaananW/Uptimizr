import { describe, expect, it } from "vitest";
import type { SceneContext } from "@babylonjs/lite";
import { scanSceneProxy } from "../proxy.js";
import type { Aabb } from "@uptimizr/schema";

interface FakeMeshConfig {
  name: string;
  /** World-space AABB `[minX,minY,minZ,maxX,maxY,maxZ]` (Lite is already canonical). */
  box?: Aabb;
  visible?: boolean;
}

/** A Lite mesh stub carrying `boundMin`/`boundMax` (the loader-populated bounds). */
function fakeMesh(cfg: FakeMeshConfig) {
  const mesh: Record<string, unknown> = {
    name: cfg.name,
    visible: cfg.visible ?? true,
  };
  if (cfg.box) {
    mesh.boundMin = [cfg.box[0], cfg.box[1], cfg.box[2]];
    mesh.boundMax = [cfg.box[3], cfg.box[4], cfg.box[5]];
  }
  return mesh;
}

function fakeScene(meshes: unknown[]): SceneContext {
  return { meshes } as unknown as SceneContext;
}

describe("scanSceneProxy (babylon-lite)", () => {
  it("reads world AABBs from boundMin/boundMax (left-handed canonical, no Z flip)", () => {
    const scene = fakeScene([fakeMesh({ name: "box", box: [0, 0, 1, 1, 1, 3] })]);
    const proxy = scanSceneProxy(scene, { sceneId: "lobby" });

    // Lite is already canonical (left-handed), so the box is unchanged.
    expect(proxy.meshes[0]!.aabb).toEqual([0, 0, 1, 1, 1, 3]);
    expect(proxy.bounds).toEqual([0, 0, 1, 1, 1, 3]);
    expect(proxy.handedness).toBe("left");
    expect(proxy.upAxis).toBe("y");
    expect(proxy.unitScale).toBe(1);
    expect(proxy.kind).toBe("aabb");
  });

  it("captures per-mesh world AABBs and overall bounds", () => {
    const scene = fakeScene([
      fakeMesh({ name: "floor", box: [-2, 0, -2, 2, 0.1, 2] }),
      fakeMesh({ name: "box", box: [0, 0, 0, 1, 2, 1] }),
    ]);
    const proxy = scanSceneProxy(scene, { sceneId: "lobby" });

    expect(proxy.meshes).toHaveLength(2);
    expect(proxy.meshCount).toBe(2);
    expect(proxy.bounds).toEqual([-2, 0, -2, 2, 2, 2]);
    expect(proxy.sdkVersion).toBeTruthy();
  });

  it("skips overlay meshes, invisible meshes, and meshes without bounds", () => {
    const scene = fakeScene([
      fakeMesh({ name: "uptimizr-heatmap", box: [-9, -9, -9, 9, 9, 9] }),
      fakeMesh({ name: "hidden", box: [0, 0, 0, 1, 1, 1], visible: false }),
      fakeMesh({ name: "no-bounds" }),
      fakeMesh({ name: "real", box: [0, 0, 0, 1, 1, 1] }),
    ]);
    const proxy = scanSceneProxy(scene, { sceneId: "lobby" });
    expect(proxy.meshes.map((m) => m.name)).toEqual(["real"]);
    expect(proxy.meshCount).toBe(1);
  });

  it("supports a custom boundsOf for procedural meshes (no loader bounds)", () => {
    const scene = fakeScene([
      { name: "procBox", visible: true, halfExtent: 2 },
      { name: "procGround", visible: true, halfExtent: 12 },
    ]);
    const boundsOf = (m: unknown): Aabb | undefined => {
      const h = (m as { halfExtent?: number }).halfExtent;
      return typeof h === "number" ? [-h, -h, -h, h, h, h] : undefined;
    };
    const proxy = scanSceneProxy(scene, { sceneId: "lobby", boundsOf });
    expect(proxy.meshes.map((m) => m.name)).toEqual(["procBox", "procGround"]);
    expect(proxy.bounds).toEqual([-12, -12, -12, 12, 12, 12]);
  });

  it("produces a stable content hash, differing only when geometry changes", () => {
    const build = (h: number) =>
      scanSceneProxy(fakeScene([fakeMesh({ name: "box", box: [0, 0, 0, 1, h, 1] })]), {
        sceneId: "lobby",
        now: () => 123,
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
