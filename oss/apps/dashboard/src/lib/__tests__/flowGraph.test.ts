import { describe, expect, it } from "vitest";
import type { FlowLink } from "@uptimizr/react";
import {
  buildTwoStageGraph,
  OTHER_MESH,
  OTHER_STANDPOINT,
  voxelKey,
  type FlowStandpoint,
  type TwoStageCaps,
} from "../flowGraph";

const CAPS: TwoStageCaps = { maxStandpoints: 6, maxMeshes: 10, maxRibbons: 70 };

function link(partial: Partial<FlowLink> & Pick<FlowLink, "mesh" | "count">): FlowLink {
  return {
    azimuth_bin: 0,
    elevation_bin: 0,
    ...partial,
  } as FlowLink;
}

function standpoint(voxel: [number, number, number], count: number, origin?: [number, number, number]): FlowStandpoint {
  return { key: voxelKey(voxel), voxel, count, origin };
}

describe("buildTwoStageGraph", () => {
  it("returns an empty graph when no rows carry a standpoint", () => {
    const graph = buildTwoStageGraph([link({ mesh: "Door", count: 5 })], [], 8, CAPS);
    expect(graph.ribbons).toHaveLength(0);
    expect(graph.standpoints).toHaveLength(0);
    expect(graph.meshes).toHaveLength(0);
    expect(graph.maxCount).toBe(1);
  });

  it("threads kept ribbons through three columns with the expected node kinds/positions", () => {
    const links: FlowLink[] = [
      link({ mesh: "Door", count: 9, originVoxel: [0, 0, 0], azimuth_bin: 1, elevation_bin: 2 }),
      link({ mesh: "Lamp", count: 4, originVoxel: [3, 0, 1], azimuth_bin: 5, elevation_bin: 3 }),
    ];
    const sps = [standpoint([0, 0, 0], 9), standpoint([3, 0, 1], 4)];
    const graph = buildTwoStageGraph(links, sps, 8, CAPS);

    expect(graph.ribbons).toHaveLength(2);
    expect(graph.maxCount).toBe(9);
    // Left rail (standpoints) negative X, right rail (meshes) positive X, gaze fan at X=0.
    expect(graph.standpoints.every((n) => n.pos[0] < 0 && n.kind === "standpoint")).toBe(true);
    expect(graph.meshes.every((n) => n.pos[0] > 0 && n.kind === "mesh")).toBe(true);
    expect(graph.gazes.every((n) => n.pos[0] === 0 && n.kind === "gaze")).toBe(true);
    // Each ribbon references real nodes.
    const ids = new Set([...graph.standpoints, ...graph.gazes, ...graph.meshes].map((n) => n.id));
    for (const r of graph.ribbons) {
      expect(ids.has(r.standpointId)).toBe(true);
      expect(ids.has(r.gazeId)).toBe(true);
      expect(ids.has(r.meshId)).toBe(true);
    }
  });

  it("folds standpoints beyond the cap into a single Other standpoint node", () => {
    const links: FlowLink[] = [];
    const sps: FlowStandpoint[] = [];
    for (let i = 0; i < 8; i++) {
      const voxel: [number, number, number] = [i, 0, 0];
      links.push(link({ mesh: "Door", count: 10 - i, originVoxel: voxel }));
      sps.push(standpoint(voxel, 10 - i));
    }
    const graph = buildTwoStageGraph(links, sps, 8, { ...CAPS, maxStandpoints: 3 });
    const otherSp = graph.standpoints.find((n) => n.id === OTHER_STANDPOINT);
    expect(otherSp).toBeDefined();
    expect(otherSp?.isOther).toBe(true);
    // 3 kept + 1 other.
    expect(graph.standpoints).toHaveLength(4);
    // Other aggregates the 5 tail standpoints' counts (7+6+5+4+3 = 25).
    expect(otherSp?.count).toBe(25);
  });

  it("folds meshes beyond the cap into a single Other mesh node", () => {
    const links: FlowLink[] = [];
    for (let i = 0; i < 6; i++) {
      links.push(link({ mesh: `Mesh${i}`, count: 6 - i, originVoxel: [0, 0, 0], azimuth_bin: i }));
    }
    const graph = buildTwoStageGraph(links, [standpoint([0, 0, 0], 21)], 8, { ...CAPS, maxMeshes: 2 });
    const otherMesh = graph.meshes.find((n) => n.id === OTHER_MESH);
    expect(otherMesh).toBeDefined();
    expect(otherMesh?.isOther).toBe(true);
    // Other mesh is laid out last (lowest on the rail order is fine; just ensure it exists once).
    expect(graph.meshes.filter((n) => n.id === OTHER_MESH)).toHaveLength(1);
  });

  it("caps drawn ribbons and re-routes the tail to the standpoint's Other mesh", () => {
    const links: FlowLink[] = [];
    // 5 distinct (gaze,mesh) ribbons from one standpoint.
    for (let i = 0; i < 5; i++) {
      links.push(link({ mesh: `Mesh${i}`, count: 5 - i, originVoxel: [0, 0, 0], azimuth_bin: i }));
    }
    const graph = buildTwoStageGraph(links, [standpoint([0, 0, 0], 15)], 8, {
      maxStandpoints: 6,
      maxMeshes: 10,
      maxRibbons: 3,
    });
    // No ribbon count is lost: total preserved (5+4+3+2+1 = 15).
    const total = graph.ribbons.reduce((m, r) => m + r.count, 0);
    expect(total).toBe(15);
    // The tail (Mesh3=2, Mesh4=1) collapses into Other-mesh ribbons.
    const otherRibbon = graph.ribbons.filter((r) => r.meshId === OTHER_MESH);
    expect(otherRibbon.reduce((m, r) => m + r.count, 0)).toBe(3);
  });
});
