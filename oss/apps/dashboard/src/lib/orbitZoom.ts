// Shared orbit-camera helpers for the embedded Babylon canvases (zoom + focus).
//
// Babylon's ArcRotateCamera binds the mouse wheel to zoom, which hijacks page
// scrolling whenever the pointer is over a canvas. We remove that input and drive
// zoom from explicit +/- buttons instead, so the page scrolls normally and zoom
// stays discoverable. The same canvases also orbit around a fixed center, which
// is awkward in large walkable scenes — so we let the user double-click to focus
// the orbit pivot on any scene point, with a reset control to return to center.
// Typed structurally to avoid importing Babylon at the top level (the canvases
// load it dynamically, browser-only).

export interface OrbitZoomCamera {
  radius: number;
  lowerRadiusLimit: number | null;
  upperRadiusLimit: number | null;
  inputs: { removeByType: (inputType: string) => void };
}

/**
 * Orbit camera surface needed to re-pivot and restore a "home" framing. Extends
 * {@link OrbitZoomCamera} with the orbit angles and `setTarget`, all of which
 * Babylon's `ArcRotateCamera` provides. `setTarget` takes a Babylon `Vector3`
 * (kept as `unknown` so this module stays Babylon-free).
 */
export interface OrbitFocusCamera extends OrbitZoomCamera {
  alpha: number;
  beta: number;
  // Method syntax (not an arrow property) so Babylon's ArcRotateCamera — whose
  // setTarget takes a concrete `Vector3 | TransformNode` — stays structurally
  // assignable under strictFunctionTypes, while callers may pass an opaque
  // picked point.
  setTarget(target: unknown): void;
}

/** Default orbit framing captured at camera creation, used to reset focus. */
export interface OrbitHome {
  /** Babylon `Vector3` the camera orbits by default (the scene center). */
  target: unknown;
  alpha: number;
  beta: number;
  radius: number;
}

interface FocusPickResult {
  hit: boolean;
  pickedPoint: unknown | null;
}

interface FocusScene {
  pointerX: number;
  pointerY: number;
  pick: (x: number, y: number) => FocusPickResult | null;
}

/**
 * Re-center the orbit camera on whatever scene point the user double-clicks, so
 * they can inspect off-center regions of a large scene. Returns a detach
 * function. Double-clicking empty space (no pick hit) is a no-op so the view
 * never jumps to nowhere. Relies on Babylon's `Ray` side-effect already imported
 * by the canvases for hover picking.
 */
export function attachDoubleClickFocus(
  scene: FocusScene,
  canvas: HTMLCanvasElement,
  camera: OrbitFocusCamera,
): () => void {
  const onDoubleClick = () => {
    const pick = scene.pick(scene.pointerX, scene.pointerY);
    if (pick?.hit && pick.pickedPoint) camera.setTarget(pick.pickedPoint);
  };
  canvas.addEventListener("dblclick", onDoubleClick);
  return () => canvas.removeEventListener("dblclick", onDoubleClick);
}

/** Restore the orbit camera to its captured `home` target and framing. */
export function resetFocus(camera: OrbitFocusCamera, home: OrbitHome): void {
  // setTarget rebuilds alpha/beta/radius from the current position, so reassign
  // the captured angles afterwards to land on the exact original framing.
  camera.setTarget(home.target);
  camera.alpha = home.alpha;
  camera.beta = home.beta;
  camera.radius = home.radius;
}

/** Remove wheel-zoom so the page scrolls normally while hovering the canvas. */
export function disableWheelZoom(camera: OrbitZoomCamera): void {
  camera.inputs.removeByType("ArcRotateCameraMouseWheelInput");
}

/**
 * Multiply the orbit radius by `factor`, clamped to the camera's radius limits.
 * `factor < 1` zooms in (smaller radius); `factor > 1` zooms out.
 */
export function stepZoom(camera: OrbitZoomCamera, factor: number): void {
  const lo = camera.lowerRadiusLimit ?? 0.01;
  const hi = camera.upperRadiusLimit ?? Number.POSITIVE_INFINITY;
  camera.radius = Math.min(hi, Math.max(lo, camera.radius * factor));
}

/** Step factors for the zoom buttons (≈20% per click). */
export const ZOOM_IN_FACTOR = 1 / 1.2;
export const ZOOM_OUT_FACTOR = 1.2;
