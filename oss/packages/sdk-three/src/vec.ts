import type { Vector3 } from "three";

/** Convert a three.js `Vector3` (or any `{x,y,z}`) into a plain `[x, y, z]` tuple. */
export function toVec3(v: Vector3 | { x: number; y: number; z: number }): [number, number, number] {
  return [v.x, v.y, v.z];
}

/** Clamp a value into the `[0, 1]` range (for normalized screen coordinates). */
export function clamp01(n: number): number {
  return n < 0 ? 0 : n > 1 ? 1 : n;
}
