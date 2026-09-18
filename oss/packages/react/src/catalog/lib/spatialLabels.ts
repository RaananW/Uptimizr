// Client-side spatial labels for the 3D panels (ADR 0051 §2, sketch §B.2).
//
// The collector labels `format=summary` clusters server-side, but the 3D panels
// read `full` rows — one voxel per marker — so they would have to ask for a
// second, differently-shaped response just to hover a name. They don't need to:
// both inputs are already on the client. The proxy AABBs are fetched for the
// wireframe backdrop, and a scene's regions are one small metadata read, so the
// same join runs here over the voxels the panel is already drawing.
//
// The rules match `@uptimizr/db`'s `labels.ts` exactly, so a tooltip never
// contradicts a summary of the same data:
//
//   * `region`      — the smallest containing region box, by volume
//   * `nearestMesh` — a mesh box containing the voxel centre (smallest wins),
//                     else the nearest box centre within `cellSize × 2`
//
// Cost is O(voxels × boxes) with a per-axis early exit, and the whole pass is
// memoised by the caller per data change, so a busy heatmap stays cheap.

import type { Aabb, SceneProxyMesh, SceneRegionInfo } from "../../api";

/** A voxel's integer grid indices, as every world-space heatmap row carries them. */
export interface VoxelIndex {
  vx: number;
  vy: number;
  vz: number;
}

/** What a voxel resolved to; both fields are `null` when nothing names it. */
export interface VoxelLabel {
  /** Human label of the smallest containing region (falls back to its id). */
  region: string | null;
  /** Name of the mesh the voxel sits on or nearest to, within the threshold. */
  nearestMesh: string | null;
}

/** Volume of a box, used to pick the smallest of several containing ones. */
function volumeOf(box: Aabb): number {
  return Math.max(0, box[3] - box[0]) * Math.max(0, box[4] - box[1]) * Math.max(0, box[5] - box[2]);
}

/** Whether `box`, grown by `slack` on every axis, contains the point. */
function withinSlack(box: Aabb, x: number, y: number, z: number, slack: number): boolean {
  return (
    x >= box[0] - slack &&
    x <= box[3] + slack &&
    y >= box[1] - slack &&
    y <= box[4] + slack &&
    z >= box[2] - slack &&
    z <= box[5] + slack
  );
}

/** Whether `box` contains the point, inclusive on every face. */
function contains(box: Aabb, x: number, y: number, z: number): boolean {
  return withinSlack(box, x, y, z, 0);
}

/** Squared distance from the point to the centre of `box`. */
function centreDistanceSq(box: Aabb, x: number, y: number, z: number): number {
  const dx = x - (box[0] + box[3]) / 2;
  const dy = y - (box[1] + box[4]) / 2;
  const dz = z - (box[2] + box[5]) / 2;
  return dx * dx + dy * dy + dz * dz;
}

/**
 * Resolve one world point against a scene's regions and proxy meshes. Ties are
 * broken by label/name ascending so the answer never depends on array order.
 */
export function labelWorldPoint(
  x: number,
  y: number,
  z: number,
  regions: readonly SceneRegionInfo[],
  meshes: readonly SceneProxyMesh[],
  meshThreshold: number,
): VoxelLabel {
  let region: string | null = null;
  let regionVolume = Number.POSITIVE_INFINITY;
  for (const candidate of regions) {
    if (!contains(candidate.bounds, x, y, z)) continue;
    const volume = volumeOf(candidate.bounds);
    const name = candidate.label || candidate.regionId;
    if (volume < regionVolume || (volume === regionVolume && name < (region ?? ""))) {
      regionVolume = volume;
      region = name;
    }
  }

  let contained: string | null = null;
  let containedVolume = Number.POSITIVE_INFINITY;
  let nearest: string | null = null;
  let nearestSq = Number.POSITIVE_INFINITY;
  const thresholdSq = meshThreshold * meshThreshold;
  for (const mesh of meshes) {
    if (!withinSlack(mesh.aabb, x, y, z, meshThreshold)) continue;
    if (contains(mesh.aabb, x, y, z)) {
      const volume = volumeOf(mesh.aabb);
      if (
        volume < containedVolume ||
        (volume === containedVolume && mesh.name < (contained ?? ""))
      ) {
        containedVolume = volume;
        contained = mesh.name;
      }
      continue;
    }
    if (contained != null) continue;
    const distanceSq = centreDistanceSq(mesh.aabb, x, y, z);
    if (distanceSq > thresholdSq) continue;
    if (distanceSq < nearestSq || (distanceSq === nearestSq && mesh.name < (nearest ?? ""))) {
      nearestSq = distanceSq;
      nearest = mesh.name;
    }
  }

  return { region, nearestMesh: contained ?? nearest };
}

/**
 * Hover labels for a voxel list, indexed to match it — the shape
 * `WorldHeatmap3DView`'s `voxelLabels` prop takes.
 *
 * Returns `undefined` when the scene registers neither regions nor proxy meshes:
 * the panel then keeps its markers non-pickable, exactly as before, rather than
 * offering an empty tooltip. `extra` lets a panel prepend its own per-voxel text
 * (the FPS heatmap's honest per-cell numbers) so a place label augments it
 * instead of replacing it.
 */
export function voxelHoverLabels(
  voxels: readonly VoxelIndex[] | undefined,
  cellSize: number,
  regions: readonly SceneRegionInfo[] | undefined,
  meshes: readonly SceneProxyMesh[] | undefined,
  extra?: readonly (string | null)[],
): (string | null)[] | undefined {
  // Tolerant of absent inputs: a panel calls this while its `load` is still in
  // flight (and hosts may hand a partial `data`), and a heatmap without labels
  // must render exactly as it did before rather than throw.
  const regionList = regions ?? [];
  const meshList = meshes ?? [];
  if (voxels == null) return extra ? [...extra] : undefined;
  if (regionList.length === 0 && meshList.length === 0) return extra ? [...extra] : undefined;
  const threshold = cellSize * 2;
  return voxels.map((voxel, index) => {
    const { region, nearestMesh } = labelWorldPoint(
      (voxel.vx + 0.5) * cellSize,
      (voxel.vy + 0.5) * cellSize,
      (voxel.vz + 0.5) * cellSize,
      regionList,
      meshList,
      threshold,
    );
    const parts: string[] = [];
    const own = extra?.[index];
    if (own) parts.push(own);
    if (nearestMesh) parts.push(`near ${nearestMesh}`);
    if (region) parts.push(`in ${region}`);
    return parts.length > 0 ? parts.join(" · ") : null;
  });
}
