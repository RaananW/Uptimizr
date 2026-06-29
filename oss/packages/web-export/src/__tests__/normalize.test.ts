import { describe, expect, it } from "vitest";
import { normalizeAabb, normalizeDirection, normalizePosition, rebaseZUpToYUp } from "../normalize.js";
import type { NativeFrame } from "../types.js";

const UNITY: NativeFrame = { handedness: "left", upAxis: "y", unitScale: 1 };
const GODOT: NativeFrame = { handedness: "right", upAxis: "y", unitScale: 1 };
const UNREAL: NativeFrame = { handedness: "left", upAxis: "z", unitScale: 100 };

describe("normalizePosition", () => {
  it("Unity (LH, y-up, m) is already canonical — identity", () => {
    expect(normalizePosition([1, 2, 3], UNITY)).toEqual([1, 2, 3]);
  });

  it("Godot (RH, y-up, m) negates Z", () => {
    expect(normalizePosition([1, 2, 3], GODOT)).toEqual([1, 2, -3]);
  });

  it("Unreal (LH, z-up, cm) rebases z-up→y-up and scales cm→m", () => {
    // native cm [100, 200, 300] → /100 → [1, 2, 3] → rebase (x, z, -y) → [1, 3, -2]
    expect(normalizePosition([100, 200, 300], UNREAL)).toEqual([1, 3, -2]);
  });

  it("Unreal native up (+Z) maps to canonical up (+Y)", () => {
    expect(normalizePosition([0, 0, 100], UNREAL)).toEqual([0, 1, 0]);
  });
});

describe("normalizeDirection", () => {
  it("is scale-invariant (no unitScale applied) for Unreal", () => {
    // direction (x, z, -y); unitScale must NOT divide a direction
    expect(normalizeDirection([0, 0, 1], UNREAL)).toEqual([0, 1, 0]);
  });

  it("Godot negates Z", () => {
    expect(normalizeDirection([0, 0, 1], GODOT)).toEqual([0, 0, -1]);
  });
});

describe("normalizeAabb", () => {
  it("Unity AABB passes through", () => {
    expect(normalizeAabb([-1, -2, -3, 1, 2, 3], UNITY)).toEqual([-1, -2, -3, 1, 2, 3]);
  });

  it("Godot AABB negates+swaps Z so min ≤ max holds", () => {
    expect(normalizeAabb([-1, -2, -3, 1, 2, 3], GODOT)).toEqual([-1, -2, -3, 1, 2, 3]);
  });

  it("Unreal AABB rebases z-up→y-up, scales cm→m, stays well-formed", () => {
    // native cm [-100,-200,-300, 100,200,300] → /100 → [-1,-2,-3, 1,2,3]
    // rebase: newY from old Z [-3,3]; newZ = -old Y → [-2,2]
    const out = normalizeAabb([-100, -200, -300, 100, 200, 300], UNREAL);
    expect(out).toEqual([-1, -3, -2, 1, 3, 2]);
    expect(out[0]).toBeLessThanOrEqual(out[3]);
    expect(out[1]).toBeLessThanOrEqual(out[4]);
    expect(out[2]).toBeLessThanOrEqual(out[5]);
  });
});

describe("rebaseZUpToYUp", () => {
  it("is a proper rotation: (x, y, z) → (x, z, -y)", () => {
    expect(rebaseZUpToYUp([1, 2, 3])).toEqual([1, 3, -2]);
  });

  it("normalizes -0 to 0", () => {
    expect(rebaseZUpToYUp([0, 0, 0])).toEqual([0, 0, 0]);
  });
});
