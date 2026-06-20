import { describe, expect, it, vi } from "vitest";
import { buildGazeInstances, GazeOverlay, type GazeData } from "../gaze.js";
import type { HeatmapDriver } from "../types.js";

const data = (bins: GazeData["bins"], gridSize = 36): GazeData => ({ bins, gridSize });

describe("buildGazeInstances", () => {
  it("normalizes marker size against the busiest bin", () => {
    const out = buildGazeInstances(
      data([
        { azimuthBin: 0, elevationBin: 18, count: 10 },
        { azimuthBin: 5, elevationBin: 18, count: 5 },
      ]),
      { scaleByIntensity: true, minScale: 0, radius: 1, markerScale: 1 },
    );
    // Busiest first; full marker for the busiest, half for the half-count bin.
    expect(out[0]!.scale).toBeCloseTo(1);
    expect(out[1]!.scale).toBeCloseTo(0.5);
  });

  it("places every marker on the dome at `radius` from the center", () => {
    const out = buildGazeInstances(
      data([
        { azimuthBin: 3, elevationBin: 7, count: 4 },
        { azimuthBin: 20, elevationBin: 30, count: 2 },
      ]),
      { radius: 4, center: [1, 2, 3] },
    );
    for (const inst of out) {
      const dx = inst.position[0] - 1;
      const dy = inst.position[1] - 2;
      const dz = inst.position[2] - 3;
      expect(Math.hypot(dx, dy, dz)).toBeCloseTo(4);
    }
  });

  it("maps high elevation bins up (+y) and low elevation bins down (-y)", () => {
    const up = buildGazeInstances(data([{ azimuthBin: 0, elevationBin: 35, count: 1 }]), {
      radius: 1,
    });
    const down = buildGazeInstances(data([{ azimuthBin: 0, elevationBin: 0, count: 1 }]), {
      radius: 1,
    });
    expect(up[0]!.position[1]).toBeGreaterThan(0.9);
    expect(down[0]!.position[1]).toBeLessThan(-0.9);
  });

  it("applies a constant opacity to every marker", () => {
    const out = buildGazeInstances(
      data([
        { azimuthBin: 0, elevationBin: 18, count: 4 },
        { azimuthBin: 1, elevationBin: 18, count: 2 },
      ]),
      { opacity: 0.6 },
    );
    expect(out.every((i) => i.color[3] === 0.6)).toBe(true);
  });

  it("drops non-positive bins and returns [] when none remain", () => {
    expect(buildGazeInstances(data([{ azimuthBin: 0, elevationBin: 0, count: 0 }]))).toEqual([]);
    const out = buildGazeInstances(
      data([
        { azimuthBin: 0, elevationBin: 0, count: -3 },
        { azimuthBin: 1, elevationBin: 0, count: 7 },
      ]),
    );
    expect(out).toHaveLength(1);
  });

  it("keeps only the busiest maxBins", () => {
    const out = buildGazeInstances(
      data([
        { azimuthBin: 0, elevationBin: 0, count: 1 },
        { azimuthBin: 1, elevationBin: 0, count: 9 },
        { azimuthBin: 2, elevationBin: 0, count: 5 },
      ]),
      { maxBins: 2 },
    );
    expect(out).toHaveLength(2);
  });

  it("falls back to gridSize 1 when gridSize is not positive", () => {
    expect(() =>
      buildGazeInstances(data([{ azimuthBin: 0, elevationBin: 0, count: 1 }], 0)),
    ).not.toThrow();
  });
});

describe("GazeOverlay", () => {
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

  it("renders computed markers through the driver", () => {
    const driver = fakeDriver();
    const overlay = new GazeOverlay(driver);
    overlay.render(
      data([
        { azimuthBin: 0, elevationBin: 18, count: 2 },
        { azimuthBin: 1, elevationBin: 18, count: 1 },
      ]),
    );
    expect(driver.render).toHaveBeenCalledTimes(1);
    expect(driver.rendered).toEqual([2]);
  });

  it("runs the teardown before disposing the driver", () => {
    const driver = fakeDriver();
    const teardown = vi.fn();
    const overlay = new GazeOverlay(driver, {}, teardown);
    overlay.dispose();
    expect(teardown).toHaveBeenCalledTimes(1);
    expect(driver.dispose).toHaveBeenCalledTimes(1);
  });

  it("delegates clear/setVisible to the driver", () => {
    const driver = fakeDriver();
    const overlay = new GazeOverlay(driver);
    overlay.clear();
    overlay.setVisible(false);
    expect(driver.clear).toHaveBeenCalledTimes(1);
    expect(driver.setVisible).toHaveBeenCalledWith(false);
  });
});
