/**
 * Client-side spatial labels for the 3D panels (ADR 0051 §2, sketch §B.2).
 *
 * The 3D panels read `full` rows, so they resolve hover labels locally from the
 * proxy and regions they already fetched. The rules must match the collector's
 * `labelClusters` exactly — a tooltip that disagreed with a summary of the same
 * data would be worse than no tooltip — so the same cases are pinned here:
 * containment beats proximity, the smallest containing box wins, and a match
 * beyond `cellSize × 2` is refused.
 */

import { describe, expect, it } from "vitest";
import type { SceneProxyMesh, SceneRegionInfo } from "../api";
import { labelWorldPoint, voxelHoverLabels } from "../catalog/lib/spatialLabels";

const MESHES: SceneProxyMesh[] = [
  { name: "floor", aabb: [0, -0.1, 0, 10, 0, 10] },
  { name: "counter_top", aabb: [1, 0.9, 1, 3, 1, 3] },
  { name: "checkout_button", aabb: [1.9, 1, 1.9, 2.4, 1.4, 2.4] },
];

const REGIONS: SceneRegionInfo[] = [
  {
    sceneId: "lobby",
    regionId: "shop-floor",
    label: "Shop floor",
    description: null,
    bounds: [0, 0, 0, 10, 10, 10],
  },
  {
    sceneId: "lobby",
    regionId: "counter",
    label: "Checkout counter",
    description: null,
    bounds: [1, 0, 1, 3, 2, 3],
  },
];

describe("labelWorldPoint", () => {
  it("names the containing mesh and the smallest containing region", () => {
    expect(labelWorldPoint(2.25, 1.25, 2.25, REGIONS, MESHES, 1)).toEqual({
      nearestMesh: "checkout_button",
      region: "Checkout counter",
    });
  });

  it("prefers the smallest containing mesh", () => {
    expect(labelWorldPoint(2, 0.95, 2, REGIONS, MESHES, 1).nearestMesh).toBe("counter_top");
  });

  it("falls back to the nearest box centre inside the threshold", () => {
    expect(labelWorldPoint(2.15, 2.2, 2.15, REGIONS, MESHES, 2).nearestMesh).toBe(
      "checkout_button",
    );
  });

  it("refuses a match beyond the threshold", () => {
    expect(labelWorldPoint(2.15, 2.2, 2.15, REGIONS, MESHES, 0.2).nearestMesh).toBeNull();
  });

  it("reports nulls outside every box", () => {
    expect(labelWorldPoint(50, 50, 50, REGIONS, MESHES, 1)).toEqual({
      nearestMesh: null,
      region: null,
    });
  });

  it("does not depend on the order of the boxes", () => {
    expect(
      labelWorldPoint(2.25, 1.25, 2.25, [...REGIONS].reverse(), [...MESHES].reverse(), 2),
    ).toEqual(labelWorldPoint(2.25, 1.25, 2.25, REGIONS, MESHES, 2));
  });
});

describe("voxelHoverLabels", () => {
  const voxels = [
    { vx: 4, vy: 2, vz: 4 },
    { vx: 40, vy: 40, vz: 40 },
  ];

  it("labels each voxel by its cell centre", () => {
    const labels = voxelHoverLabels(voxels, 0.5, REGIONS, MESHES);
    expect(labels?.[0]).toBe("near checkout_button · in Checkout counter");
    // Far outside everything: nothing to say, so no tooltip.
    expect(labels?.[1]).toBeNull();
  });

  it("keeps a panel's own per-voxel text and appends the place", () => {
    const labels = voxelHoverLabels(voxels, 0.5, REGIONS, MESHES, ["30 fps avg", "120 fps avg"]);
    expect(labels?.[0]).toBe("30 fps avg · near checkout_button · in Checkout counter");
    expect(labels?.[1]).toBe("120 fps avg");
  });

  it("stays undefined when the scene registered nothing, so markers stay non-pickable", () => {
    expect(voxelHoverLabels(voxels, 0.5, [], [])).toBeUndefined();
  });

  it("passes a panel's own labels straight through when the scene registered nothing", () => {
    expect(voxelHoverLabels(voxels, 0.5, [], [], ["a", "b"])).toEqual(["a", "b"]);
  });
});
