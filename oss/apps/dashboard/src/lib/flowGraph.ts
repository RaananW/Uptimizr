import type { FlowLink } from "@/lib/api";

/** A standpoint rolled up from position-aware flow rows (§7.8 slice 2). */
export interface FlowStandpoint {
  key: string;
  voxel: [number, number, number];
  count: number;
  origin?: [number, number, number];
}

export type TwoStageKind = "standpoint" | "gaze" | "mesh";

export interface TwoStageNode {
  id: string;
  kind: TwoStageKind;
  pos: [number, number, number];
  count: number;
  label: string;
  isOther: boolean;
}

export interface TwoStageRibbon {
  standpointId: string;
  gazeId: string;
  meshId: string;
  azimuthBin: number;
  elevationBin: number;
  count: number;
}

export interface TwoStageGraph {
  standpoints: TwoStageNode[];
  gazes: TwoStageNode[];
  meshes: TwoStageNode[];
  ribbons: TwoStageRibbon[];
  maxCount: number;
}

export interface TwoStageCaps {
  /** Top-P standpoints kept on the left rail; the rest fold into one "other" node. */
  maxStandpoints: number;
  /** Top-M meshes kept on the right rail; the rest fold into one "other" node. */
  maxMeshes: number;
  /** Top-N ribbons drawn; the tail re-routes to the standpoint's "other" mesh node. */
  maxRibbons: number;
}

export const OTHER_STANDPOINT = "__other_sp__";
export const OTHER_MESH = "__other_mesh__";

const RAIL_X = 2.6;
const RAIL_Y = 1.4;
const FAN_Y = 0.85;
const FAN_Z = 1.6;

export function voxelKey(v: readonly [number, number, number]): string {
  return `${v[0]}|${v[1]}|${v[2]}`;
}

function railY(index: number, total: number): number {
  if (total <= 1) return 0;
  return RAIL_Y - (index / (total - 1)) * (RAIL_Y * 2);
}

/**
 * Build the three-column standpoint → gaze-sector → mesh flow graph (§7.8 slice 3).
 *
 * Pure layout/aggregation so it can be unit-tested without Babylon: caps the
 * standpoints (top-P), meshes (top-M) and ribbons (top-N), folding every tail into
 * an `other` node, and threads each kept ribbon through three rail/fan positions.
 */
export function buildTwoStageGraph(
  links: FlowLink[],
  standpoints: FlowStandpoint[],
  gridSize: number,
  caps: TwoStageCaps,
): TwoStageGraph {
  const positioned = links.filter((l) => l.originVoxel);
  if (positioned.length === 0) {
    return { standpoints: [], gazes: [], meshes: [], ribbons: [], maxCount: 1 };
  }

  // Standpoint buckets: keep the top-P voxels, fold the rest into `other`.
  const topStandpoints = standpoints.slice(0, Math.max(1, caps.maxStandpoints));
  const keptStandpointKeys = new Set(topStandpoints.map((s) => s.key));
  const standpointBucket = (l: FlowLink): string => {
    const k = l.originVoxel ? voxelKey(l.originVoxel) : OTHER_STANDPOINT;
    return keptStandpointKeys.has(k) ? k : OTHER_STANDPOINT;
  };

  // Mesh buckets: rank meshes globally, keep top-M, fold the rest into `other`.
  const meshTotals = new Map<string, number>();
  for (const l of positioned) meshTotals.set(l.mesh, (meshTotals.get(l.mesh) ?? 0) + l.count);
  const keptMeshNames = new Set(
    [...meshTotals.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, Math.max(1, caps.maxMeshes))
      .map(([name]) => name),
  );
  const meshBucket = (mesh: string): string => (keptMeshNames.has(mesh) ? mesh : OTHER_MESH);

  // Aggregate ribbons by (standpoint, gaze sector, mesh).
  const ribbonMap = new Map<string, TwoStageRibbon>();
  for (const l of positioned) {
    const sp = standpointBucket(l);
    const ms = meshBucket(l.mesh);
    const id = `${sp}|${l.azimuth_bin}|${l.elevation_bin}|${ms}`;
    const cur = ribbonMap.get(id);
    if (cur) cur.count += l.count;
    else {
      ribbonMap.set(id, {
        standpointId: sp,
        gazeId: `${sp}|${l.azimuth_bin}|${l.elevation_bin}`,
        meshId: ms,
        azimuthBin: l.azimuth_bin,
        elevationBin: l.elevation_bin,
        count: l.count,
      });
    }
  }

  // Top-N ribbons; the tail re-routes to the standpoint's `other` mesh node.
  const sorted = [...ribbonMap.values()].sort((a, b) => b.count - a.count);
  const kept = sorted.slice(0, Math.max(1, caps.maxRibbons));
  const tail = sorted.slice(Math.max(1, caps.maxRibbons));
  if (tail.length > 0) {
    const keptById = new Map(
      kept.map((r) => [`${r.standpointId}|${r.azimuthBin}|${r.elevationBin}|${OTHER_MESH}`, r]),
    );
    for (const r of tail) {
      const id = `${r.standpointId}|${r.azimuthBin}|${r.elevationBin}|${OTHER_MESH}`;
      const cur = keptById.get(id);
      if (cur) cur.count += r.count;
      else {
        const merged: TwoStageRibbon = {
          standpointId: r.standpointId,
          gazeId: r.gazeId,
          meshId: OTHER_MESH,
          azimuthBin: r.azimuthBin,
          elevationBin: r.elevationBin,
          count: r.count,
        };
        keptById.set(id, merged);
        kept.push(merged);
      }
    }
  }

  // Nodes referenced by the kept ribbons.
  const usedStandpoints = new Set(kept.map((r) => r.standpointId));
  const usedMeshes = new Set(kept.map((r) => r.meshId));

  const standpointOrder = [
    ...topStandpoints.filter((s) => usedStandpoints.has(s.key)).map((s) => s.key),
    ...(usedStandpoints.has(OTHER_STANDPOINT) ? [OTHER_STANDPOINT] : []),
  ];
  const standpointNodes: TwoStageNode[] = standpointOrder.map((key, i) => {
    const sp = topStandpoints.find((s) => s.key === key);
    const count = kept.filter((r) => r.standpointId === key).reduce((m, r) => m + r.count, 0);
    return {
      id: key,
      kind: "standpoint",
      pos: [-RAIL_X, railY(i, standpointOrder.length), 0],
      count,
      label: sp ? `[${sp.voxel[0]}, ${sp.voxel[1]}, ${sp.voxel[2]}]` : "Other standpoints",
      isOther: key === OTHER_STANDPOINT,
    };
  });
  const standpointY = new Map(standpointNodes.map((n) => [n.id, n.pos[1]]));

  const meshTotalsKept = new Map<string, number>();
  for (const r of kept) meshTotalsKept.set(r.meshId, (meshTotalsKept.get(r.meshId) ?? 0) + r.count);
  const meshOrder = [...usedMeshes].sort(
    (a, b) => (meshTotalsKept.get(b) ?? 0) - (meshTotalsKept.get(a) ?? 0),
  );
  // Keep `other` mesh last for a stable read.
  meshOrder.sort((a, b) => (a === OTHER_MESH ? 1 : 0) - (b === OTHER_MESH ? 1 : 0));
  const meshNodes: TwoStageNode[] = meshOrder.map((id, i) => ({
    id,
    kind: "mesh",
    pos: [RAIL_X, railY(i, meshOrder.length), 0],
    count: meshTotalsKept.get(id) ?? 0,
    label: id === OTHER_MESH ? "Other meshes" : id,
    isOther: id === OTHER_MESH,
  }));

  // Gaze fan nodes: per standpoint, placed near the standpoint's rail row.
  const gazeTotals = new Map<string, { az: number; el: number; sp: string; count: number }>();
  for (const r of kept) {
    const cur = gazeTotals.get(r.gazeId);
    if (cur) cur.count += r.count;
    else
      gazeTotals.set(r.gazeId, {
        az: r.azimuthBin,
        el: r.elevationBin,
        sp: r.standpointId,
        count: r.count,
      });
  }
  const gazeNodes: TwoStageNode[] = [...gazeTotals.entries()].map(([id, g]) => {
    const spY = standpointY.get(g.sp) ?? 0;
    const azNorm = (g.az + 0.5) / gridSize - 0.5;
    const elNorm = (g.el + 0.5) / gridSize - 0.5;
    return {
      id,
      kind: "gaze" as const,
      pos: [0, spY + elNorm * FAN_Y, azNorm * FAN_Z] as [number, number, number],
      count: g.count,
      label: `(${g.az}, ${g.el})`,
      isOther: false,
    };
  });

  const maxCount = kept.reduce((m, r) => Math.max(m, r.count), 1);
  return {
    standpoints: standpointNodes,
    gazes: gazeNodes,
    meshes: meshNodes,
    ribbons: kept,
    maxCount,
  };
}
