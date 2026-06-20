import type { Quat, Vec3 } from "@uptimizr/schema";

/**
 * A decomposed world transform: position, rotation quaternion `[x,y,z,w]`, and
 * scale — in the **source engine's native frame**. Apply the `toCanonical*`
 * helpers to reflect into the canonical wire frame (ADR 0018).
 */
export interface DecomposedTransform {
  position: Vec3;
  rotation: Quat;
  scale: Vec3;
}

/**
 * Decompose a **column-major** world matrix (the layout three.js `Matrix4.elements`,
 * Babylon `Matrix.m`, and PlayCanvas `Mat4.data` all share) into position /
 * rotation quaternion / scale, using the same algorithm as `Matrix4.decompose`:
 * scale is the length of each basis column (negate `sx` when the upper-left 3×3 has
 * a negative determinant, to keep a proper rotation), then the scale-normalized
 * basis is converted to a quaternion. The result is in the matrix's own frame; the
 * caller converts to canonical with {@link toCanonicalPosition}/{@link toCanonicalQuat}.
 */
export function decomposeWorldMatrix(e: ArrayLike<number>): DecomposedTransform {
  const position: Vec3 = [(e[12] as number) ?? 0, (e[13] as number) ?? 0, (e[14] as number) ?? 0];
  let sx = Math.hypot(e[0] as number, e[1] as number, e[2] as number);
  const sy = Math.hypot(e[4] as number, e[5] as number, e[6] as number);
  const sz = Math.hypot(e[8] as number, e[9] as number, e[10] as number);
  const det =
    (e[0] as number) *
      ((e[5] as number) * (e[10] as number) - (e[6] as number) * (e[9] as number)) -
    (e[4] as number) *
      ((e[1] as number) * (e[10] as number) - (e[2] as number) * (e[9] as number)) +
    (e[8] as number) * ((e[1] as number) * (e[6] as number) - (e[2] as number) * (e[5] as number));
  if (det < 0) sx = -sx;
  const ix = sx !== 0 ? 1 / sx : 0;
  const iy = sy !== 0 ? 1 / sy : 0;
  const iz = sz !== 0 ? 1 / sz : 0;
  const m11 = (e[0] as number) * ix,
    m21 = (e[1] as number) * ix,
    m31 = (e[2] as number) * ix;
  const m12 = (e[4] as number) * iy,
    m22 = (e[5] as number) * iy,
    m32 = (e[6] as number) * iy;
  const m13 = (e[8] as number) * iz,
    m23 = (e[9] as number) * iz,
    m33 = (e[10] as number) * iz;
  const trace = m11 + m22 + m33;
  let x: number, y: number, z: number, w: number;
  if (trace > 0) {
    const s = 0.5 / Math.sqrt(trace + 1);
    w = 0.25 / s;
    x = (m32 - m23) * s;
    y = (m13 - m31) * s;
    z = (m21 - m12) * s;
  } else if (m11 > m22 && m11 > m33) {
    const s = 2 * Math.sqrt(1 + m11 - m22 - m33);
    w = (m32 - m23) / s;
    x = 0.25 * s;
    y = (m12 + m21) / s;
    z = (m13 + m31) / s;
  } else if (m22 > m33) {
    const s = 2 * Math.sqrt(1 + m22 - m11 - m33);
    w = (m13 - m31) / s;
    x = (m12 + m21) / s;
    y = 0.25 * s;
    z = (m23 + m32) / s;
  } else {
    const s = 2 * Math.sqrt(1 + m33 - m11 - m22);
    w = (m21 - m12) / s;
    x = (m13 + m31) / s;
    y = (m23 + m32) / s;
    z = 0.25 * s;
  }
  return { position, rotation: [x, y, z, w], scale: [sx, sy, sz] };
}
