import { describe, expect, it, vi } from "vitest";
import type { AnyEvent } from "@uptimizr/schema";
import { createBabylonReplayDriver } from "../drivers/babylon.js";
import { loadSceneBackdrop } from "../drivers/babylonBackdrop.js";
import type { BackdropAssetContainer } from "../drivers/backdrop.js";

/** A fake Babylon `AssetContainer` recording the calls the backdrop core makes. */
function fakeContainer(overrides: Partial<BackdropAssetContainer> = {}): BackdropAssetContainer {
  return {
    meshes: [{ name: "Floor" }, { name: "Wall" }],
    rootNodes: [{ name: "Root" }],
    transformNodes: [],
    addAllToScene: vi.fn(),
    removeAllFromScene: vi.fn(),
    dispose: vi.fn(),
    ...overrides,
  };
}

describe("loadSceneBackdrop", () => {
  it("adds the loaded asset to the scene and exposes its nodes", async () => {
    const container = fakeContainer();
    const scene = { id: "scene" } as never;
    const load = vi.fn(async () => container);

    const backdrop = await loadSceneBackdrop(scene, "https://cdn.example.com/room.glb", { load });

    // The custom loader received the source + scene, and nothing was added until it resolved.
    expect(load).toHaveBeenCalledTimes(1);
    expect(load.mock.calls[0]![0]).toBe("https://cdn.example.com/room.glb");
    expect(load.mock.calls[0]![1]).toBe(scene);
    expect(container.addAllToScene).toHaveBeenCalledTimes(1);

    expect(backdrop.meshes).toHaveLength(2);
    expect(backdrop.rootNodes).toHaveLength(1);
    expect(backdrop.container).toBe(container);
  });

  it("accepts a File source (drag-and-drop) and forwards the plugin extension", async () => {
    const container = fakeContainer();
    const load = vi.fn(async () => container);
    const file = { name: "dropped" } as unknown as File;

    await loadSceneBackdrop({} as never, file, { load, pluginExtension: ".glb" });

    expect(load.mock.calls[0]![0]).toBe(file);
    // (source, scene, pluginExtension) — the resolved extension reaches the loader.
    expect(load.mock.calls[0]![2]).toBe(".glb");
  });

  it("dispose() removes everything it added and releases the container, idempotently", async () => {
    const container = fakeContainer();
    const backdrop = await loadSceneBackdrop({} as never, "x.glb", { load: async () => container });

    backdrop.dispose();
    backdrop.dispose();

    expect(container.removeAllFromScene).toHaveBeenCalledTimes(1);
    expect(container.dispose).toHaveBeenCalledTimes(1);
  });

  it("tolerates a container without optional node arrays", async () => {
    const container = fakeContainer({ meshes: undefined, rootNodes: undefined });
    const backdrop = await loadSceneBackdrop({} as never, "x.glb", { load: async () => container });

    expect(backdrop.meshes).toEqual([]);
    expect(backdrop.rootNodes).toEqual([]);
  });
});

describe("replay re-drive over a loaded backdrop (ADR 0033)", () => {
  it("drives a node_transform onto a node taken from the loaded model", async () => {
    // A drivable root node, as if resolved from the backdrop's loaded glTF.
    const setAbsolutePosition = vi.fn();
    const heroNode = {
      name: "Hero",
      setAbsolutePosition,
      scaling: { set: vi.fn() },
      rotationQuaternion: null as unknown,
    };
    const container = fakeContainer({ rootNodes: [heroNode] });
    const scene = {} as never;

    const backdrop = await loadSceneBackdrop(scene, "hero.glb", { load: async () => container });

    // Wire the actor map from the recorded nodeId to the loaded backdrop's root.
    const driver = createBabylonReplayDriver({
      scene,
      nodes: { hero: () => backdrop.rootNodes[0]! },
    });

    driver.apply({
      type: "node_transform",
      projectId: "p",
      sessionId: "s",
      ts: 5,
      sdkVersion: "0.1.0",
      nodeId: "hero",
      position: [1, 2, 3],
      rotation: [0, 0, 0, 1],
    } as AnyEvent);

    const posArg = setAbsolutePosition.mock.calls[0]![0] as { x: number; y: number; z: number };
    expect([posArg.x, posArg.y, posArg.z]).toEqual([1, 2, 3]);
  });
});
