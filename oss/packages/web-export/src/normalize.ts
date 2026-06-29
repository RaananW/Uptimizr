import type { Aabb, Vec3 } from "@uptimizr/schema";
import { toCanonicalAabb, toCanonicalDirection, toCanonicalPosition } from "@uptimizr/sdk-core";
import type { NativeFrame } from "./types.js";

/**
 * Normalize a web-export engine's **world-space** payloads to the canonical wire
 * frame (left-handed, y-up, unit scale 1 — ADR 0018).
 *
 * The shared sdk-core helpers (`toCanonicalPosition` / `Direction` / `Aabb`) assume
 * a **y-up** source and only correct handedness. Two engines need more than that and
 * are handled here, *before* delegating to those helpers (ADR 0045 §5):
 *
 * - **Up-axis rebase.** Unreal is **z-up**; we rotate its world data into a y-up
 *   frame of the *same handedness* (a proper rotation, so handedness is preserved)
 *   so the sdk-core helpers see the y-up source they expect.
 * - **Unit scale.** Unreal works in **centimeters** (`unitScale: 100`); positions,
 *   hit points, and AABB extents are divided by `unitScale` so canonical output is
 *   always meters. Directions are scale-invariant and unaffected.
 *
 * Unity (left-handed, y-up, meters) is already canonical and passes through
 * untouched; Godot (right-handed, y-up, meters) only has its Z negated.
 */

/** `-0` → `0` so converted payloads serialize cleanly. */
function nz(n: number): number {
  return n === 0 ? 0 : n;
}

/**
 * Rebase a z-up world vector into a y-up frame of the **same handedness** via a
 * proper rotation of −90° about X: `(x, y, z) → (x, z, -y)`. The engine's up axis
 * (`+Z`) maps to `+Y`; because a rotation has determinant `+1`, handedness is
 * preserved, so the subsequent sdk-core handedness step stays valid.
 */
export function rebaseZUpToYUp(v: Vec3): Vec3 {
  return [nz(v[0]), nz(v[2]), nz(-v[1])];
}

/** Apply the same `(x, y, z) → (x, z, -y)` rebase to an AABB, keeping min ≤ max. */
function rebaseAabbZUpToYUp(a: Aabb): Aabb {
  // new Y comes from old Z (order preserved); new Z = -old Y (order flips).
  return [nz(a[0]), nz(a[2]), nz(-a[4]), nz(a[3]), nz(a[5]), nz(-a[1])];
}

function scalePosition(p: Vec3, unitScale: number): Vec3 {
  return unitScale === 1
    ? [p[0], p[1], p[2]]
    : [p[0] / unitScale, p[1] / unitScale, p[2] / unitScale];
}

function scaleAabb(a: Aabb, unitScale: number): Aabb {
  if (unitScale === 1) return [a[0], a[1], a[2], a[3], a[4], a[5]];
  const s = 1 / unitScale;
  return [a[0] * s, a[1] * s, a[2] * s, a[3] * s, a[4] * s, a[5] * s];
}

/** Normalize a world-space **position** to the canonical frame. */
export function normalizePosition(p: Vec3, frame: NativeFrame): Vec3 {
  let v = scalePosition(p, frame.unitScale);
  if (frame.upAxis === "z") v = rebaseZUpToYUp(v);
  return toCanonicalPosition(v, frame.handedness);
}

/** Normalize a world-space **direction** to the canonical frame (scale-invariant). */
export function normalizeDirection(d: Vec3, frame: NativeFrame): Vec3 {
  let v: Vec3 = [d[0], d[1], d[2]];
  if (frame.upAxis === "z") v = rebaseZUpToYUp(v);
  return toCanonicalDirection(v, frame.handedness);
}

/** Normalize a world-space **AABB** `[minX,minY,minZ,maxX,maxY,maxZ]` to canonical. */
export function normalizeAabb(a: Aabb, frame: NativeFrame): Aabb {
  let v = scaleAabb(a, frame.unitScale);
  if (frame.upAxis === "z") v = rebaseAabbZUpToYUp(v);
  return toCanonicalAabb(v, frame.handedness);
}
