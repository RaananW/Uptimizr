import { describe, it, expect } from "vitest";
import { classifyCameraGesture } from "../gesture.js";
import type { CameraGestureSample } from "../gesture.js";

/**
 * Tests for the engine-agnostic camera-gesture classifier (ADR 0025). Samples are
 * in the canonical frame (left-handed, y-up); forward points along the look axis.
 */
describe("classifyCameraGesture", () => {
  it("returns null when the camera barely moved (a click, not navigation)", () => {
    const start: CameraGestureSample = { position: [0, 0, -10], forward: [0, 0, 1] };
    const end: CameraGestureSample = { position: [0, 0, -10.0001], forward: [0, 0, 1] };
    expect(classifyCameraGesture(start, end)).toBeNull();
  });

  it("classifies an arc-rotate orbit around an explicit pivot", () => {
    // Camera revolves ~30° around the origin pivot at radius 10.
    const r = 10;
    const a0 = 0;
    const a1 = (30 * Math.PI) / 180;
    const start: CameraGestureSample = {
      position: [r * Math.sin(a0), 0, -r * Math.cos(a0)],
      forward: [-Math.sin(a0), 0, Math.cos(a0)],
      pivot: [0, 0, 0],
      distance: r,
    };
    const end: CameraGestureSample = {
      position: [r * Math.sin(a1), 0, -r * Math.cos(a1)],
      forward: [-Math.sin(a1), 0, Math.cos(a1)],
      pivot: [0, 0, 0],
      distance: r,
    };
    const g = classifyCameraGesture(start, end);
    expect(g?.kind).toBe("orbit");
    expect(g?.orbitDeg).toBeGreaterThan(25);
    expect(g?.orbitDeg).toBeLessThan(35);
  });

  it("classifies a dolly (distance change) as a magnification ratio > 1 when moving in", () => {
    const start: CameraGestureSample = {
      position: [0, 0, -10],
      forward: [0, 0, 1],
      pivot: [0, 0, 0],
      distance: 10,
    };
    const end: CameraGestureSample = {
      position: [0, 0, -5],
      forward: [0, 0, 1],
      pivot: [0, 0, 0],
      distance: 5,
    };
    const g = classifyCameraGesture(start, end);
    expect(g?.kind).toBe("dolly");
    expect(g?.zoomRatio).toBeCloseTo(2, 5); // start/end = 10/5
  });

  it("classifies a fov change as a zoom (camera stationary)", () => {
    const start: CameraGestureSample = {
      position: [0, 0, -10],
      forward: [0, 0, 1],
      fov: 0.8,
    };
    const end: CameraGestureSample = {
      position: [0, 0, -10],
      forward: [0, 0, 1],
      fov: 0.4,
    };
    const g = classifyCameraGesture(start, end);
    expect(g?.kind).toBe("zoom");
    expect(g?.zoomRatio).toBeCloseTo(2, 5);
  });

  it("classifies a pivot-less translation as a fly", () => {
    const start: CameraGestureSample = { position: [0, 0, -10], forward: [0, 0, 1] };
    const end: CameraGestureSample = { position: [5, 0, -10], forward: [0, 0, 1] };
    const g = classifyCameraGesture(start, end, { sceneRadius: 100 });
    expect(g?.kind).toBe("fly");
    expect(g?.panDist).toBeCloseTo(5 / 100, 5);
  });

  it("classifies a pan around an explicit pivot, normalized by camera distance", () => {
    // Camera + pivot both slide +x by 2; forward unchanged; distance 10.
    const start: CameraGestureSample = {
      position: [0, 0, -10],
      forward: [0, 0, 1],
      pivot: [0, 0, 0],
      distance: 10,
    };
    const end: CameraGestureSample = {
      position: [2, 0, -10],
      forward: [0, 0, 1],
      pivot: [2, 0, 0],
      distance: 10,
    };
    const g = classifyCameraGesture(start, end);
    expect(g?.kind).toBe("pan");
    expect(g?.panDist).toBeCloseTo(2 / 10, 5);
  });

  it("detects roll about the forward axis from the up vectors", () => {
    const start: CameraGestureSample = {
      position: [0, 0, -10],
      forward: [0, 0, 1],
      up: [0, 1, 0],
    };
    const end: CameraGestureSample = {
      position: [0, 0, -10],
      forward: [0, 0, 1],
      up: [Math.sin((20 * Math.PI) / 180), Math.cos((20 * Math.PI) / 180), 0],
    };
    const g = classifyCameraGesture(start, end);
    expect(g?.kind).toBe("roll");
    expect(g?.rollDeg).toBeGreaterThan(15);
    expect(g?.rollDeg).toBeLessThan(25);
  });

  it("reports multi-component magnitudes with the dominant kind for a compound gesture", () => {
    // A big orbit with a slight fov zoom — orbit should dominate, both reported.
    const r = 10;
    const a1 = (40 * Math.PI) / 180;
    const start: CameraGestureSample = {
      position: [0, 0, -r],
      forward: [0, 0, 1],
      pivot: [0, 0, 0],
      distance: r,
      fov: 0.8,
    };
    const end: CameraGestureSample = {
      position: [r * Math.sin(a1), 0, -r * Math.cos(a1)],
      forward: [-Math.sin(a1), 0, Math.cos(a1)],
      pivot: [0, 0, 0],
      distance: r,
      fov: 0.78,
    };
    const g = classifyCameraGesture(start, end);
    expect(g?.kind).toBe("orbit");
    expect(g?.orbitDeg).toBeGreaterThan(35);
    expect(g?.zoomRatio).toBeDefined();
  });

  it("respects the sensitivity dial (higher = less sensitive)", () => {
    const start: CameraGestureSample = { position: [0, 0, -10], forward: [0, 0, 1] };
    // ~1.5° forward rotation.
    const a = (1.5 * Math.PI) / 180;
    const end: CameraGestureSample = {
      position: [0, 0, -10],
      forward: [Math.sin(a), 0, Math.cos(a)],
    };
    expect(classifyCameraGesture(start, end)?.kind).toBe("orbit");
    // With sensitivity 3, the orbit dead-zone becomes 3° and 1.5° is ignored.
    expect(classifyCameraGesture(start, end, { sensitivity: 3 })).toBeNull();
  });
});
