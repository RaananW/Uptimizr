import { describe, expect, it } from "vitest";
import { clamp01, defaultColorRamp } from "../colorRamp.js";

describe("clamp01", () => {
  it("clamps below 0 and above 1, passes through in-range", () => {
    expect(clamp01(-0.5)).toBe(0);
    expect(clamp01(0)).toBe(0);
    expect(clamp01(0.42)).toBe(0.42);
    expect(clamp01(1)).toBe(1);
    expect(clamp01(2)).toBe(1);
  });

  it("treats NaN as 0", () => {
    expect(clamp01(Number.NaN)).toBe(0);
  });
});

describe("defaultColorRamp", () => {
  it("starts cold blue and ends white-hot", () => {
    const cold = defaultColorRamp(0);
    expect(cold[2]).toBeGreaterThan(cold[0]); // blue dominates at t=0
    const hot = defaultColorRamp(1);
    expect(hot).toEqual([1, 1, 1]); // white at t=1
  });

  it("clamps out-of-range t", () => {
    expect(defaultColorRamp(-1)).toEqual(defaultColorRamp(0));
    expect(defaultColorRamp(5)).toEqual(defaultColorRamp(1));
  });

  it("returns channels within [0,1] across the ramp", () => {
    for (let i = 0; i <= 10; i++) {
      const [r, g, b] = defaultColorRamp(i / 10);
      for (const c of [r, g, b]) {
        expect(c).toBeGreaterThanOrEqual(0);
        expect(c).toBeLessThanOrEqual(1);
      }
    }
  });
});
