import type { Handedness, InputSource, Vec3 } from "@uptimizr/schema";

/**
 * Engine-agnostic WebXR input mapping shared by the connectors (three.js, A-Frame,
 * Babylon, …). The per-engine XR collectors read controller pose from their own
 * renderer / XR object and canonicalize coordinates at the emission boundary
 * (ADR 0018); everything in this module is frame-independent — classifying a WebXR
 * input source into the source-neutral schema vocabulary (ADR 0011) and the shared
 * capture-option / ray-probe shapes. No new event types or fields are introduced.
 *
 * Privacy (ADR 0003): the only identity these collectors ever emit is the ephemeral,
 * session-local {@link Handedness} disambiguator — never a persistent device/user id.
 */

/** Structural view of a WebXR `XRInputSource` (only the fields we classify on). */
export interface XrInputSourceLike {
  /** `"left"` / `"right"` / `"none"`. */
  handedness?: string;
  /** `"tracked-pointer"` / `"gaze"` / `"screen"` / `"transient-pointer"`. */
  targetRayMode?: string;
  /** Present for articulated-hand input. */
  hand?: unknown;
}

/**
 * Map a WebXR input source to an Uptimizr {@link InputSource} (ADR 0011):
 * articulated hands → `hand`, gaze target-ray → `gaze`, transient/screen taps →
 * `transient`, everything else (tracked controllers) → `xr-controller`.
 */
export function xrSource(input: XrInputSourceLike): InputSource {
  if (input.hand != null) return "hand";
  const mode = input.targetRayMode;
  if (mode === "gaze") return "gaze";
  if (mode === "transient-pointer" || mode === "screen") return "transient";
  return "xr-controller";
}

/** The paired XR hand, or `undefined` when not applicable (e.g. gaze). */
export function xrHandedness(input: XrInputSourceLike): Handedness | undefined {
  return input.handedness === "left" || input.handedness === "right" ? input.handedness : undefined;
}

/** Which XR signals a connector's XR collector captures. All default to `true`. */
export interface XrCaptureOptions {
  /** Continuous controller/gaze pose → `pointer_move` (with `ray`). */
  pointerMove?: boolean;
  /** Controller `select` (trigger) → `pointer_click`. */
  clicks?: boolean;
  /** Named hit on select/squeeze → `mesh_interaction`. Requires a {@link XrRayProbe}. */
  meshPicks?: boolean;
}

/**
 * A controller-ray raycast result, in the engine's **native** world frame (the
 * collector canonicalizes it before emitting). Optional in every XR collector —
 * without a probe, controller/gaze pose is still captured as `pointer_move` rays and
 * `select` still emits `pointer_click`; only `hitPoint` / `hitMesh` and
 * `mesh_interaction` need a probe.
 */
export interface XrRayHit {
  /** Hit point in the engine's native world frame. */
  point: Vec3;
  /** Hit object's name (empty string when unnamed). */
  name: string;
}

/** Resolve a world-space controller ray to the nearest scene hit, or `undefined`. */
export type XrRayProbe = (origin: Vec3, direction: Vec3) => XrRayHit | undefined;
