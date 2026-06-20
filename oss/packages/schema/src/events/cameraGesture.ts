import { z } from "zod";
import { defineEvent } from "./defineEvent.js";
import { inputSourceShape } from "./inputSource.js";

/**
 * The kind of camera-navigation gesture (ADR 0025). A gesture is a **discrete,
 * user-initiated viewpoint change**, bracketed by an input gesture (pointer
 * down→up, XR thumbstick/grab, …). It is distinct from ambient camera pose
 * (`camera_sample`): head-look, follow-cams, and animations move the camera
 * without a user bracket and are **not** gestures.
 *
 * - `orbit`    — angular sweep of the camera around its pivot/target.
 * - `pan`      — lateral translation of camera + pivot (the framing slides).
 * - `dolly`    — camera moves along its forward axis (parallax changes).
 * - `zoom`     — fov change, camera stationary (lens magnification; no parallax).
 * - `roll`     — rotation about the view/forward axis (the horizon tilts).
 * - `fly`      — user-initiated translation of the viewpoint through space not
 *   driven by orbit/pan/dolly — XR thumbstick locomotion **and** XR teleport (the
 *   discrete viewpoint jump). Distinct from `mesh_interaction { kind: "teleport" }`,
 *   which records the *target pick* (the selection act); `fly` is the *resulting
 *   viewpoint move*. A single teleport may emit both.
 * - `navigate` — the camera moved under a user bracket, but the camera type was
 *   unknown / could not be typed (the graceful fallback).
 *
 * New kinds can be appended without a breaking change.
 */
export const cameraGestureKindSchema = z.enum([
  "orbit",
  "pan",
  "dolly",
  "zoom",
  "roll",
  "fly",
  "navigate",
]);
export type CameraGestureKind = z.infer<typeof cameraGestureKindSchema>;

/**
 * A discrete, user-initiated camera-navigation gesture (ADR 0025). Separates
 * **navigation intent** (changing the view) from **selection intent** (engaging
 * an object): a drag that orbits the camera is recorded here, not as a
 * `pointer_click` / `mesh_interaction`, so click/selection heatmaps stay clean by
 * default.
 *
 * Classified **client-side** from the camera's intrinsic parameters at the
 * gesture's `down` vs `up` instants, where they are precisely available. The
 * event is a *derived summary* of an input bracket — the raw `pointer_*` /
 * `camera_sample` stream is unchanged, so replay stays complete.
 *
 * Carries **no `mesh` and no `hitPoint`**: a navigation gesture is not about an
 * object, and the mesh under the cursor during a view swing is noise.
 *
 * Magnitudes are **multi-component**: every axis that moved reports its
 * magnitude, while `kind` names the dominant one (for easy `GROUP BY kind`).
 * `panDist` is normalized by the camera-to-pivot distance at gesture start
 * (perceptual, scale-free), falling back to a fraction of scene radius for
 * pivot-less cameras.
 */
export const cameraGestureSchema = defineEvent("camera_gesture", {
  /** The dominant motion of the gesture. */
  kind: cameraGestureKindSchema,
  /** Length of the input bracket (`down → up`) in milliseconds. */
  durationMs: z.number().nonnegative(),
  /** Angular sweep around the pivot, in degrees. Present when the gesture orbited. */
  orbitDeg: z.number().nonnegative().optional(),
  /** Rotation about the view/forward axis, in degrees. Present when the gesture rolled. */
  rollDeg: z.number().nonnegative().optional(),
  /**
   * Magnification change ratio (scale-free). For `dolly` it is
   * `startDistance / endDistance` (camera moved along forward); for `zoom` it is
   * the fov ratio `startFov / endFov` (camera stationary). `> 1` = magnified /
   * moved in, `< 1` = widened / pulled back. `kind` disambiguates the mechanism.
   */
  zoomRatio: z.number().positive().optional(),
  /**
   * Lateral translation, normalized by the camera-to-pivot distance at gesture
   * start (scene-radius fraction fallback for pivot-less cameras). Present when
   * the gesture panned or flew.
   */
  panDist: z.number().nonnegative().optional(),
  ...inputSourceShape,
});
export type CameraGestureEvent = z.infer<typeof cameraGestureSchema>;
