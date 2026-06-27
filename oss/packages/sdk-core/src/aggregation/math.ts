import type { Aabb, Quat, Vec3 } from "@uptimizr/schema";

/**
 * Shared, engine-agnostic aggregation math (ADR 0031 follow-up, #10).
 *
 * These are the pure number-crunching helpers that used to live, duplicated,
 * inside each connector's `collector.ts` (percentile, mesh-visibility, and
 * idle-diff math). They are extracted here so the offload {@link Aggregator}
 * and any remaining main-thread caller share **one** implementation — the same
 * function runs unchanged on the main thread or inside a worker (ADR 0031 §2,
 * "no worker-only forks of logic").
 */

// --- Frame-time percentiles (#41) ------------------------------------------

/**
 * Nearest-rank percentile over an **ascending-sorted** array. `p` is in `[0,100]`.
 * Returns `0` for an empty window. Matches the connectors' historical
 * `percentileAsc` exactly so percentile output is byte-for-byte unchanged.
 */
export function percentileAsc(sortedAsc: number[], p: number): number {
  if (sortedAsc.length === 0) return 0;
  const rank = Math.ceil((p / 100) * sortedAsc.length);
  const idx = Math.min(sortedAsc.length, Math.max(1, rank)) - 1;
  return sortedAsc[idx] ?? 0;
}

// --- Vector helpers --------------------------------------------------------

export function sub3(a: Vec3, b: Vec3): Vec3 {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

export function dot3(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

export function length3(a: Vec3): number {
  return Math.hypot(a[0], a[1], a[2]);
}

/** Clamp a value into the `[0, 1]` range (for normalized fractions). */
export function clamp01(n: number): number {
  return n < 0 ? 0 : n > 1 ? 1 : n;
}

// --- Mesh-visibility math (#37, ADR 0012 / ADR 0014) -----------------------

/** One mesh's per-tick contribution to its visibility accumulator. */
export interface VisibilityContribution {
  /** Whether the object's centre is within the centred half-angle (gaze proxy). */
  centered: boolean;
  /** Bounding-sphere angular size as a fraction of the vertical FOV (`0`–`1`). */
  frac: number;
}

/**
 * Per-tick screen-fraction + centred test for one mesh, given the camera pose and
 * the mesh's world bounding sphere. Mirrors the connectors' historical math: a
 * coarse prominence proxy from the bounding-sphere angular size as a fraction of
 * the vertical FOV (ADR 0014 — proxy AABBs, not assets), and a "near the view
 * centre" test from the angle between the view forward and the camera→centre ray.
 */
export function visibilityContribution(
  camPos: Vec3,
  forward: Vec3,
  forwardLen: number,
  halfFov: number,
  center: Vec3,
  radius: number,
  centeredCos: number,
): VisibilityContribution {
  const toCenter = sub3(center, camPos);
  const dist = length3(toCenter) || 1e-6;
  const cosAngle = dot3(toCenter, forward) / (dist * forwardLen);
  const centered = cosAngle >= centeredCos;
  const angularRadius = Math.atan2(radius, dist);
  const frac = clamp01(angularRadius / (halfFov || 1e-6));
  return { centered, frac };
}

/** True when two AABBs match on every component within `eps` (#53 dedupe). */
export function aabbClose(a: Aabb, b: Aabb, eps: number): boolean {
  for (let i = 0; i < 6; i++) {
    if (Math.abs((a[i] ?? 0) - (b[i] ?? 0)) > eps) return false;
  }
  return true;
}

/** Round an AABB to millimetre precision for the wire (and to coarsen layout). */
export function roundAabb(a: Aabb): Aabb {
  return [
    Math.round(a[0] * 1e3) / 1e3,
    Math.round(a[1] * 1e3) / 1e3,
    Math.round(a[2] * 1e3) / 1e3,
    Math.round(a[3] * 1e3) / 1e3,
    Math.round(a[4] * 1e3) / 1e3,
    Math.round(a[5] * 1e3) / 1e3,
  ];
}

// --- Idle-diffing (ADR 0012 conservative defaults) -------------------------

/** True when two vectors are equal within `eps` on every component. */
export function vec3Close(a: Vec3, b: Vec3, eps: number): boolean {
  return (
    Math.abs(a[0] - b[0]) <= eps && Math.abs(a[1] - b[1]) <= eps && Math.abs(a[2] - b[2]) <= eps
  );
}

/** A camera pose compared between samples for idle suppression. */
export interface CameraPose {
  position: Vec3;
  direction: Vec3;
  target?: Vec3;
  fov?: number;
}

/** True when two poses are equal within `eps` (target/fov presence must also match). */
export function poseUnchanged(a: CameraPose, b: CameraPose, eps: number): boolean {
  if (!vec3Close(a.position, b.position, eps)) return false;
  if (!vec3Close(a.direction, b.direction, eps)) return false;
  if ((a.target === undefined) !== (b.target === undefined)) return false;
  if (a.target && b.target && !vec3Close(a.target, b.target, eps)) return false;
  if ((a.fov === undefined) !== (b.fov === undefined)) return false;
  if (a.fov !== undefined && b.fov !== undefined && Math.abs(a.fov - b.fov) > eps) return false;
  return true;
}

/** A captured world/local transform for a scene actor (`node_transform`, ADR 0027). */
export interface NodeSample {
  position: Vec3;
  rotation: Quat;
  scale?: Vec3;
}

/** True when two node samples are equal within `eps` (scale presence must also match). */
export function nodeSampleUnchanged(a: NodeSample, b: NodeSample, eps: number): boolean {
  if (!vec3Close(a.position, b.position, eps)) return false;
  if (
    Math.abs(a.rotation[0] - b.rotation[0]) > eps ||
    Math.abs(a.rotation[1] - b.rotation[1]) > eps ||
    Math.abs(a.rotation[2] - b.rotation[2]) > eps ||
    Math.abs(a.rotation[3] - b.rotation[3]) > eps
  ) {
    return false;
  }
  if ((a.scale === undefined) !== (b.scale === undefined)) return false;
  if (a.scale && b.scale && !vec3Close(a.scale, b.scale, eps)) return false;
  return true;
}
