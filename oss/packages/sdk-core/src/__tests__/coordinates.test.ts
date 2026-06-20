import { describe, expect, it } from "vitest";

import {
  CANONICAL_FRAME,
  fromCanonicalAabb,
  fromCanonicalDirection,
  fromCanonicalPosition,
  fromCanonicalQuat,
  toCanonicalAabb,
  toCanonicalDirection,
  toCanonicalPosition,
  toCanonicalQuat,
} from "../coordinates.js";

import type { Aabb, Quat, Vec3 } from "@uptimizr/schema";

describe("CANONICAL_FRAME", () => {
  it("is left-handed, y-up, unit scale 1 (ADR 0018)", () => {
    expect(CANONICAL_FRAME).toEqual({ handedness: "left", upAxis: "y", unitScale: 1 });
  });
});

describe("toCanonicalPosition", () => {
  it("is identity for a left-handed (already canonical) source", () => {
    const p: Vec3 = [1, 2, 3];
    expect(toCanonicalPosition(p, "left")).toEqual([1, 2, 3]);
  });

  it("returns a copy, not the same reference", () => {
    const p: Vec3 = [1, 2, 3];
    expect(toCanonicalPosition(p, "left")).not.toBe(p);
  });

  it("negates Z for a right-handed source", () => {
    expect(toCanonicalPosition([1, 2, 3], "right")).toEqual([1, 2, -3]);
  });

  it("normalizes -0 to 0", () => {
    expect(Object.is(toCanonicalPosition([0, 0, 0], "right")[2], 0)).toBe(true);
  });

  it("round-trips back to the original when reflected twice", () => {
    const p: Vec3 = [4, -5, 6];
    expect(toCanonicalPosition(toCanonicalPosition(p, "right"), "right")).toEqual(p);
  });
});

describe("toCanonicalDirection", () => {
  it("is identity for a left-handed source", () => {
    expect(toCanonicalDirection([0, 0, 1], "left")).toEqual([0, 0, 1]);
  });

  it("negates Z for a right-handed source", () => {
    expect(toCanonicalDirection([0, 1, -1], "right")).toEqual([0, 1, 1]);
  });

  it("maps a three.js camera world-forward (-Z) to canonical +Z", () => {
    // A three.js (right-handed) camera at default orientation looks along world -Z.
    // Reflected into the canonical left-handed frame, "into the scene" is +Z.
    expect(toCanonicalDirection([0, 0, -1], "right")).toEqual([0, 0, 1]);
  });
});

describe("toCanonicalAabb", () => {
  it("is identity for a left-handed source", () => {
    const box: Aabb = [-1, -2, -3, 1, 2, 3];
    expect(toCanonicalAabb(box, "left")).toEqual([-1, -2, -3, 1, 2, 3]);
  });

  it("reflects Z and swaps min/max so the box stays well-formed", () => {
    const box: Aabb = [-1, -2, -3, 4, 5, 6];
    const out = toCanonicalAabb(box, "right");
    expect(out).toEqual([-1, -2, -6, 4, 5, 3]);
    // min <= max on every axis
    expect(out[0]).toBeLessThanOrEqual(out[3]);
    expect(out[1]).toBeLessThanOrEqual(out[4]);
    expect(out[2]).toBeLessThanOrEqual(out[5]);
  });
});

describe("fromCanonical* (inverse, for replay)", () => {
  it("fromCanonicalPosition is the inverse of toCanonicalPosition for a right-handed target", () => {
    const canonical: Vec3 = [1, 2, -3];
    // canonical +Z point maps back to three's -Z and vice versa.
    expect(fromCanonicalPosition(canonical, "right")).toEqual([1, 2, 3]);
    // round-trip engine -> canonical -> engine.
    const engine: Vec3 = [4, -5, 6];
    expect(fromCanonicalPosition(toCanonicalPosition(engine, "right"), "right")).toEqual(engine);
  });

  it("fromCanonicalPosition is identity for a left-handed target", () => {
    expect(fromCanonicalPosition([1, 2, 3], "left")).toEqual([1, 2, 3]);
  });

  it("fromCanonicalDirection maps canonical +Z back to a three.js -Z forward", () => {
    expect(fromCanonicalDirection([0, 0, 1], "right")).toEqual([0, 0, -1]);
  });

  it("fromCanonicalAabb inverts toCanonicalAabb for a right-handed target", () => {
    const box: Aabb = [-1, -2, -3, 4, 5, 6];
    expect(fromCanonicalAabb(toCanonicalAabb(box, "right"), "right")).toEqual(box);
  });
});

describe("toCanonicalQuat", () => {
  it("is identity for a left-handed (already canonical) source", () => {
    const q: Quat = [0.1, 0.2, 0.3, 0.9];
    expect(toCanonicalQuat(q, "left")).toEqual([0.1, 0.2, 0.3, 0.9]);
  });

  it("returns a copy, not the same reference", () => {
    const q: Quat = [0, 0, 0, 1];
    expect(toCanonicalQuat(q, "left")).not.toBe(q);
  });

  it("negates x and y for a right-handed source (reflection conjugation)", () => {
    expect(toCanonicalQuat([0.1, 0.2, 0.3, 0.9], "right")).toEqual([-0.1, -0.2, 0.3, 0.9]);
  });

  it("normalizes -0 to 0", () => {
    const out = toCanonicalQuat([0, 0, 0, 1], "right");
    expect(Object.is(out[0], 0)).toBe(true);
    expect(Object.is(out[1], 0)).toBe(true);
  });

  it("round-trips back to the original when reflected twice", () => {
    const q: Quat = [0.4, -0.5, 0.6, 0.48];
    expect(toCanonicalQuat(toCanonicalQuat(q, "right"), "right")).toEqual(q);
  });

  it("fromCanonicalQuat is the inverse of toCanonicalQuat for a right-handed target", () => {
    const engine: Quat = [0.1, -0.2, 0.3, 0.92];
    expect(fromCanonicalQuat(toCanonicalQuat(engine, "right"), "right")).toEqual(engine);
  });
});
