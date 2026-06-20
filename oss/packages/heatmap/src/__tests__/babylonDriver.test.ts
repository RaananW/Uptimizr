import { describe, expect, it } from "vitest";
import { NullEngine } from "@babylonjs/core/Engines/nullEngine.js";
import { FreeCamera } from "@babylonjs/core/Cameras/freeCamera.js";
import { Vector3 } from "@babylonjs/core/Maths/math.vector.js";
import { Scene } from "@babylonjs/core/scene.js";
import type { Mesh, TransformNode } from "@babylonjs/core";
import { createBabylonHeatmapDriver, showGazeDome } from "../drivers/babylon.js";

function setup(): { scene: Scene; dispose: () => void } {
  const engine = new NullEngine();
  const scene = new Scene(engine);
  return {
    scene,
    dispose: () => {
      scene.dispose();
      engine.dispose();
    },
  };
}

describe("createBabylonHeatmapDriver", () => {
  it("builds one thin-instanced box for the supplied voxels", () => {
    const { scene, dispose } = setup();
    const driver = createBabylonHeatmapDriver({ scene, name: "heat" });

    driver.render([
      { position: [0.5, 0.5, 0.5], scale: 0.9, color: [1, 0, 0, 1] },
      { position: [1.5, 0.5, 0.5], scale: 0.5, color: [0, 0, 1, 1] },
    ]);

    const mesh = scene.getMeshByName("heat") as Mesh | null;
    expect(mesh).not.toBeNull();
    expect(mesh!.thinInstanceCount).toBe(2);

    driver.dispose();
    dispose();
  });

  it("clears instances and disables the mesh on empty render", () => {
    const { scene, dispose } = setup();
    const driver = createBabylonHeatmapDriver({ scene, name: "heat" });

    driver.render([{ position: [0, 0, 0], scale: 1, color: [1, 1, 1, 1] }]);
    driver.render([]);

    const mesh = scene.getMeshByName("heat") as Mesh | null;
    expect(mesh!.thinInstanceCount).toBe(0);
    expect(mesh!.isEnabled()).toBe(false);

    driver.dispose();
    dispose();
  });

  it("toggles visibility without discarding built instances", () => {
    const { scene, dispose } = setup();
    const driver = createBabylonHeatmapDriver({ scene, name: "heat" });
    driver.render([{ position: [0, 0, 0], scale: 1, color: [1, 1, 1, 1] }]);

    const mesh = scene.getMeshByName("heat") as Mesh | null;
    driver.setVisible(false);
    expect(mesh!.isEnabled()).toBe(false);
    driver.setVisible(true);
    expect(mesh!.isEnabled()).toBe(true);
    expect(mesh!.thinInstanceCount).toBe(1);

    driver.dispose();
    dispose();
  });

  it("removes the mesh and material on dispose", () => {
    const { scene, dispose } = setup();
    const driver = createBabylonHeatmapDriver({ scene, name: "heat" });
    driver.render([{ position: [0, 0, 0], scale: 1, color: [1, 1, 1, 1] }]);
    driver.dispose();

    expect(scene.getMeshByName("heat")).toBeNull();
    dispose();
  });
});

describe("showGazeDome", () => {
  function gazeFetch() {
    return async () =>
      ({
        ok: true,
        status: 200,
        json: async () => [
          { azimuth_bin: 0, elevation_bin: 18, count: 10 },
          { azimuth_bin: 9, elevation_bin: 18, count: 4 },
        ],
      }) as unknown as Response;
  }

  it("fetches and renders a dome of markers into the scene", async () => {
    const { scene, dispose } = setup();
    const overlay = await showGazeDome({
      scene,
      endpoint: "https://c",
      apiKey: "k",
      name: "gaze",
      bins: 36,
      fetchImpl: gazeFetch() as unknown as typeof fetch,
    });

    const mesh = scene.getMeshByName("gaze") as Mesh | null;
    expect(mesh).not.toBeNull();
    expect(mesh!.thinInstanceCount).toBe(2);

    overlay.dispose();
    expect(scene.getMeshByName("gaze")).toBeNull();
    dispose();
  });

  it("parents the dome to a follower node that tracks the camera and disposes with the overlay", async () => {
    const { scene, dispose } = setup();
    const camera = new FreeCamera("cam", new Vector3(2, 3, 4), scene);

    const overlay = await showGazeDome({
      scene,
      endpoint: "https://c",
      apiKey: "k",
      name: "gaze",
      followCamera: camera,
      fetchImpl: gazeFetch() as unknown as typeof fetch,
    });

    const mesh = scene.getMeshByName("gaze") as Mesh | null;
    expect(mesh!.parent).not.toBeNull();
    const follower = mesh!.parent as TransformNode;

    // The before-render hook keeps the follower centered on the camera.
    camera.position.set(5, 6, 7);
    scene.onBeforeRenderObservable.notifyObservers(scene);
    expect(follower.position.asArray()).toEqual(camera.globalPosition.asArray());

    overlay.dispose();
    expect(follower.isDisposed()).toBe(true);
    expect(scene.getMeshByName("gaze")).toBeNull();
    dispose();
  });
});
