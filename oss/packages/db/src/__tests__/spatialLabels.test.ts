/**
 * Spatial labelling of summary clusters (ADR 0051 §2, design sketch §B.2).
 *
 * The contract under test is narrow and entirely deterministic: given a scene's
 * regions and its proxy mesh boxes, a hotspot's world centroid resolves to the
 * smallest region containing it, every region containing it, the mesh it sits on
 * (or the nearest one close enough to mean something), and the distance to it.
 *
 * Four things are pinned down here:
 *
 * 1. **The rules themselves** — containment beats proximity, the smallest box
 *    wins where several contain, a match beyond `cellSize × 2` is refused rather
 *    than guessed, and a scene with neither regions nor a proxy yields nulls plus
 *    a caveat that says which is missing.
 * 2. **Determinism** — the labels are a function of the *sets*, so the fixture is
 *    re-run against shuffled regions and shuffled meshes.
 * 3. **End to end through `summarizeRows`** — the labels reach the envelope, the
 *    `reading` names the place, and `drill.region` upgrades from an ad-hoc box to
 *    the region id.
 * 4. **Cost** — the largest shape the collector can hand it (a full
 *    `maxSummaryRows` cluster list against a proxy-sized box set) labels in well
 *    under 50 ms.
 */

import { describe, expect, it } from "vitest";
import { LIMITS } from "@uptimizr/schema";
import {
  labelClusters,
  labelPoint,
  summarizeRows,
  worldAxisMap,
  type ClusterSummary,
  type ResultRow,
  type SpatialCluster,
  type SpatialScene,
} from "../query/summary/index.js";

/** World axes of a 3D voxel grid (`vx`,`vy`,`vz`). */
const XYZ = [0, 1, 2] as const;

/**
 * A fixture scene: a shop floor with an overlapping counter area inside it, a
 * big floor mesh, a small button prop sitting on the counter, and a shelf a
 * couple of metres away with nothing else near it.
 */
const SCENE: SpatialScene = {
  id: "lobby",
  regions: [
    // The whole room (volume 1000) …
    { id: "shop-floor", bounds: [0, 0, 0, 10, 10, 10] },
    // … and the counter inside it (volume 8) — the smaller must win.
    { id: "counter", bounds: [1, 0, 1, 3, 2, 3] },
  ],
  meshes: [
    { name: "floor", aabb: [0, -0.1, 0, 10, 0, 10] },
    { name: "counter_top", aabb: [1, 0.9, 1, 3, 1, 3] },
    { name: "checkout_button", aabb: [1.9, 1, 1.9, 2.1, 1.1, 2.1] },
    { name: "shelf", aabb: [8, 0, 8, 9, 2, 9] },
  ],
};

describe("worldAxisMap", () => {
  it("maps the world-space grids and refuses the others", () => {
    expect(worldAxisMap(["vx", "vy", "vz"])).toEqual([0, 1, 2]);
    // A ground-plane grid indexes X and Z only; labelling then tests the plane.
    expect(worldAxisMap(["gx", "gz"])).toEqual([0, 2]);
    // Viewport bins and view-direction angles are not world coordinates.
    expect(worldAxisMap(["gx", "gy"])).toBeNull();
    expect(worldAxisMap(["azimuth_bin", "elevation_bin"])).toBeNull();
    expect(worldAxisMap([])).toBeNull();
  });
});

describe("labelPoint", () => {
  it("names the mesh whose box contains the point, at distance 0", () => {
    const label = labelPoint([2, 1.05, 2], SCENE, XYZ, 1);
    expect(label.nearestMesh).toBe("checkout_button");
    expect(label.distance).toBe(0);
  });

  it("prefers the smallest containing mesh over the room-sized one", () => {
    // Inside `counter_top` (volume 0.4) and nothing else; the button's box does
    // not reach down here, so the counter is the honest answer.
    const label = labelPoint([2, 0.95, 2], SCENE, XYZ, 1);
    expect(label.nearestMesh).toBe("counter_top");
    expect(label.distance).toBe(0);
  });

  it("falls back to the nearest box centre inside the threshold", () => {
    // 1 world unit above the button's centre, nothing containing it.
    const label = labelPoint([2, 2.05, 2], SCENE, XYZ, 2);
    expect(label.nearestMesh).toBe("checkout_button");
    expect(label.distance).toBeCloseTo(1, 5);
  });

  it("refuses a match beyond the threshold rather than guessing", () => {
    // The same point with a threshold of half a unit: nothing is near enough.
    const label = labelPoint([2, 2.05, 2], SCENE, XYZ, 0.5);
    expect(label.nearestMesh).toBeNull();
    expect(label.distance).toBeNull();
  });

  it("reports every containing region and picks the smallest by volume", () => {
    const label = labelPoint([2, 1.05, 2], SCENE, XYZ, 1);
    expect(label.regions).toEqual(["counter", "shop-floor"]);
    expect(label.region).toBe("counter");
  });

  it("reports no region when the point is outside every box", () => {
    const label = labelPoint([50, 50, 50], SCENE, XYZ, 1);
    expect(label.region).toBeNull();
    expect(label.regions).toEqual([]);
    expect(label.nearestMesh).toBeNull();
  });

  it("returns nulls when the scene registers neither regions nor a proxy", () => {
    expect(labelPoint([2, 1, 2], { id: "bare" }, XYZ, 1)).toEqual({
      region: null,
      regions: [],
      nearestMesh: null,
      distance: null,
    });
  });

  it("is a function of the sets, not of their order", () => {
    const shuffled: SpatialScene = {
      id: SCENE.id,
      regions: [...(SCENE.regions ?? [])].reverse(),
      meshes: [...(SCENE.meshes ?? [])].reverse(),
    };
    for (const point of [
      [2, 1.05, 2],
      [2, 2.05, 2],
      [8.5, 1, 8.5],
      [5, 5, 5],
    ]) {
      expect(labelPoint(point, shuffled, XYZ, 2)).toEqual(labelPoint(point, SCENE, XYZ, 2));
    }
  });

  it("tests the ground plane only for a 2-axis (gx/gz) grid", () => {
    // Height is not part of a ground-binned metric, so a point over the counter
    // is labelled by its X/Z alone — `counter` regardless of Y.
    const label = labelPoint([2, 2], SCENE, [0, 2], 1);
    expect(label.region).toBe("counter");
  });
});

describe("labelClusters", () => {
  /** One hotspot centred on the checkout button's cell, at `cellSize` 0.5. */
  const cluster: SpatialCluster = {
    centroid: [3.5, 1.5, 3.5],
    extent: { min: [3, 1, 3], max: [4, 2, 4] },
    cells: 2,
    weight: 20,
    share: 1,
    drill: { region: "1.5,0.5,1.5,2.5,1.5,2.5" },
  };

  it("labels a hotspot and upgrades the drill hint to the region id", () => {
    const result = labelClusters([cluster], {
      axes: ["vx", "vy", "vz"],
      cellSize: 0.5,
      scene: SCENE,
    });
    expect(result.labelled).toBe(true);
    expect(result.caveats).toEqual([]);
    const [labelled] = result.clusters;
    expect(labelled?.region).toBe("counter");
    expect(labelled?.regions).toEqual(["counter", "shop-floor"]);
    expect(labelled?.nearestMesh).toBe("checkout_button");
    expect(labelled?.distance).toBe(0);
    // The region id is a better `?region=` value than the ad-hoc box.
    expect(labelled?.drill).toEqual({ region: "counter" });
  });

  it("caveats a missing proxy and missing regions, separately", () => {
    const noProxy = labelClusters([cluster], {
      axes: ["vx", "vy", "vz"],
      cellSize: 0.5,
      scene: { id: "lobby", regions: SCENE.regions },
    });
    expect(noProxy.caveats).toHaveLength(1);
    expect(noProxy.caveats[0]).toContain("No proxy registered for scene `lobby`");
    expect(noProxy.clusters[0]?.nearestMesh).toBeNull();
    expect(noProxy.clusters[0]?.region).toBe("counter");

    const noRegions = labelClusters([cluster], {
      axes: ["vx", "vy", "vz"],
      cellSize: 0.5,
      scene: { id: "lobby", meshes: SCENE.meshes },
    });
    expect(noRegions.caveats).toHaveLength(1);
    expect(noRegions.caveats[0]).toContain("No regions defined for scene `lobby`");
    expect(noRegions.clusters[0]?.region).toBeNull();
    // With no region to name, the original box drill hint survives untouched.
    expect(noRegions.clusters[0]?.drill).toEqual({ region: "1.5,0.5,1.5,2.5,1.5,2.5" });
  });

  it("leaves a non-world grid alone", () => {
    const result = labelClusters([cluster], {
      axes: ["gx", "gy"],
      cellSize: 0.5,
      scene: SCENE,
    });
    expect(result.labelled).toBe(false);
    expect(result.clusters[0]).toEqual(cluster);
  });

  it("leaves clusters alone when no cell size is known", () => {
    const result = labelClusters([cluster], {
      axes: ["vx", "vy", "vz"],
      cellSize: 0,
      scene: SCENE,
    });
    expect(result.labelled).toBe(false);
    expect(result.clusters[0]).toEqual(cluster);
  });

  /**
   * The worst shape the collector can hand this: a full `maxSummaryRows` cluster
   * list against a proxy the size of a real scene. `O(clusters × boxes)` with the
   * per-axis early exit has to stay comfortably inside the 50 ms budget the issue
   * sets — the threshold is deliberately generous so the assertion catches an
   * algorithmic regression, not CI jitter.
   */
  it("labels the largest plausible heatmap in under 50 ms", () => {
    const meshes = Array.from({ length: LIMITS.maxSceneProxyMeshes }, (_, i) => ({
      name: `mesh_${i}`,
      aabb: [
        i % 100,
        Math.floor(i / 100) % 100,
        i % 50,
        (i % 100) + 1,
        (Math.floor(i / 100) % 100) + 1,
        (i % 50) + 1,
      ] as number[],
    }));
    const regions = Array.from({ length: LIMITS.maxSceneRegions }, (_, i) => ({
      id: `region_${i}`,
      bounds: [i % 50, 0, i % 50, (i % 50) + 5, 10, (i % 50) + 5] as number[],
    }));
    const clusters: SpatialCluster[] = Array.from({ length: 200 }, (_, i) => ({
      centroid: [i % 100, Math.floor(i / 10) % 100, i % 50],
      extent: { min: [i % 100, 0, i % 50], max: [(i % 100) + 1, 1, (i % 50) + 1] },
      cells: 4,
      weight: 10,
      share: 0.1,
    }));

    const started = performance.now();
    const result = labelClusters(clusters, {
      axes: ["vx", "vy", "vz"],
      cellSize: 1,
      scene: { id: "big", meshes, regions },
    });
    const elapsed = performance.now() - started;
    expect(result.clusters).toHaveLength(clusters.length);
    expect(elapsed).toBeLessThan(50);
  });
});

describe("summarizeRows — labelled spatial summaries", () => {
  // Two hotspots one cell wide: one on the checkout button, one by the shelf.
  const voxels: ResultRow[] = [
    { vx: 3, vy: 2, vz: 3, count: 20 },
    { vx: 4, vy: 2, vz: 4, count: 20 },
    { vx: 16, vy: 1, vz: 16, count: 5 },
  ];

  it("carries the labels into the envelope and the reading", () => {
    const summary = summarizeRows("world_heatmap", voxels, {
      cellSize: 0.5,
      scene: SCENE,
    }) as ClusterSummary;
    const densest = summary.clusters[0];
    expect(densest?.region).toBe("counter");
    expect(densest?.nearestMesh).toBe("checkout_button");
    expect(densest?.drill).toEqual({ region: "counter" });
    expect(summary.reading).toContain("`checkout_button`");
    expect(summary.reading).toContain("in region `counter`");
    expect(summary.reading).not.toMatch(/undefined|NaN/);
    expect(summary.caveats.join(" ")).toContain("`region` / `nearestMesh` label");
  });

  it("leaves the envelope exactly as it was when no scene is supplied", () => {
    const summary = summarizeRows("world_heatmap", voxels, { cellSize: 0.5 }) as ClusterSummary;
    expect(summary.clusters[0]).not.toHaveProperty("region");
    expect(summary.clusters[0]?.drill).toEqual({ region: "1.5,1,1.5,2.5,1.5,2.5" });
    expect(summary.reading).toContain("centred at");
    expect(summary.caveats.join(" ")).toContain("Spatial labelling (nearest mesh, named region)");
  });

  it("is order-independent with labelling on", () => {
    const reference = JSON.stringify(
      summarizeRows("world_heatmap", voxels, { cellSize: 0.5, scene: SCENE }),
    );
    for (let by = 1; by < voxels.length; by++) {
      const rotated = [...voxels.slice(by), ...voxels.slice(0, by)];
      expect(
        JSON.stringify(summarizeRows("world_heatmap", rotated, { cellSize: 0.5, scene: SCENE })),
      ).toBe(reference);
    }
  });
});
