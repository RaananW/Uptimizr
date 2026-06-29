import { describe, expect, it } from "vitest";
import type {
  CoverageVoxel,
  GraphicsDiagnosticCount,
  RenderingTechnologyCount,
  InteractionSource,
  MeshSourceCount,
  MeshTrendPoint,
  SceneProxyMesh,
} from "@/lib/api";
import { buildLeaderboard } from "@/components/MeshLeaderboard";
import { buildModalitySplit } from "@/components/InputModalitySplit";
import { buildDeadZones } from "@/components/DeadZoneReport";
import { foldGraphicsDiagnostics } from "@/components/GraphicsDiagnostics";
import { foldRenderingTechnology } from "@/components/RenderingTechnology";

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

describe("foldGraphicsDiagnostics (#16)", () => {
  it("folds markers and rollups into severity/category/backend breakdowns", () => {
    const rows: GraphicsDiagnosticCount[] = [
      // Two device-lost markers already summed server-side into one cell (count 2).
      { severity: "fatal", category: "device-lost", backend: "webgpu", incidents: 2 },
      // A validation rollup (count 5) on a different backend.
      { severity: "warning", category: "validation", backend: "webgl2", incidents: 5 },
      // A backend-less shader-compile error.
      { severity: "error", category: "shader-compile", backend: "", incidents: 1 },
    ];
    const out = foldGraphicsDiagnostics(rows);

    // All three breakdowns sum to the same grand total of 8 incidents.
    expect(out.total).toBe(8);
    expect(out.bySeverity.reduce((n, b) => n + b.count, 0)).toBe(8);
    expect(out.byCategory.reduce((n, b) => n + b.count, 0)).toBe(8);
    expect(out.byBackend.reduce((n, b) => n + b.count, 0)).toBe(8);

    // Severity is ordered worst-first (fatal, error, warning).
    expect(out.bySeverity.map((b) => b.key)).toEqual(["fatal", "error", "warning"]);
    // Category & backend are ranked by incident count desc.
    expect(out.byCategory[0]).toEqual({ key: "validation", label: "validation", count: 5 });
    // A blank backend surfaces as "unknown".
    expect(out.byBackend.find((b) => b.key === "unknown")?.count).toBe(1);
    expect(out.byBackend.find((b) => b.key === "webgl2")?.count).toBe(5);
  });

  it("merges rows that share a (severity, category, backend) cell", () => {
    const rows: GraphicsDiagnosticCount[] = [
      { severity: "warning", category: "validation", backend: "webgpu", incidents: 3 },
      { severity: "warning", category: "validation", backend: "webgpu", incidents: 4 },
    ];
    const out = foldGraphicsDiagnostics(rows);
    expect(out.total).toBe(7);
    expect(out.bySeverity).toEqual([{ key: "warning", label: "warning", count: 7 }]);
  });

  it("reports an empty, zero-total breakdown when capture is off (opt-in default)", () => {
    const out = foldGraphicsDiagnostics([]);
    // total === 0 is exactly the signal the panel uses to show its opt-in/off
    // empty state instead of the breakdown tiles.
    expect(out.total).toBe(0);
    expect(out.bySeverity).toEqual([]);
    expect(out.byCategory).toEqual([]);
    expect(out.byBackend).toEqual([]);
  });

  it("ignores non-positive incident counts", () => {
    const rows: GraphicsDiagnosticCount[] = [
      { severity: "info", category: "device-lost", backend: "webgpu", incidents: 0 },
    ];
    expect(foldGraphicsDiagnostics(rows).total).toBe(0);
  });
});

describe("foldRenderingTechnology (#120)", () => {
  it("folds session counts into api/backend/shading-language breakdowns", () => {
    const rows: RenderingTechnologyCount[] = [
      { api: "webgpu", backend: "metal", apiVersion: "1.0", shadingLanguage: "wgsl", sessions: 7 },
      { api: "webgl2", backend: "opengl", apiVersion: "3.0", shadingLanguage: "glsl-es", sessions: 3 },
      { api: "", backend: "", apiVersion: "", shadingLanguage: "", sessions: 2 },
    ];
    const out = foldRenderingTechnology(rows);

    expect(out.total).toBe(12);
    expect(out.byApi.reduce((n, b) => n + b.count, 0)).toBe(12);
    expect(out.byBackend.reduce((n, b) => n + b.count, 0)).toBe(12);
    expect(out.byShadingLanguage.reduce((n, b) => n + b.count, 0)).toBe(12);
    // Ranked by sessions desc; blanks surface as "unknown".
    expect(out.byApi[0]).toEqual({ key: "webgpu", label: "webgpu", count: 7 });
    expect(out.byApi.find((b) => b.key === "unknown")?.count).toBe(2);
  });

  it("merges rows that share a backend across api versions", () => {
    const rows: RenderingTechnologyCount[] = [
      { api: "webgpu", backend: "metal", apiVersion: "1.0", shadingLanguage: "wgsl", sessions: 3 },
      { api: "webgpu", backend: "metal", apiVersion: "1.1", shadingLanguage: "wgsl", sessions: 4 },
    ];
    const out = foldRenderingTechnology(rows);
    expect(out.byBackend).toEqual([{ key: "metal", label: "metal", count: 7 }]);
  });

  it("reports an empty, zero-total breakdown before any sessions land", () => {
    const out = foldRenderingTechnology([]);
    expect(out.total).toBe(0);
    expect(out.byApi).toEqual([]);
  });
});
