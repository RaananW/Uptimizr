// Shared orbit-camera zoom helpers for the embedded Babylon canvases.
//
// Babylon's ArcRotateCamera binds the mouse wheel to zoom, which hijacks page
// scrolling whenever the pointer is over a canvas. We remove that input and drive
// zoom from explicit +/- buttons instead, so the page scrolls normally and zoom
// stays discoverable. Typed structurally to avoid importing Babylon at the top
// level (the canvases load it dynamically, browser-only).

export interface OrbitZoomCamera {
  radius: number;
  lowerRadiusLimit: number | null;
  upperRadiusLimit: number | null;
  inputs: { removeByType: (inputType: string) => void };
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
