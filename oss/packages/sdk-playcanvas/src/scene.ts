import type { AppBase, Entity } from "playcanvas";
// `PROJECTION_PERSPECTIVE` / `PROJECTION_ORTHOGRAPHIC` are plain numeric module
// constants (no WebGL / DOM), so importing them to classify the camera is safe.
// esbuild keeps `playcanvas` external — it is never bundled.
import { PROJECTION_ORTHOGRAPHIC, PROJECTION_PERSPECTIVE } from "playcanvas";
import type { CameraKind, SceneMeta } from "@uptimizr/schema";

/**
 * Minimal view of the PlayCanvas camera Entity fields we read for scene
 * introspection. The `camera` component carries the projection mode and a name on
 * the owning Entity.
 */
interface CameraEntityView {
  name?: string;
  camera?: { projection?: number };
}

/** Structural view of a graph node with renderable mesh instances. */
interface RenderableNodeView {
  render?: { meshInstances?: unknown[] | null };
  model?: { meshInstances?: unknown[] | null };
}

/** Structural view of `app.root.forEach` (depth-first graph walk). */
interface AppRootView {
  root?: { forEach?: (cb: (node: unknown) => void) => void };
}

/**
 * Classify a PlayCanvas camera into a coarse {@link CameraKind}. PlayCanvas has no
 * built-in "driver" taxonomy (orbit/fly/etc. live in optional scripts the
 * connector can't see), so this reflects the *projection*: a perspective camera
 * maps to `"free"` (the closest free-roaming analogue) and an orthographic camera
 * to `"static"`. Anything else is `"other"`.
 */
export function classifyCamera(camera: Entity | null | undefined): CameraKind {
  const view = camera as unknown as CameraEntityView | null | undefined;
  const projection = view?.camera?.projection;
  if (projection === PROJECTION_PERSPECTIVE) return "free";
  if (projection === PROJECTION_ORTHOGRAPHIC) return "static";
  return "other";
}

/**
 * Read a coarse {@link SceneMeta} block from a PlayCanvas app + camera Entity: the
 * camera's kind/name and the mesh count. Pass the result to
 * `client.start({ scene })` (or via `trackScene`) so it rides along on the
 * `session_start` event.
 *
 * It only reads from the scene — never mutates it. Caller-supplied fields like a
 * scene `description` should be merged in by the caller.
 */
export function readSceneMeta(app: AppBase, camera: Entity): SceneMeta {
  const meta: SceneMeta = {};

  const view = camera as unknown as CameraEntityView | null;
  if (view) {
    meta.cameraType = classifyCamera(camera);
    if (typeof view.name === "string" && view.name) meta.cameraName = view.name;
  }

  const root = (app as unknown as AppRootView).root;
  if (root && typeof root.forEach === "function") {
    let meshCount = 0;
    root.forEach((raw) => {
      const node = raw as RenderableNodeView;
      const renderInstances = node.render?.meshInstances?.length ?? 0;
      const modelInstances = node.model?.meshInstances?.length ?? 0;
      meshCount += renderInstances + modelInstances;
    });
    meta.meshCount = meshCount;
  }

  return meta;
}
