import { describe, expect, it, vi } from "vitest";
import { buildHeatmapInstances, HeatmapOverlay } from "../overlay.js";
import type { HeatmapData, HeatmapDriver } from "../types.js";

const data = (voxels: HeatmapData["voxels"], cellSize = 1): HeatmapData => ({ voxels, cellSize });

describe("buildHeatmapInstances", () => {
  it("normalizes intensity against the busiest voxel", () => {
    const out = buildHeatmapInstances(
      data([
        { vx: 0, vy: 0, vz: 0, count: 10 },
        { vx: 1, vy: 0, vz: 0, count: 5 },
      ]),
      { scaleByIntensity: true, minScale: 0, fill: 1 },
    );
    // Busiest first; busiest fills the full cell, the half-count voxel is half-scale.
    expect(out[0]!.scale).toBeCloseTo(1);
    expect(out[1]!.scale).toBeCloseTo(0.5);
  });

  it("places instances at voxel centers ((v + 0.5) * cellSize)", () => {
    const out = buildHeatmapInstances(data([{ vx: 2, vy: -1, vz: 0, count: 1 }], 0.5));
    expect(out[0]!.position).toEqual([1.25, -0.25, 0.25]);
  });

  it("applies a constant opacity to every instance", () => {
    const out = buildHeatmapInstances(
      data([
        { vx: 0, vy: 0, vz: 0, count: 4 },
        { vx: 1, vy: 0, vz: 0, count: 2 },
      ]),
      { opacity: 0.6 },
    );
    expect(out.every((i) => i.color[3] === 0.6)).toBe(true);
  });

  it("drops non-positive voxels and returns [] when none remain", () => {
    expect(buildHeatmapInstances(data([{ vx: 0, vy: 0, vz: 0, count: 0 }]))).toEqual([]);
    const out = buildHeatmapInstances(
      data([
        { vx: 0, vy: 0, vz: 0, count: -3 },
        { vx: 1, vy: 0, vz: 0, count: 7 },
      ]),
    );
    expect(out).toHaveLength(1);
  });

  it("keeps only the busiest maxVoxels", () => {
    const out = buildHeatmapInstances(
      data([
        { vx: 0, vy: 0, vz: 0, count: 1 },
        { vx: 1, vy: 0, vz: 0, count: 9 },
        { vx: 2, vy: 0, vz: 0, count: 5 },
      ]),
      { maxVoxels: 2, scaleByIntensity: false, fill: 1 },
    );
    expect(out).toHaveLength(2);
    // Sorted busiest-first: counts 9 then 5.
    expect(out[0]!.position[0]).toBeCloseTo(1.5);
    expect(out[1]!.position[0]).toBeCloseTo(2.5);
  });

  it("falls back to cellSize 1 when cellSize is not positive", () => {
    const out = buildHeatmapInstances(data([{ vx: 0, vy: 0, vz: 0, count: 1 }], 0));
    expect(out[0]!.position).toEqual([0.5, 0.5, 0.5]);
  });
});

describe("HeatmapOverlay", () => {
  function fakeDriver(): HeatmapDriver & { rendered: number[] } {
    const rendered: number[] = [];
    return {
      rendered,
      render: vi.fn((instances) => rendered.push(instances.length)),
      clear: vi.fn(),
      setVisible: vi.fn(),
      dispose: vi.fn(),
    };
  }

  it("renders computed instances through the driver", () => {
    const driver = fakeDriver();
    const overlay = new HeatmapOverlay(driver, { scaleByIntensity: false });
    overlay.render(
      data([
        { vx: 0, vy: 0, vz: 0, count: 2 },
        { vx: 1, vy: 0, vz: 0, count: 1 },
      ]),
    );
    expect(driver.render).toHaveBeenCalledTimes(1);
    expect(driver.rendered).toEqual([2]);
  });

  it("delegates clear/setVisible/dispose to the driver", () => {
    const driver = fakeDriver();
    const overlay = new HeatmapOverlay(driver);
    overlay.clear();
    overlay.setVisible(false);
    overlay.dispose();
    expect(driver.clear).toHaveBeenCalledTimes(1);
    expect(driver.setVisible).toHaveBeenCalledWith(false);
    expect(driver.dispose).toHaveBeenCalledTimes(1);
  });
});
