import type { Aabb, CoordinateHandedness, Quat, Vec3 } from "@uptimizr/schema";

/**
 * Canonical world coordinate frame for everything on the wire (ADR 0018):
 * **left-handed, y-up, unit scale 1** (Babylon-native). Connectors normalize their
 * engine's world-space data to this frame at the emission boundary and record their
 * native frame as provenance on `session_start`.
 */
export const CANONICAL_FRAME = {
  handedness: "left",
  upAxis: "y",
  unitScale: 1,
} as const;

/** Normalize `-0` to `0` so converted payloads serialize cleanly. */
function nz(n: number): number {
  return n === 0 ? 0 : n;
}

/**
 * Convert a **world-space position** from a source engine's frame to the canonical
 * frame (left-handed, y-up).
 *
 * Assumes a **y-up** source (true for three.js, glTF, PlayCanvas, Babylon). For a
 * right-handed source the handedness flip is the reflection `diag(1, 1, -1)` —
 * i.e. negate Z. A left-handed source is already canonical and is returned
 * unchanged (a fresh copy). Non-y-up sources are out of scope; the connector must
 * rebase to y-up before calling.
 */
export function toCanonicalPosition(p: Vec3, sourceHandedness: CoordinateHandedness): Vec3 {
  if (sourceHandedness === "left") return [p[0], p[1], p[2]];
  return [nz(p[0]), nz(p[1]), nz(-p[2])];
}

/**
 * Convert a **world-space direction vector** (e.g. a camera's forward ray) from a
 * source engine's frame to the canonical frame. Same reflection as
 * {@link toCanonicalPosition} — directions ignore translation, so a right-handed
 * source negates Z.
 *
 * ⚠️ Orientation is convention-dependent, and this is the common trap. A camera's
 * *look direction* differs per engine: three.js cameras look along local **−Z**,
 * the canonical (Babylon-style) camera looks along local **+Z**. This helper is
 * correct **only when you pass a true world-space direction** (the actual look
 * vector in world coordinates). If you instead reconstruct orientation from a
 * **local quaternion / Euler**, reflecting components is **not** enough — you must
 * also apply a rotation (a forward-axis flip / ~180° about the up axis) to account
 * for the −Z vs +Z forward convention. Capture orientation as a world-space
 * forward (and up) direction *before* converting.
 */
export function toCanonicalDirection(d: Vec3, sourceHandedness: CoordinateHandedness): Vec3 {
  if (sourceHandedness === "left") return [d[0], d[1], d[2]];
  return [nz(d[0]), nz(d[1]), nz(-d[2])];
}

/**
 * Convert a world-space axis-aligned bounding box `[minX, minY, minZ, maxX, maxY,
 * maxZ]` to the canonical frame. Negating the Z axis swaps the Z min/max, so the
 * result stays a well-formed AABB (min ≤ max per axis).
 */
export function toCanonicalAabb(aabb: Aabb, sourceHandedness: CoordinateHandedness): Aabb {
  if (sourceHandedness === "left") {
    return [aabb[0], aabb[1], aabb[2], aabb[3], aabb[4], aabb[5]];
  }
  // X/Y unchanged; Z reflects, so the old maxZ becomes the new minZ and vice versa.
  return [nz(aabb[0]), nz(aabb[1]), nz(-aabb[5]), nz(aabb[3]), nz(aabb[4]), nz(-aabb[2])];
}

/**
 * Convert a **world-space position** from the canonical frame back into a target
 * engine's native frame — the inverse of {@link toCanonicalPosition}. Used by
 * replay drivers, which read canonical events off the wire and write them into a
 * host scene (e.g. re-driving a three.js camera).
 *
 * The handedness flip is the reflection `diag(1, 1, -1)`, which is its own
 * inverse, so this delegates to the same basis change — but the named inverse
 * keeps replay/host code self-documenting (canonical → engine).
 */
export function fromCanonicalPosition(p: Vec3, targetHandedness: CoordinateHandedness): Vec3 {
  return toCanonicalPosition(p, targetHandedness);
}

/**
 * Convert a **world-space direction vector** from the canonical frame back into a
 * target engine's native frame — the inverse of {@link toCanonicalDirection}.
 *
 * The same orientation caveat applies in reverse: this yields a correct
 * world-space direction, but a host that needs a *camera orientation* should
 * point the camera at a converted world-space target (e.g. `camera.lookAt`)
 * rather than feeding this into a local-rotation reconstruction.
 */
export function fromCanonicalDirection(d: Vec3, targetHandedness: CoordinateHandedness): Vec3 {
  return toCanonicalDirection(d, targetHandedness);
}

/**
 * Convert a world-space AABB from the canonical frame back into a target engine's
 * native frame — the inverse of {@link toCanonicalAabb} (Z min/max swap is its
 * own inverse, so the box stays well-formed).
 */
export function fromCanonicalAabb(aabb: Aabb, targetHandedness: CoordinateHandedness): Aabb {
  return toCanonicalAabb(aabb, targetHandedness);
}

/**
 * Convert a **world-space orientation quaternion** `[x, y, z, w]` from a source
 * engine's frame to the canonical frame (left-handed, y-up). Used for
 * `node_transform` (ADR 0027): a scene actor's world rotation.
 *
 * The handedness flip is the same reflection as {@link toCanonicalPosition}
 * (`diag(1, 1, -1)`, i.e. negate Z). Conjugating a rotation by that reflection
 * maps the quaternion `(x, y, z, w) → (-x, -y, z, w)`: the reflected rotation
 * axis is `(ax, ay, -az)` while the handedness flip negates the angle, and the
 * two sign changes combine to leave only `x` and `y` negated. A left-handed
 * source is already canonical and returned as a copy.
 *
 * Unlike a camera's *look direction* (whose forward-axis convention differs per
 * engine — see {@link toCanonicalDirection}), an object's world rotation has no
 * such convention, so this conversion is exact for scene-actor orientation.
 */
export function toCanonicalQuat(q: Quat, sourceHandedness: CoordinateHandedness): Quat {
  if (sourceHandedness === "left") return [q[0], q[1], q[2], q[3]];
  return [nz(-q[0]), nz(-q[1]), nz(q[2]), nz(q[3])];
}

/**
 * Convert a **world-space orientation quaternion** from the canonical frame back
 * into a target engine's native frame — the inverse of {@link toCanonicalQuat}.
 * The reflection is its own inverse, so this delegates to the same basis change;
 * the named inverse keeps replay/host code self-documenting (canonical → engine).
 */
export function fromCanonicalQuat(q: Quat, targetHandedness: CoordinateHandedness): Quat {
  return toCanonicalQuat(q, targetHandedness);
}
