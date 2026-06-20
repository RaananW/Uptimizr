import type { ArcRotateCamera, Camera, SceneContext } from "@babylonjs/lite";
import type { CameraKind, SceneMeta } from "@uptimizr/schema";

/**
 * Structural view of the Babylon Lite camera fields used for classification.
 * Lite's `ArcRotateCamera` carries `alpha`/`beta`/`radius`/`target`; the base
 * `Camera` does not — so the presence of `alpha` distinguishes an orbit camera
 * without binding to a concrete constructor (Lite has no classes).
 */
interface CameraClassView {
  alpha?: number;
  target?: unknown;
}

/**
 * Classify a Babylon Lite camera into a coarse {@link CameraKind}. An
 * `ArcRotateCamera` (orbits a target) maps to `"arc-rotate"`; any other camera
 * maps to `"free"` (Lite's other built-in is a free/fly camera). Lite cameras
 * carry no driver taxonomy beyond this.
 */
export function classifyCamera(camera: Camera | ArcRotateCamera | null | undefined): CameraKind {
  const view = camera as unknown as CameraClassView | null | undefined;
  if (view && typeof view.alpha === "number" && view.target != null) return "arc-rotate";
  return "free";
}

/**
 * Read a coarse {@link SceneMeta} block from a Babylon Lite scene + camera: the
 * camera's kind and the mesh count (`scene.meshes`). Pass the result to
 * `client.start({ scene })` (or via `trackScene`) so it rides along on the
 * `session_start` event.
 *
 * Lite cameras expose no `name`, so `cameraName` is omitted. It only reads from
 * the scene — never mutates it.
 */
export function readSceneMeta(scene: SceneContext, camera: Camera): SceneMeta {
  const meta: SceneMeta = {};

  if (camera) meta.cameraType = classifyCamera(camera);

  const meshes = (scene as unknown as { meshes?: unknown[] }).meshes;
  if (Array.isArray(meshes)) meta.meshCount = meshes.length;

  return meta;
}
