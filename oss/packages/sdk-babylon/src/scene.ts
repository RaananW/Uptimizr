import type { Camera, Scene } from "@babylonjs/core";
import type { CameraKind, SceneMeta } from "@uptimizr/schema";

/**
 * Minimal view of the Babylon camera/scene fields we read for scene introspection.
 * Babylon's camera class hierarchy varies across versions, so we read defensively
 * via `getClassName()` rather than binding to concrete constructors (which would
 * also force a runtime dependency on `@babylonjs/core`).
 */
interface CameraNameView {
  name?: string;
  getClassName?: () => string;
}

/**
 * Resolve which camera to track/introspect. An explicit camera always wins;
 * otherwise we use `scene.activeCamera`, falling back to the first of a
 * multi-camera rig (`scene.activeCameras`).
 *
 * The fallback matters for **multi-camera setups** (picture-in-picture insets,
 * split-screen, render-target rigs): `scene.activeCamera` is ambiguous there and
 * Babylon may report a secondary/inset camera, so the recorded pose would be a
 * fixed, wrong viewpoint. Pass an explicit `camera` to record the one the viewer
 * actually flies.
 */
export function resolveTrackedCamera(scene: Scene, camera?: Camera | null): Camera | null {
  if (camera) return camera;
  if (scene.activeCamera) return scene.activeCamera;
  const rig = scene.activeCameras;
  if (rig && rig.length > 0) return rig[0] ?? null;
  return null;
}

/**
 * Classify a Babylon camera class name into a coarse {@link CameraKind}. Maps the
 * common built-ins; anything unrecognized falls back to `"other"`.
 */
export function classifyCamera(className: string | undefined): CameraKind {
  switch (className) {
    case "ArcRotateCamera":
      return "arc-rotate";
    case "FollowCamera":
    case "ArcFollowCamera":
      return "follow";
    case "FreeCamera":
    case "UniversalCamera":
    case "TargetCamera":
    case "FlyCamera":
    case "DeviceOrientationCamera":
      return "free";
    default:
      return "other";
  }
}

/**
 * Read a coarse {@link SceneMeta} block from a Babylon scene: the active camera's
 * kind/name and the mesh count. Pass the result to `client.start({ scene })` (or
 * via `trackScene`) so it rides along on the `session_start` event.
 *
 * It only reads from the scene — never mutates it. Caller-supplied fields like a
 * scene `description` should be merged in by the caller.
 */
export function readSceneMeta(scene: Scene, camera?: Camera | null): SceneMeta {
  const cam = resolveTrackedCamera(scene, camera) as unknown as CameraNameView | null;
  const meta: SceneMeta = {};

  if (cam) {
    const className = typeof cam.getClassName === "function" ? cam.getClassName() : undefined;
    meta.cameraType = classifyCamera(className);
    if (typeof cam.name === "string" && cam.name) meta.cameraName = cam.name;
  }

  const meshes = (scene as unknown as { meshes?: unknown[] }).meshes;
  if (Array.isArray(meshes)) meta.meshCount = meshes.length;

  return meta;
}
