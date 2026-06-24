import { describe, expect, it } from "vitest";
import type {
  CoverageVoxel,
  InteractionSource,
  MeshSourceCount,
  MeshTrendPoint,
  SceneProxyMesh,
} from "@/lib/api";
import { buildLeaderboard } from "@/components/MeshLeaderboard";
import { buildModalitySplit } from "@/components/InputModalitySplit";
import { buildDeadZones } from "@/components/DeadZoneReport";

describe("buildLeaderboard (#74)", () => {
  const sources: MeshSourceCount[] = [
    { mesh: "box", source: "mouse", count: 6 },
    { mesh: "box", source: "touch", count: 2 },
    { mesh: "floor", source: "mouse", count: 3 },
  ];

  it("ranks meshes by total interactions and folds the per-source split", () => {
    const rows = buildLeaderboard(sources, [], 8);
    expect(rows.map((r) => r.mesh)).toEqual(["box", "floor"]);
    expect(rows[0]?.total).toBe(8);
    // Sources are ordered by count desc within a mesh.
    expect(rows[0]?.sources).toEqual([
      { source: "mouse", count: 6 },
      { source: "touch", count: 2 },
    ]);
  });

  it("derives a recent-vs-earlier delta from the ordered trend buckets", () => {
    const trend: MeshTrendPoint[] = [
      { mesh: "box", bucket: 30, count: 5 },
      { mesh: "box", bucket: 10, count: 1 },
      { mesh: "box", bucket: 20, count: 1 },
      { mesh: "box", bucket: 40, count: 5 },
    ];
    const rows = buildLeaderboard(sources, trend, 8);
    const box = rows.find((r) => r.mesh === "box");
    // Sorted by bucket -> [1,1,5,5]; earlier half [1,1]=2, recent half [5,5]=10.
    expect(box?.buckets).toEqual([1, 1, 5, 5]);
    expect(box?.delta).toBe(8);
  });

  it("caps the result to topN", () => {
    const many: MeshSourceCount[] = Array.from({ length: 5 }, (_, i) => ({
      mesh: `m${i}`,
      source: "mouse",
      count: i + 1,
    }));
    expect(buildLeaderboard(many, [], 2)).toHaveLength(2);
  });
});

describe("buildModalitySplit (#75)", () => {
  it("collapses the per-(event_type, source) breakdown into per-source shares", () => {
    const rows: InteractionSource[] = [
      { event_type: "mesh_interaction", source: "mouse", count: 3, sessions: 1 },
      { event_type: "pointer", source: "mouse", count: 1, sessions: 1 },
      { event_type: "pointer", source: "touch", count: 4, sessions: 1 },
    ];
    const split = buildModalitySplit(rows);
    expect(split.map((s) => s.source)).toEqual(["mouse", "touch"]);
    const mouse = split.find((s) => s.source === "mouse");
    expect(mouse?.count).toBe(4);
    expect(mouse?.share).toBeCloseTo(0.5, 5);
  });

  it("returns an empty split for no rows", () => {
    expect(buildModalitySplit([])).toEqual([]);
  });
});

describe("buildDeadZones (#76)", () => {
  const proxyMeshes: SceneProxyMesh[] = [
    { name: "warm", aabb: [0, 0, 0, 1, 1, 1] },
    { name: "cold", aabb: [10, 0, 0, 11, 1, 1] },
  ];

  it("ranks coldest-first and flags meshes with no nearby camera samples as dead", () => {
    const coverage: CoverageVoxel[] = [{ vx: 0, vy: 0, vz: 0, count: 7 }];
    const report = buildDeadZones(coverage, proxyMeshes, 1, 0);
    expect(report.total).toBe(2);
    expect(report.deadCount).toBe(1);
    // Coldest first: the unvisited "cold" mesh leads.
    expect(report.rows[0]?.mesh).toBe("cold");
    expect(report.rows[0]?.dead).toBe(true);
    expect(report.rows[1]?.mesh).toBe("warm");
    expect(report.rows[1]?.nearbySamples).toBe(7);
  });

  it("counts a voxel within the padded AABB as nearby", () => {
    // Voxel centre at (1.5,0.5,0.5): outside warm's [0..1] box, but within 1 cell pad.
    const coverage: CoverageVoxel[] = [{ vx: 1, vy: 0, vz: 0, count: 2 }];
    const report = buildDeadZones(coverage, [proxyMeshes[0]!], 1, 1);
    expect(report.rows[0]?.nearbySamples).toBe(2);
    expect(report.rows[0]?.dead).toBe(false);
  });
});
