import { describe, expect, it } from "vitest";
import type { AppBase } from "playcanvas";
import { scanSceneProxy } from "../proxy.js";
import type { Aabb } from "@uptimizr/schema";

interface FakeMeshConfig {
  name: string;
  /** Native (PlayCanvas, right-handed) world AABB `[minX,minY,minZ,maxX,maxY,maxZ]`. */
  box: Aabb;
  /** When false, the node carries no mesh instances (a light/group). */
  renderable?: boolean;
  enabled?: boolean;
  indices?: number;
}

function fakeMesh(cfg: FakeMeshConfig) {
  const renderable = cfg.renderable ?? true;
  return {
    name: cfg.name,
    enabled: cfg.enabled ?? true,
    render: renderable
      ? { meshInstances: [{ mesh: { primitive: [{ count: cfg.indices ?? 36 }] } }] }
      : undefined,
    _box: cfg.box,
  };
}

function fakeApp(nodes: unknown[]): AppBase {
  return {
    root: {
      forEach(cb: (o: unknown) => void) {
        for (const n of nodes) cb(n);
      },
    },
  } as unknown as AppBase;
}

const boundsOf = (m: unknown): Aabb | undefined => (m as { _box?: Aabb })._box;

describe("scanSceneProxy", () => {
  it("normalizes each mesh AABB to canonical (Z negated, min/max swapped) (ADR 0018)", () => {
    // Native box spans z in [1, 3]; canonical negates Z, so it becomes [-3, -1].
    const app = fakeApp([fakeMesh({ name: "box", box: [0, 0, 1, 1, 1, 3] })]);
    const proxy = scanSceneProxy(app, { sceneId: "lobby", boundsOf });

    expect(proxy.meshes[0]!.aabb).toEqual([0, 0, -3, 1, 1, -1]);
    expect(proxy.bounds).toEqual([0, 0, -3, 1, 1, -1]);
    expect(proxy.handedness).toBe("right");
    expect(proxy.kind).toBe("aabb");
  });

  it("captures per-mesh world AABBs and overall bounds", () => {
    const app = fakeApp([
      fakeMesh({ name: "floor", box: [-2, 0, -2, 2, 0.1, 2] }),
      fakeMesh({ name: "box", box: [0, 0, 0, 1, 2, 1] }),
    ]);
    const proxy = scanSceneProxy(app, { sceneId: "lobby", boundsOf });

    expect(proxy.meshes).toHaveLength(2);
    expect(proxy.meshCount).toBe(2);
    expect(proxy.meshes[0]!.triangles).toBe(12);
    expect(proxy.sdkVersion).toBeTruthy();
  });

  it("skips overlay meshes, disabled meshes, and non-renderable nodes", () => {
    const app = fakeApp([
      fakeMesh({ name: "uptimizr-heatmap", box: [-9, -9, -9, 9, 9, 9] }),
      fakeMesh({ name: "hidden", box: [0, 0, 0, 1, 1, 1], enabled: false }),
      fakeMesh({ name: "light", box: [0, 0, 0, 1, 1, 1], renderable: false }),
      fakeMesh({ name: "real", box: [0, 0, 0, 1, 1, 1] }),
    ]);
    const proxy = scanSceneProxy(app, { sceneId: "lobby", boundsOf });
    expect(proxy.meshes.map((m) => m.name)).toEqual(["real"]);
  });

  it("produces a stable content hash for identical geometry and a different one when it changes", () => {
    const build = (h: number) =>
      scanSceneProxy(fakeApp([fakeMesh({ name: "box", box: [0, 0, 0, 1, h, 1] })]), {
        sceneId: "lobby",
        now: () => 123,
        boundsOf,
      });
    expect(build(2).contentHash).toBe(build(2).contentHash);
    expect(build(2).contentHash).not.toBe(build(3).contentHash);
  });

  it("caps the mesh list to the largest by volume but reports the full count", () => {
    const app = fakeApp([
      fakeMesh({ name: "small", box: [0, 0, 0, 1, 1, 1] }),
      fakeMesh({ name: "big", box: [0, 0, 0, 10, 10, 10] }),
      fakeMesh({ name: "mid", box: [0, 0, 0, 3, 3, 3] }),
    ]);
    const proxy = scanSceneProxy(app, { sceneId: "lobby", maxMeshes: 2, boundsOf });
    expect(proxy.meshCount).toBe(3);
    expect(proxy.meshes.map((m) => m.name)).toEqual(["big", "mid"]);
  });

  it("returns zeroed bounds for an empty scene", () => {
    const proxy = scanSceneProxy(fakeApp([]), { sceneId: "lobby", boundsOf });
    expect(proxy.meshes).toEqual([]);
    expect(proxy.meshCount).toBe(0);
    expect(proxy.bounds).toEqual([0, 0, 0, 0, 0, 0]);
  });

  it("records path + canonical world transform from hierarchy + accessors (ADR 0033)", () => {
    const nodes: unknown[] = [];
    const app = { root: { forEach: (cb: (o: unknown) => void) => nodes.forEach(cb) } };
    const machine = { name: "Machine", parent: app.root };
    const wheel = {
      name: "Wheel",
      enabled: true,
      render: { meshInstances: [{ mesh: { primitive: [{ count: 36 }] } }] },
      _box: [0, 0, 0, 1, 1, 1] as Aabb,
      parent: machine,
      // PlayCanvas is right-handed; the world Z is negated into canonical.
      getPosition: () => ({ x: 1, y: 2, z: 3 }),
      getRotation: () => ({ x: 0, y: 0, z: 0, w: 1 }),
      getWorldTransform: () => ({ getScale: () => ({ x: 1, y: 1, z: 1 }) }),
    };
    nodes.push(wheel);

    const proxy = scanSceneProxy(app as unknown as AppBase, { sceneId: "lobby", boundsOf });
    const m = proxy.meshes.find((x) => x.name === "Wheel")!;
    expect(m.path).toBe("Machine/Wheel");
    expect(m.world?.position[0]).toBeCloseTo(1);
    expect(m.world?.position[1]).toBeCloseTo(2);
    expect(m.world?.position[2]).toBeCloseTo(-3);
    expect(m.world?.scale).toEqual([1, 1, 1]);
  });
});
