import { describe, expect, it } from "vitest";
import { BoxGeometry, Mesh, Scene } from "three";

import { createXrRaycaster } from "../raycast.js";

// `THREE.Raycaster` is pure geometry math (no WebGL/DOM), so these run against a
// real three scene graph: a unit cube at the origin and a second, farther cube.
function makeScene(): { scene: Scene; near: Mesh; far: Mesh } {
  const scene = new Scene();
  const near = new Mesh(new BoxGeometry(1, 1, 1));
  near.name = "near-cube";
  near.position.set(0, 0, -5);
  const far = new Mesh(new BoxGeometry(1, 1, 1));
  far.name = "far-cube";
  far.position.set(0, 0, -20);
  scene.add(near, far);
  scene.updateMatrixWorld(true);
  return { scene, near, far };
}

describe("createXrRaycaster", () => {
  it("resolves a world-space ray to the nearest named hit", () => {
    const { scene } = makeScene();
    const probe = createXrRaycaster(scene);
    const hit = probe([0, 0, 0], [0, 0, -1]);
    expect(hit?.name).toBe("near-cube");
    // The near face of a unit cube centred at z = -5 sits at z = -4.5.
    expect(hit?.point[0]).toBeCloseTo(0);
    expect(hit?.point[1]).toBeCloseTo(0);
    expect(hit?.point[2]).toBeCloseTo(-4.5);
  });

  it("returns undefined for a miss", () => {
    const { scene } = makeScene();
    const probe = createXrRaycaster(scene);
    expect(probe([0, 0, 0], [0, 1, 0])).toBeUndefined();
  });

  it("normalizes a non-unit direction", () => {
    const { scene } = makeScene();
    const probe = createXrRaycaster(scene);
    expect(probe([0, 0, 0], [0, 0, -7])?.name).toBe("near-cube");
  });

  it("clamps the ray with maxDistance", () => {
    const { scene } = makeScene();
    const probe = createXrRaycaster(scene, { maxDistance: 3 });
    expect(probe([0, 0, 0], [0, 0, -1])).toBeUndefined();
  });

  it("skips uptimizr- overlay objects and filtered objects", () => {
    const { scene, near } = makeScene();
    near.name = "uptimizr-overlay";
    const overlaySkipped = createXrRaycaster(scene);
    expect(overlaySkipped([0, 0, 0], [0, 0, -1])?.name).toBe("far-cube");

    near.name = "near-cube";
    const filtered = createXrRaycaster(scene, { predicate: (o) => o.name !== "near-cube" });
    expect(filtered([0, 0, 0], [0, 0, -1])?.name).toBe("far-cube");
  });

  it("reads through the scene each call (no snapshot of the graph)", () => {
    const { scene, near } = makeScene();
    const probe = createXrRaycaster(scene);
    expect(probe([0, 0, 0], [0, 0, -1])?.name).toBe("near-cube");
    scene.remove(near);
    expect(probe([0, 0, 0], [0, 0, -1])?.name).toBe("far-cube");
  });
});
