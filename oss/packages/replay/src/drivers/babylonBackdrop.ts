/**
 * Babylon **scene-backdrop** loader for replay — the npm (`@uptimizr/replay/babylon`)
 * entry point's `loadSceneBackdrop`.
 *
 * Kept in its own module (re-exported from `./babylon`) so the standalone (IIFE)
 * build, which only needs `createBabylonReplayDriver`, tree-shakes this away and
 * never bundles Babylon's `SceneLoader`. The default loader imports
 * `@babylonjs/core` lazily, keeping it an optional peer dependency.
 */
import type { Scene } from "@babylonjs/core";
import {
  loadSceneBackdropWith,
  type BackdropAssetContainer,
  type LoadSceneBackdropOptions,
  type SceneBackdrop,
} from "./backdrop.js";

/** Options for {@link loadSceneBackdrop}. */
export interface LoadBabylonBackdropOptions extends LoadSceneBackdropOptions {
  /**
   * Custom asset loader, e.g. to use `ImportMeshAsync`, a cache, or a CDN-pinned
   * Babylon. Receives the same `source`/`scene` and the resolved `pluginExtension`,
   * and must resolve a Babylon `AssetContainer` (not yet added to the scene).
   * Defaults to Babylon's `LoadAssetContainerAsync`.
   */
  load?: (
    source: string | File,
    scene: Scene,
    pluginExtension: string | undefined,
  ) => Promise<BackdropAssetContainer>;
}

/**
 * Load an arbitrary asset (e.g. a `.glb`) into `scene` as a replay **backdrop**,
 * then re-drive a captured session over it. `source` is a URL or a `File` (so a
 * drag-and-dropped model works directly).
 *
 * Returns a {@link SceneBackdrop} handle — call `dispose()` to remove the backdrop
 * (e.g. to swap one dropped model for another). Loading only *adds* geometry;
 * replay never emits analytics (ADR 0006).
 *
 * The host app must have a glTF (or relevant) loader registered, e.g.
 * `import "@babylonjs/loaders/glTF";`. `@babylonjs/core` stays an optional peer
 * dependency: the default loader is imported lazily, so this is the only path that
 * pulls in Babylon's `SceneLoader`.
 *
 * @example
 * ```ts
 * import { createBabylonReplayDriver, loadSceneBackdrop } from "@uptimizr/replay/babylon";
 * import "@babylonjs/loaders/glTF";
 *
 * const backdrop = await loadSceneBackdrop(scene, "https://cdn.example.com/room.glb");
 * const driver = createBabylonReplayDriver({ scene, nodes });
 * new ReplayPlayer(events, driver).play();
 * // later: backdrop.dispose();
 * ```
 */
export function loadSceneBackdrop(
  scene: Scene,
  source: string | File,
  options?: LoadBabylonBackdropOptions,
): Promise<SceneBackdrop> {
  const load = options?.load ?? defaultBabylonBackdropLoader;
  return loadSceneBackdropWith((pluginExtension) => load(source, scene, pluginExtension), options);
}

/** Lazily import Babylon's unified asset loader so the driver path stays lean. */
async function defaultBabylonBackdropLoader(
  source: string | File,
  scene: Scene,
  pluginExtension: string | undefined,
): Promise<BackdropAssetContainer> {
  const { LoadAssetContainerAsync } = await import("@babylonjs/core/Loading/sceneLoader.js");
  const container = await LoadAssetContainerAsync(
    source,
    scene,
    pluginExtension ? { pluginExtension } : undefined,
  );
  return container as unknown as BackdropAssetContainer;
}
