import type { Camera, Scene } from "three";
import type { CameraKind, SceneMeta } from "@uptimizr/schema";

/**
 * Minimal view of the three.js camera fields we read for scene introspection.
 * three's camera subclasses set boolean brand flags (`isPerspectiveCamera`,
 * `isOrthographicCamera`), so we read those structurally rather than binding to
 * concrete constructors (which would force a runtime dependency on `three`).
 */
interface CameraClassView {
  name?: string;
  isPerspectiveCamera?: boolean;
  isOrthographicCamera?: boolean;
}

/** Minimal view of the three.js node fields we traverse for the mesh count. */
interface SceneTraverseView {
  traverse?: (callback: (object: { isMesh?: boolean }) => void) => void;
}

/**
 * Classify a three.js camera into a coarse {@link CameraKind}. three has no
 * built-in "driver" taxonomy (orbit/fly/etc. live in optional controls the
 * connector can't see), so this reflects the *projection*: a `PerspectiveCamera`
 * maps to `"free"` (the closest free-roaming analogue) and an `OrthographicCamera`
 * to `"static"`. Anything else is `"other"`.
 */
export function classifyCamera(camera: Camera | null | undefined): CameraKind {
  const view = camera as unknown as CameraClassView | null | undefined;
  if (view?.isPerspectiveCamera) return "free";
  if (view?.isOrthographicCamera) return "static";
  return "other";
}

/**
 * Read a coarse {@link SceneMeta} block from a three.js scene + camera: the
 * camera's kind/name and the mesh count. Pass the result to
 * `client.start({ scene })` (or via `trackScene`) so it rides along on the
 * `session_start` event.
 *
 * It only reads from the scene — never mutates it. Caller-supplied fields like a
 * scene `description` should be merged in by the caller.
 */
export function readSceneMeta(scene: Scene, camera: Camera): SceneMeta {
  const meta: SceneMeta = {};

  const view = camera as unknown as CameraClassView | null;
  if (view) {
    meta.cameraType = classifyCamera(camera);
    if (typeof view.name === "string" && view.name) meta.cameraName = view.name;
  }

  const node = scene as unknown as SceneTraverseView;
  if (typeof node.traverse === "function") {
    let meshCount = 0;
    node.traverse((object) => {
      if (object.isMesh) meshCount++;
    });
    meta.meshCount = meshCount;
  }

  return meta;
}
