/**
 * Engine-agnostic **scene-backdrop** core for replay.
 *
 * A replay re-drives a captured session into the host's scene; this loads an
 * arbitrary asset (e.g. a `.glb`) as that scene's backdrop so the recorded camera
 * / pointer / picks and actor (`node_transform`, ADR 0033) transforms can be
 * re-driven over a real model. It only *adds* geometry — replay stays read-only on
 * the data side (ADR 0006).
 *
 * This module deliberately has **no** `@babylonjs/core` import so the standalone
 * (IIFE) build can reuse the host page's loader instead of bundling a second copy
 * of Babylon's glTF `SceneLoader`. The Babylon entry (`./babylon`) supplies a
 * loader that constructs an asset container; the global build resolves one from
 * the host. Both feed {@link loadSceneBackdropWith}.
 */

/**
 * Structural view of the Babylon `AssetContainer` the backdrop core consumes —
 * just the members it reads/calls, so no Babylon type import is needed.
 */
export interface BackdropAssetContainer {
  /** All meshes the asset contributed. */
  meshes?: object[];
  /** Top-level nodes (meshes/transform nodes) with no parent in the asset. */
  rootNodes?: object[];
  /** Transform nodes the asset contributed. */
  transformNodes?: object[];
  /** Add everything the container holds to the scene it was loaded against. */
  addAllToScene(): void;
  /** Remove everything the container added back out of the scene. */
  removeAllFromScene?(): void;
  /** Release the GPU resources the container owns. */
  dispose?(): void;
}

/**
 * A loaded scene backdrop. Hold onto it to remove the backdrop later (e.g. to swap
 * one dropped model for another) via {@link SceneBackdrop.dispose}.
 */
export interface SceneBackdrop {
  /** Top-level nodes the backdrop added to the scene. */
  rootNodes: object[];
  /** All meshes the backdrop added to the scene. */
  meshes: object[];
  /** The underlying asset container, for advanced host use. */
  container: BackdropAssetContainer;
  /** Remove every node this backdrop added and release its GPU resources. */
  dispose(): void;
}

/** Options shared by the backdrop loaders. */
export interface LoadSceneBackdropOptions {
  /**
   * Force a loader plugin when the URL/`File` has no recognizable extension
   * (e.g. a `blob:`/`data:` URL from a drag-and-drop). Pass `".glb"`/`".gltf"`.
   */
  pluginExtension?: string;
}

/**
 * A loader that resolves an asset (already bound to a target scene) to a
 * {@link BackdropAssetContainer}, without adding it to the scene yet.
 */
export type BackdropLoader = (
  pluginExtension: string | undefined,
) => Promise<BackdropAssetContainer>;

/**
 * Core backdrop loader: run `load`, add the resulting container to the scene, and
 * return a {@link SceneBackdrop} handle whose `dispose()` removes everything it
 * added and frees the GPU resources. Engine-specific entries wrap this with a
 * concrete loader.
 */
export async function loadSceneBackdropWith(
  load: BackdropLoader,
  options?: LoadSceneBackdropOptions,
): Promise<SceneBackdrop> {
  const container = await load(options?.pluginExtension);
  container.addAllToScene();
  let disposed = false;
  return {
    rootNodes: container.rootNodes ?? [],
    meshes: container.meshes ?? [],
    container,
    dispose() {
      if (disposed) return;
      disposed = true;
      container.removeAllFromScene?.();
      container.dispose?.();
    },
  };
}
