import { describe, expect, it } from "vitest";
import { summarizeReachability } from "../index";
import type { ReachabilityBin } from "../index";

/**
 * Reachability roll-up (#151): the per-(mesh, band) histogram folds into a
 * per-mesh count-weighted mean distance, farthest-mean first, with a
 * comfortable-reach flag.
 */
describe("summarizeReachability", () => {
  it("count-weights the mean distance across a mesh's bands", () => {
    const bins: ReachabilityBin[] = [
      // "panel": 3 interactions at ~0.25 m and 1 at ~3.5 m → mean = (0.75 + 3.5) / 4.
      { mesh: "panel", bucket: 0, count: 3, avg_distance: 0.25 },
      { mesh: "panel", bucket: 7, count: 1, avg_distance: 3.5 },
    ];
    const [row] = summarizeReachability(bins, 0.5, 2);
    expect(row.mesh).toBe("panel");
    expect(row.count).toBe(4);
    expect(row.meanDistance).toBeCloseTo((0.75 + 3.5) / 4, 5);
    expect(row.maxBandDistance).toBeCloseTo(3.5, 5); // bucket 7 * 0.5
  });

  it("flags meshes whose mean clears the threshold and sorts farthest first", () => {
    const bins: ReachabilityBin[] = [
      { mesh: "near", bucket: 0, count: 5, avg_distance: 0.3 },
      { mesh: "far", bucket: 6, count: 2, avg_distance: 3.1 },
    ];
    const rows = summarizeReachability(bins, 0.5, 2);
    expect(rows.map((r) => r.mesh)).toEqual(["far", "near"]);
    expect(rows[0]?.far).toBe(true);
    expect(rows[1]?.far).toBe(false);
  });

  it("returns an empty list when there are no bins", () => {
    expect(summarizeReachability([], 0.5)).toEqual([]);
  });
});
