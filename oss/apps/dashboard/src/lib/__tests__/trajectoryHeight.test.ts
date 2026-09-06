import { describe, expect, it } from "vitest";
import type { TrajectoryPoint } from "@/lib/api";
import {
  HEIGHT_FLAT_THRESHOLD,
  formatHeight,
  heightEncodingActive,
  heightRange,
  heightT,
} from "../trajectoryHeight";

const pt = (y: number): TrajectoryPoint => ({ ts: 0, x: 0, y, z: 0 });

describe("heightRange", () => {
  it("returns null for an empty path", () => {
    expect(heightRange([])).toBeNull();
  });

  it("returns the min and max Y across the path", () => {
    expect(heightRange([pt(1.6), pt(4.2), pt(-0.5), pt(2)])).toEqual({ min: -0.5, max: 4.2 });
  });

  it("ignores non-finite samples and returns null when none are usable", () => {
    expect(heightRange([pt(NaN), pt(1), pt(Infinity)])).toEqual({ min: 1, max: 1 });
    expect(heightRange([pt(NaN)])).toBeNull();
  });
});

describe("heightEncodingActive", () => {
  it("is off for a null range and for a span below the flat threshold", () => {
    expect(heightEncodingActive(null)).toBe(false);
    expect(heightEncodingActive({ min: 1.6, max: 1.6 })).toBe(false);
    expect(heightEncodingActive({ min: 1.6, max: 1.6 + HEIGHT_FLAT_THRESHOLD / 2 })).toBe(false);
  });

  it("is on once the span reaches the threshold", () => {
    expect(heightEncodingActive({ min: 0, max: HEIGHT_FLAT_THRESHOLD })).toBe(true);
    expect(heightEncodingActive({ min: 0, max: 3 })).toBe(true);
  });
});

describe("heightT", () => {
  const range = { min: 1, max: 3 };

  it("maps the range ends to 0 and 1 and the middle to 0.5", () => {
    expect(heightT(1, range)).toBe(0);
    expect(heightT(3, range)).toBe(1);
    expect(heightT(2, range)).toBe(0.5);
  });

  it("clamps values outside the range", () => {
    expect(heightT(-10, range)).toBe(0);
    expect(heightT(10, range)).toBe(1);
  });

  it("falls back to 0 for a degenerate range or non-finite input", () => {
    expect(heightT(5, { min: 5, max: 5 })).toBe(0);
    expect(heightT(NaN, range)).toBe(0);
  });
});

describe("formatHeight", () => {
  it("prints one decimal with a metre suffix", () => {
    expect(formatHeight(1.6)).toBe("1.6 m");
    expect(formatHeight(-0.25)).toBe("-0.3 m");
    expect(formatHeight(12)).toBe("12.0 m");
  });
});
