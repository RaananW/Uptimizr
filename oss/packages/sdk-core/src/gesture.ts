import type { CameraGestureKind, Vec3 } from "@uptimizr/schema";

/**
 * Shared, engine-agnostic camera-gesture classifier (ADR 0025).
 *
 * A gesture is a **discrete, user-initiated viewpoint change** bracketed by an
 * input gesture (pointer down→up, XR thumbstick/grab). Connectors snapshot the
 * camera at the bracket's start and end and hand both samples here; this module
 * decides whether the camera moved enough to count as navigation and, if so,
 * which kind (orbit / pan / dolly / zoom / roll / fly) dominated and by how much.
 *
 * It is pure (no engine, no DOM): it consumes only canonical-frame pose +
 * optional intrinsics, so every connector shares one classification contract.
 * Connectors that expose a real pivot/distance (Babylon `ArcRotateCamera`) get
 * the most precise typing; connectors that expose only position + forward
 * (three.js, PlayCanvas, where orbit controls are an external library) still get
 * a good result because an **implied pivot** is inferred from the two view rays.
 */

/**
 * A camera snapshot at one instant of a gesture bracket, in the canonical world
 * frame (ADR 0018). Only `position` and `forward` are required; the rest sharpen
 * the classification when the camera exposes them.
 */
export interface CameraGestureSample {
  /** World position. */
  position: Vec3;
  /** Normalized forward / look direction. */
  forward: Vec3;
  /** Normalized up direction. Enables roll detection when present. */
  up?: Vec3;
  /** Explicit pivot/target point (e.g. an arc-rotate camera's target). */
  pivot?: Vec3;
  /** Camera-to-pivot distance (e.g. an arc-rotate radius). */
  distance?: number;
  /** Vertical field of view in radians. Enables `zoom` (fov) detection. */
  fov?: number;
}

/**
 * Per-axis motion dead-zones: the minimum change on each axis that counts as
 * navigation rather than a click/select (ADR 0025). Below every threshold the
 * gesture is not a navigation gesture and {@link classifyCameraGesture} returns
 * `null`. A single {@link GestureClassifyOptions.sensitivity} dial scales all of
 * them together; per-axis overrides are a rarely-needed escape hatch.
 */
export interface GestureThresholds {
  /** Min forward/orbit rotation, in degrees. Default 1. */
  orbitDeg: number;
  /** Min roll about the forward axis, in degrees. Default 1. */
  rollDeg: number;
  /** Min magnification change `|zoomRatio - 1|` (dolly or fov). Default 0.02. */
  zoom: number;
  /** Min normalized pan/fly distance. Default 0.005. */
  pan: number;
}

/** Default per-axis dead-zones (ADR 0025 §3). */
export const DEFAULT_GESTURE_THRESHOLDS: GestureThresholds = {
  orbitDeg: 1,
  rollDeg: 1,
  zoom: 0.02,
  pan: 0.005,
};

export interface GestureClassifyOptions {
  /** Per-axis dead-zone overrides. Omitted axes use {@link DEFAULT_GESTURE_THRESHOLDS}. */
  thresholds?: Partial<GestureThresholds>;
  /**
   * Single sensitivity multiplier scaling every dead-zone (ADR 0025 §3). `< 1`
   * makes the classifier more sensitive (smaller dead-zones), `> 1` less. Default 1.
   */
  sensitivity?: number;
  /**
   * Scene bounding radius, used to normalize `panDist` for pivot-less cameras
   * (the fallback when no camera-to-pivot distance is available). Omit when
   * unknown; pan magnitude then falls back to raw world units.
   */
  sceneRadius?: number;
}

/** The classified gesture magnitudes + dominant {@link CameraGestureKind}. */
export interface ClassifiedGesture {
  /** The dominant motion. */
  kind: CameraGestureKind;
  /** Angular sweep of the forward direction, in degrees, when it rotated. */
  orbitDeg?: number;
  /** Roll about the forward axis, in degrees, when it rolled. */
  rollDeg?: number;
  /** Magnification ratio (`> 1` = moved/zoomed in) for dolly or fov zoom. */
  zoomRatio?: number;
  /** Normalized lateral/free translation distance, when it panned or flew. */
  panDist?: number;
}

const RAD2DEG = 180 / Math.PI;

function sub(a: Vec3, b: Vec3): Vec3 {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}
function dot(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}
function len(a: Vec3): number {
  return Math.hypot(a[0], a[1], a[2]);
}
function normalize(a: Vec3): Vec3 {
  const l = len(a);
  return l > 1e-9 ? [a[0] / l, a[1] / l, a[2] / l] : [0, 0, 0];
}
/** Angle between two vectors in degrees, clamped against floating-point drift. */
function angleDeg(a: Vec3, b: Vec3): number {
  const la = len(a);
  const lb = len(b);
  if (la < 1e-9 || lb < 1e-9) return 0;
  const c = Math.min(1, Math.max(-1, dot(a, b) / (la * lb)));
  return Math.acos(c) * RAD2DEG;
}

/**
 * Infer a pivot point from two view rays (origin + forward) when the camera does
 * not expose one. If the forward direction rotated, the closest approach of the
 * two rays approximates the point the user revolved around — letting pivot-less
 * cameras (three.js / PlayCanvas orbit controls) be typed as `orbit`/`pan` and
 * giving a distance to normalize `panDist`. Returns `null` when the rays are
 * near-parallel (no rotation ⇒ no orbit) or converge behind the camera.
 */
function inferPivot(
  start: CameraGestureSample,
  end: CameraGestureSample,
): {
  pivot: Vec3;
  distance: number;
} | null {
  const p0 = start.position;
  const d0 = normalize(start.forward);
  const p1 = end.position;
  const d1 = normalize(end.forward);
  const r = sub(p0, p1);
  const a = dot(d0, d0); // = 1
  const b = dot(d0, d1);
  const c = dot(d1, d1); // = 1
  const d = dot(d0, r);
  const e = dot(d1, r);
  const denom = a * c - b * b;
  // Near-parallel rays ⇒ no meaningful rotation/pivot.
  if (denom < 1e-4) return null;
  const t0 = (b * e - c * d) / denom;
  const t1 = (a * e - b * d) / denom;
  // Pivot must be in front of both cameras to be a revolve target.
  if (t0 <= 0 || t1 <= 0) return null;
  const c0: Vec3 = [p0[0] + t0 * d0[0], p0[1] + t0 * d0[1], p0[2] + t0 * d0[2]];
  const c1: Vec3 = [p1[0] + t1 * d1[0], p1[1] + t1 * d1[1], p1[2] + t1 * d1[2]];
  const pivot: Vec3 = [(c0[0] + c1[0]) / 2, (c0[1] + c1[1]) / 2, (c0[2] + c1[2]) / 2];
  return { pivot, distance: (t0 + t1) / 2 };
}

/** Roll = rotation about the forward axis, read from the up vectors' twist. */
function computeRollDeg(start: CameraGestureSample, end: CameraGestureSample): number {
  if (!start.up || !end.up) return 0;
  // Project both up vectors onto the plane perpendicular to the (shared) forward
  // axis, then measure the angle between the projections — that is the twist.
  const f = normalize([
    start.forward[0] + end.forward[0],
    start.forward[1] + end.forward[1],
    start.forward[2] + end.forward[2],
  ]);
  if (len(f) < 1e-6) return 0;
  const u0 = normalize(
    sub(start.up, [f[0] * dot(start.up, f), f[1] * dot(start.up, f), f[2] * dot(start.up, f)]),
  );
  const u1 = normalize(
    sub(end.up, [f[0] * dot(end.up, f), f[1] * dot(end.up, f), f[2] * dot(end.up, f)]),
  );
  return angleDeg(u0, u1);
}

/**
 * Classify a camera-navigation gesture (ADR 0025) from its start/end snapshots.
 *
 * Returns the dominant {@link ClassifiedGesture.kind} plus the magnitude of every
 * axis that exceeded its dead-zone, or `null` when the camera did not move enough
 * to be navigation (i.e. the bracket should remain a click/select).
 *
 * The dominant axis is the one most strongly exceeding its own dead-zone (its
 * magnitude-over-threshold ratio), so kinds with different units (degrees vs.
 * ratios vs. distances) are compared on a common "signal above noise" scale.
 */
export function classifyCameraGesture(
  start: CameraGestureSample,
  end: CameraGestureSample,
  options: GestureClassifyOptions = {},
): ClassifiedGesture | null {
  const sensitivity = options.sensitivity && options.sensitivity > 0 ? options.sensitivity : 1;
  const t: GestureThresholds = {
    orbitDeg: (options.thresholds?.orbitDeg ?? DEFAULT_GESTURE_THRESHOLDS.orbitDeg) * sensitivity,
    rollDeg: (options.thresholds?.rollDeg ?? DEFAULT_GESTURE_THRESHOLDS.rollDeg) * sensitivity,
    zoom: (options.thresholds?.zoom ?? DEFAULT_GESTURE_THRESHOLDS.zoom) * sensitivity,
    pan: (options.thresholds?.pan ?? DEFAULT_GESTURE_THRESHOLDS.pan) * sensitivity,
  };

  // Resolve a pivot/distance: explicit (arc-rotate) first, else inferred from the
  // two view rays. Pivot-less cameras with no rotation stay pivot-less (→ fly).
  const explicitPivot =
    start.pivot && start.distance !== undefined
      ? { pivot: start.pivot, distance: start.distance, explicit: true as const }
      : null;
  const inferred = explicitPivot ? null : inferPivot(start, end);
  const pivot = explicitPivot ?? (inferred ? { ...inferred, explicit: false as const } : null);

  // --- Axis magnitudes -------------------------------------------------------
  const orbitDeg = angleDeg(start.forward, end.forward);
  const rollDeg = computeRollDeg(start, end);

  // Magnification: prefer fov change (zoom); else a pivot-distance change (dolly).
  let zoomRatio: number | undefined;
  let zoomIsDolly = false;
  if (start.fov !== undefined && end.fov !== undefined && end.fov > 1e-6) {
    zoomRatio = start.fov / end.fov;
  } else if (
    explicitPivot &&
    start.distance !== undefined &&
    end.distance !== undefined &&
    end.distance > 1e-6
  ) {
    zoomRatio = start.distance / end.distance;
    zoomIsDolly = true;
  }

  // Translation: with a pivot, pan = lateral motion of the pivot (the framing
  // slides); without a pivot, the whole position translation is free flight.
  const translation = sub(end.position, start.position);
  let panRaw: number;
  let isFly = false;
  if (pivot) {
    const pivotEnd = explicitPivot
      ? (end.pivot ?? pivot.pivot)
      : (inferPivot(end, start)?.pivot ?? pivot.pivot);
    const pivotDelta = sub(pivotEnd, pivot.pivot);
    // Lateral component (perpendicular to forward) of the pivot's movement.
    const f = normalize(start.forward);
    const along = dot(pivotDelta, f);
    const lateral = sub(pivotDelta, [f[0] * along, f[1] * along, f[2] * along]);
    panRaw = len(lateral);
  } else {
    panRaw = len(translation);
    isFly = panRaw > 0;
  }
  // Normalize pan by camera-to-pivot distance (perceptual), else scene radius.
  const panNormalizer =
    pivot && pivot.distance > 1e-6
      ? pivot.distance
      : options.sceneRadius && options.sceneRadius > 1e-6
        ? options.sceneRadius
        : undefined;
  const panDist = panNormalizer ? panRaw / panNormalizer : panRaw;

  // --- Dead-zone gate + dominant axis ---------------------------------------
  const zoomMag = zoomRatio !== undefined ? Math.abs(zoomRatio - 1) : 0;
  const scores: Array<{ kind: CameraGestureKind; ratio: number }> = [];
  if (orbitDeg > t.orbitDeg) scores.push({ kind: "orbit", ratio: orbitDeg / t.orbitDeg });
  if (rollDeg > t.rollDeg) scores.push({ kind: "roll", ratio: rollDeg / t.rollDeg });
  if (zoomMag > t.zoom) {
    scores.push({ kind: zoomIsDolly ? "dolly" : "zoom", ratio: zoomMag / t.zoom });
  }
  if (panDist > t.pan) {
    scores.push({ kind: isFly ? "fly" : "pan", ratio: panDist / t.pan });
  }
  if (scores.length === 0) return null;

  scores.sort((x, y) => y.ratio - x.ratio);
  const kind = scores[0]!.kind;

  const result: ClassifiedGesture = { kind };
  if (orbitDeg > t.orbitDeg) result.orbitDeg = orbitDeg;
  if (rollDeg > t.rollDeg) result.rollDeg = rollDeg;
  if (zoomMag > t.zoom && zoomRatio !== undefined) result.zoomRatio = zoomRatio;
  if (panDist > t.pan) result.panDist = panDist;
  return result;
}
