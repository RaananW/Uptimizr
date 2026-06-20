import { describe, expect, it } from "vitest";
import { buildGazeEquirect } from "../gazeSkydome.js";
import type { GazeData } from "../gaze.js";

/** Find the (x, y) of the texel with the greatest alpha. */
function hottestTexel(tex: { width: number; height: number; rgba: Uint8ClampedArray }) {
  let best = -1;
  let bx = -1;
  let by = -1;
  for (let y = 0; y < tex.height; y++) {
    for (let x = 0; x < tex.width; x++) {
      const a = tex.rgba[(y * tex.width + x) * 4 + 3]!;
      if (a > best) {
        best = a;
        bx = x;
        by = y;
      }
    }
  }
  return { x: bx, y: by, alpha: best };
}

describe("buildGazeEquirect", () => {
  it("returns a 2:1 RGBA buffer at the requested width", () => {
    const data: GazeData = { bins: [], gridSize: 8 };
    const tex = buildGazeEquirect(data, { width: 64 });
    expect(tex.width).toBe(64);
    expect(tex.height).toBe(32);
    expect(tex.rgba.length).toBe(64 * 32 * 4);
  });

  it("produces a fully transparent texture when there are no bins", () => {
    const tex = buildGazeEquirect({ bins: [], gridSize: 8 }, { width: 16 });
    expect([...tex.rgba].every((v) => v === 0)).toBe(true);
  });

  it("places the hottest texel at the splatted bin's direction", () => {
    const gridSize = 8;
    const azimuthBin = 6;
    const elevationBin = 5;
    const width = 64;
    const height = 32;
    const tex = buildGazeEquirect(
      { bins: [{ azimuthBin, elevationBin, count: 10 }], gridSize },
      { width, height, blurBins: 1 },
    );

    const az = ((azimuthBin + 0.5) / gridSize) * Math.PI * 2 - Math.PI;
    const el = ((elevationBin + 0.5) / gridSize) * Math.PI - Math.PI / 2;
    const expectedX = Math.round(((az + Math.PI) / (Math.PI * 2)) * width - 0.5);
    const expectedY = Math.round(((Math.PI / 2 - el) / Math.PI) * height - 0.5);

    const hot = hottestTexel(tex);
    // Within a couple texels of the analytic bin center (Gaussian peak).
    expect(Math.abs(hot.x - expectedX)).toBeLessThanOrEqual(2);
    expect(Math.abs(hot.y - expectedY)).toBeLessThanOrEqual(2);
    // Peak normalizes to t = 1 → white-hot, fully opaque.
    expect(hot.alpha).toBe(255);
  });

  it("normalizes intensity so the busiest bin drives the peak", () => {
    const tex = buildGazeEquirect(
      {
        bins: [
          { azimuthBin: 1, elevationBin: 4, count: 1 },
          { azimuthBin: 6, elevationBin: 4, count: 50 },
        ],
        gridSize: 8,
      },
      { width: 64, height: 32, blurBins: 1 },
    );
    const hot = hottestTexel(tex);
    // The busiest bin's column should win.
    const busyAz = ((6 + 0.5) / 8) * Math.PI * 2 - Math.PI;
    const busyX = Math.round(((busyAz + Math.PI) / (Math.PI * 2)) * 64 - 0.5);
    expect(Math.abs(hot.x - busyX)).toBeLessThanOrEqual(2);
  });

  it("respects alphaFloor for empty sky", () => {
    const tex = buildGazeEquirect(
      { bins: [{ azimuthBin: 4, elevationBin: 4, count: 5 }], gridSize: 8 },
      { width: 16, height: 8, alphaFloor: 0.25, blurBins: 0.5 },
    );
    // A texel far from the single splat keeps the floor alpha (~0.25 * 255).
    const cornerAlpha = tex.rgba[3]!;
    expect(cornerAlpha).toBeGreaterThanOrEqual(60);
    expect(cornerAlpha).toBeLessThanOrEqual(70);
  });
});
