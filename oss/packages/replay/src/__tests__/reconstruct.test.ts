import { describe, expect, it } from "vitest";
import type { MeshTransform, SceneProxy } from "@uptimizr/schema";
import { reconstructRigidSubtree } from "../reconstruct.js";

const IDENTITY: MeshTransform = {
  position: [0, 0, 0],
  rotation: [0, 0, 0, 1],
  scale: [1, 1, 1],
};

/** Build a minimal-but-valid scene proxy carrying per-mesh `path` + `world`. */
function makeProxy(
  meshes: Array<{ name: string; path?: string; world?: MeshTransform }>,
): SceneProxy {
  return {
    version: 1,
    sceneId: "scene",
    kind: "aabb",
    bounds: [0, 0, 0, 1, 1, 1],
    upAxis: "y",
    handedness: "left",
    unitScale: 1,
    meshes: meshes.map((m) => ({
      name: m.name,
      aabb: [0, 0, 0, 1, 1, 1],
      ...(m.path ? { path: m.path } : {}),
      ...(m.world ? { world: m.world } : {}),
    })),
    meshCount: meshes.length,
    contentHash: "deadbeef",
    capturedAt: 0,
    sdkVersion: "0.1.0",
  } as SceneProxy;
}

function dist(a: [number, number, number], b: [number, number, number]): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

describe("reconstructRigidSubtree (ADR 0033 §3)", () => {
  it("translates a child rigidly with a pure root translation", () => {
    const proxy = makeProxy([
      { name: "root", path: "Machine", world: IDENTITY },
      { name: "wheel", path: "Machine/Wheel", world: { ...IDENTITY, position: [1, 0, 0] } },
    ]);

    const out = reconstructRigidSubtree({
      proxy,
      rootPath: "Machine",
      // Root moved +10 on X (no rotation): the child rides along.
      rootWorld: { position: [10, 0, 0], rotation: [0, 0, 0, 1] },
    });

    expect(out).toHaveLength(1);
    expect(out[0]!.path).toBe("Machine/Wheel");
    expect(out[0]!.world.position[0]).toBeCloseTo(11);
    expect(out[0]!.world.position[1]).toBeCloseTo(0);
    expect(out[0]!.world.position[2]).toBeCloseTo(0);
  });

  it("preserves the child↔root distance under an arbitrary rigid root motion", () => {
    const proxy = makeProxy([
      { name: "root", path: "Machine", world: IDENTITY },
      { name: "wheel", path: "Machine/Wheel", world: { ...IDENTITY, position: [1, 0, 0] } },
    ]);
    // At scan the child sits 1 unit from the root.
    const s = Math.SQRT1_2; // sin(45°) = cos(45°)
    const out = reconstructRigidSubtree({
      proxy,
      rootPath: "Machine",
      // 90° about Y plus a translation — a rigid motion must keep the distance.
      rootWorld: { position: [3, 4, 5], rotation: [0, s, 0, s] },
    });

    expect(out).toHaveLength(1);
    expect(dist(out[0]!.world.position, [3, 4, 5])).toBeCloseTo(1);
  });

  it("only reconstructs strict descendants and skips meshes without path/world", () => {
    const proxy = makeProxy([
      { name: "root", path: "Machine", world: IDENTITY },
      { name: "wheel", path: "Machine/Wheel", world: { ...IDENTITY, position: [1, 0, 0] } },
      { name: "bare" }, // no path/world → skipped
      { name: "other", path: "Other/Thing", world: IDENTITY }, // different root → skipped
    ]);

    const out = reconstructRigidSubtree({
      proxy,
      rootPath: "Machine",
      rootWorld: { position: [0, 0, 0], rotation: [0, 0, 0, 1] },
    });

    expect(out.map((m) => m.path)).toEqual(["Machine/Wheel"]);
  });

  it("returns nothing when the proxy carries no scan-time root transform", () => {
    const proxy = makeProxy([
      { name: "wheel", path: "Machine/Wheel", world: { ...IDENTITY, position: [1, 0, 0] } },
    ]);

    const out = reconstructRigidSubtree({
      proxy,
      rootPath: "Machine",
      rootWorld: { position: [10, 0, 0], rotation: [0, 0, 0, 1] },
    });

    expect(out).toEqual([]);
  });

  it("uses an explicit rootWorldAtScan when supplied", () => {
    const proxy = makeProxy([
      { name: "wheel", path: "Machine/Wheel", world: { ...IDENTITY, position: [2, 0, 0] } },
    ]);

    const out = reconstructRigidSubtree({
      proxy,
      rootPath: "Machine",
      rootWorldAtScan: { position: [1, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] },
      // Root moved from x=1 (scan) to x=4 (now): delta +3, so the child at x=2 → x=5.
      rootWorld: { position: [4, 0, 0], rotation: [0, 0, 0, 1] },
    });

    expect(out).toHaveLength(1);
    expect(out[0]!.world.position[0]).toBeCloseTo(5);
  });
});
