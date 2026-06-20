import type { Vector3 } from "@babylonjs/core";

/** Convert a Babylon `Vector3` (or any `{x,y,z}`) into a plain `[x, y, z]` tuple. */
export function toVec3(v: Vector3 | { x: number; y: number; z: number }): [number, number, number] {
  return [v.x, v.y, v.z];
}

/**
 * Convert a Babylon `Quaternion` (or any `{x,y,z,w}`) into a plain `[x, y, z, w]`
 * tuple for the `node_transform` wire shape (ADR 0027). Babylon's world frame is
 * already the canonical frame (ADR 0018), so no axis conversion is applied.
 */
export function toQuat(q: {
  x: number;
  y: number;
  z: number;
  w: number;
}): [number, number, number, number] {
  return [q.x, q.y, q.z, q.w];
}

/** Clamp a value into the `[0, 1]` range (for normalized screen coordinates). */
export function clamp01(n: number): number {
  return n < 0 ? 0 : n > 1 ? 1 : n;
}
