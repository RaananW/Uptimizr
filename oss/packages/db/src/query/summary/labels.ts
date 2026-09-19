/**
 * **Spatial labelling** of summary clusters (ADR 0051 §2, design sketch §B.2).
 *
 * A hotspot reported as "centred at (-6.2, 0, 8.4)" tells a language model
 * nothing it can act on. The scene registry already knows the vocabulary that
 * would: the proxy's per-mesh AABBs (ADR 0010/0014) name the geometry, and the
 * scene's **regions** (`sceneRegionSchema`) name the places a developer cares
 * about. This module joins the two onto a cluster so the same hotspot reads
 * "near `checkout_button`, in region `counter`".
 *
 * Four fields are attached, and each is defensible on its own:
 *
 * | field         | rule                                                              |
 * | ------------- | ----------------------------------------------------------------- |
 * | `region`      | the **smallest** region (by volume) whose box contains the centroid |
 * | `regions`     | *every* containing region id, ascending — regions may overlap       |
 * | `nearestMesh` | a proxy box containing the centroid, else the nearest box centre    |
 * | `distance`    | world units to that mesh's centre; `0` when the box contains it     |
 *
 * A mesh match is only reported when it is close enough to mean something: a
 * non-containing box must have its centre within `cellSize × 2` of the centroid,
 * the width of the cell the hotspot was binned into either side. Beyond that the
 * answer is `null` — "there is nothing here" is information, and a confidently
 * wrong landmark is worse than none.
 *
 * ## Determinism
 *
 * Everything here is a pure function of the *sets* it is given. Ties are broken
 * by id / name ascending (never by array order), volumes and distances are
 * compared as plain numbers, and no accumulation happens across boxes — so the
 * same scene and the same clusters always produce the same labels, whatever
 * order the store, the registry table or the proxy listed their rows in.
 *
 * ## Cost
 *
 * `O(clusters × boxes)`, with an early exit: a box whose expanded bounds (its
 * own box grown by the mesh threshold) do not contain the centroid can neither
 * contain it nor have its centre within the threshold, so it is rejected after
 * at most three comparisons without any distance math. With a summary capped at
 * `maxSummaryRows` clusters and a proxy capped at `LIMITS.maxSceneProxyMeshes`
 * boxes, the whole labelling pass is bounded — `__tests__/spatialLabels.test.ts`
 * holds the largest shape to under 50 ms.
 *
 * Pure and browser-safe: no I/O, no `node:` import, no store reference. The
 * collector loads the regions and the proxy once per request and hands them in.
 */

import type { MetricDefinition } from "@uptimizr/metrics";
import { gridColumns } from "./columns.js";
import type { SpatialCluster, SpatialLabel, SpatialScene } from "./types.js";

/** `[minX, minY, minZ, maxX, maxY, maxZ]`, the shared AABB encoding. */
type Box = readonly number[];

/**
 * Which **world** axis each grid axis indexes, for the registry's `unit: "index"`
 * column names. `null` for a grid that is not world-space at all — the pointer
 * and mesh-UV grids (`gx`/`gy`) are normalised viewport/UV cells and the
 * view-direction grid is angular, so a world box would be a category error.
 *
 * Only the two world-space shapes are labelled: the voxel grids (`vx/vy/vz`) and
 * the ground-plane bins (`gx/gz`), which index X and Z with no Y at all.
 */
const WORLD_AXES: Readonly<Record<string, 0 | 1 | 2>> = {
  vx: 0,
  vy: 1,
  vz: 2,
  gx: 0,
  gz: 2,
};

/**
 * Map a cluster summary's grid axes onto world axes, or `null` when the grid is
 * not world-space. A 2-axis `gx`/`gz` grid maps to X and Z: the labelling then
 * tests containment and distance **in the ground plane only**, which is what a
 * ground-binned metric actually measured.
 */
export function worldAxisMap(axes: readonly string[]): (0 | 1 | 2)[] | null {
  if (axes.length === 0) return null;
  const mapped: (0 | 1 | 2)[] = [];
  for (const axis of axes) {
    const world = WORLD_AXES[axis];
    if (world == null) return null;
    mapped.push(world);
  }
  // A repeated world axis would make containment meaningless.
  return new Set(mapped).size === mapped.length ? mapped : null;
}

/**
 * Whether a metric summarises as clusters on a **world-space** grid, and so is
 * worth loading a scene's regions and proxy for. Lets the collector skip the two
 * registry reads for the grids that could never be labelled — the viewport
 * pointer/UV bins and the angular view-direction grid — without teaching the
 * Fastify layer which grids those are.
 */
export function isWorldSpatialMetric(metric: MetricDefinition): boolean {
  if (metric.grain !== "bin" && metric.grain !== "voxel") return false;
  const axes = gridColumns(metric, metric.grain === "voxel" ? 3 : 2);
  return axes != null && worldAxisMap(axes.map(([name]) => name)) != null;
}

/** Volume of a box over the axes under test; `0` for a degenerate box. */
function volumeOf(box: Box, axes: readonly (0 | 1 | 2)[]): number {
  let volume = 1;
  for (const axis of axes) {
    const min = box[axis] ?? 0;
    const max = box[axis + 3] ?? 0;
    volume *= Math.max(0, max - min);
  }
  return volume;
}

/** Whether `point` (indexed by the same axes) lies inside `box`, inclusive. */
function contains(box: Box, point: readonly number[], axes: readonly (0 | 1 | 2)[]): boolean {
  for (let i = 0; i < axes.length; i++) {
    const axis = axes[i] as 0 | 1 | 2;
    const value = point[i] as number;
    if (value < (box[axis] ?? 0) || value > (box[axis + 3] ?? 0)) return false;
  }
  return true;
}

/** Squared distance from `point` to the centre of `box`, over the tested axes. */
function centreDistanceSq(
  box: Box,
  point: readonly number[],
  axes: readonly (0 | 1 | 2)[],
): number {
  let sum = 0;
  for (let i = 0; i < axes.length; i++) {
    const axis = axes[i] as 0 | 1 | 2;
    const centre = ((box[axis] ?? 0) + (box[axis + 3] ?? 0)) / 2;
    const delta = (point[i] as number) - centre;
    sum += delta * delta;
  }
  return sum;
}

/**
 * The early exit: a box grown by `slack` on every tested axis must still contain
 * the point, or it can neither contain the point nor have its centre within
 * `slack` of it (the centre is at least the overhang plus the half-extent away).
 * Three comparisons, no square root, no allocation.
 */
function withinSlack(
  box: Box,
  point: readonly number[],
  axes: readonly (0 | 1 | 2)[],
  slack: number,
): boolean {
  for (let i = 0; i < axes.length; i++) {
    const axis = axes[i] as 0 | 1 | 2;
    const value = point[i] as number;
    if (value < (box[axis] ?? 0) - slack || value > (box[axis + 3] ?? 0) + slack) return false;
  }
  return true;
}

/** Nothing known: the shape a cluster gets when the scene registers neither. */
const UNLABELLED: SpatialLabel = {
  region: null,
  regions: [],
  nearestMesh: null,
  distance: null,
};

/**
 * Label one world-space point against a scene's regions and proxy meshes.
 *
 * `point` carries one coordinate per entry of `axes`, already in world units.
 * `meshThreshold` is how far a *non-containing* mesh box's centre may be and
 * still be reported (the collector passes `cellSize × 2`); pass `0` to accept
 * containment only.
 */
export function labelPoint(
  point: readonly number[],
  scene: SpatialScene,
  axes: readonly (0 | 1 | 2)[],
  meshThreshold: number,
): SpatialLabel {
  const regions = scene.regions ?? [];
  const meshes = scene.meshes ?? [];
  if (regions.length === 0 && meshes.length === 0) return UNLABELLED;

  // Regions: every containing box (ids ascending), smallest by volume reported.
  const containing: string[] = [];
  let smallestId: string | null = null;
  let smallestVolume = Number.POSITIVE_INFINITY;
  for (const region of regions) {
    if (!contains(region.bounds, point, axes)) continue;
    containing.push(region.id);
    const volume = volumeOf(region.bounds, axes);
    // `<` keeps the first of equal volumes; the id sort below makes that stable.
    if (volume < smallestVolume || (volume === smallestVolume && region.id < (smallestId ?? ""))) {
      smallestVolume = volume;
      smallestId = region.id;
    }
  }
  containing.sort();

  // Meshes: a containing box wins outright (smallest, so a prop inside a room
  // beats the room); otherwise the nearest centre inside the threshold.
  let containedName: string | null = null;
  let containedVolume = Number.POSITIVE_INFINITY;
  let nearestName: string | null = null;
  let nearestDistanceSq = Number.POSITIVE_INFINITY;
  const thresholdSq = meshThreshold * meshThreshold;
  for (const mesh of meshes) {
    if (!withinSlack(mesh.aabb, point, axes, meshThreshold)) continue;
    if (contains(mesh.aabb, point, axes)) {
      const volume = volumeOf(mesh.aabb, axes);
      if (
        volume < containedVolume ||
        (volume === containedVolume && mesh.name < (containedName ?? ""))
      ) {
        containedVolume = volume;
        containedName = mesh.name;
      }
      continue;
    }
    // Only worth measuring while nothing contains the point.
    if (containedName != null) continue;
    const distanceSq = centreDistanceSq(mesh.aabb, point, axes);
    if (distanceSq > thresholdSq) continue;
    if (
      distanceSq < nearestDistanceSq ||
      (distanceSq === nearestDistanceSq && mesh.name < (nearestName ?? ""))
    ) {
      nearestDistanceSq = distanceSq;
      nearestName = mesh.name;
    }
  }

  const nearestMesh = containedName ?? nearestName;
  return {
    region: smallestId,
    regions: containing,
    nearestMesh,
    distance: nearestMesh == null ? null : containedName != null ? 0 : Math.sqrt(nearestDistanceSq),
  };
}

/** What {@link labelClusters} produced: the labelled clusters and what it could not do. */
export interface LabelledClusters {
  clusters: SpatialCluster[];
  /** Caveats naming what the scene did not register; empty when both are present. */
  caveats: string[];
  /** Whether anything was actually labelled (false when the grid is not world-space). */
  labelled: boolean;
}

/** Everything {@link labelClusters} needs about the request that produced them. */
export interface LabelOptions {
  /** The metric's grid axis column names, in order (`["vx","vy","vz"]`). */
  axes: readonly string[];
  /** The effective world size of one cell (ADR 0040 §1). */
  cellSize: number;
  /** The scene's registered regions and proxy meshes. */
  scene: SpatialScene;
}

/**
 * Attach `region` / `regions` / `nearestMesh` / `distance` to each cluster, and
 * upgrade the `drill.region` hint from an ad-hoc world box to the **region id**
 * when a registered region contains the hotspot — the id is the shared name both
 * a human and `?region=<id>` understand, so it is strictly the better hint.
 *
 * Returns the clusters untouched (and `labelled: false`) when the grid is not
 * world-space or no cell size is known: a viewport-bin or angular grid has no
 * world point to label, and saying so is the honest answer.
 */
export function labelClusters(
  clusters: readonly SpatialCluster[],
  options: LabelOptions,
): LabelledClusters {
  const { axes, cellSize, scene } = options;
  const axisMap = worldAxisMap(axes);
  const regions = scene.regions ?? [];
  const meshes = scene.meshes ?? [];
  if (axisMap == null || !(cellSize > 0) || !Number.isFinite(cellSize)) {
    return { clusters: [...clusters], caveats: [], labelled: false };
  }

  const caveats: string[] = [];
  if (meshes.length === 0) {
    caveats.push(
      `No proxy registered for scene ${scene.id == null ? "(unnamed)" : `\`${scene.id}\``} — ` +
        "`nearestMesh` and `distance` are unavailable. Register one with the SDK's " +
        "`scanSceneProxy` so hotspots can name the geometry they sit on.",
    );
  }
  if (regions.length === 0) {
    caveats.push(
      `No regions defined for scene ${scene.id == null ? "(unnamed)" : `\`${scene.id}\``} — ` +
        "`region` is null. Declare named boxes with `registerRegions` to give spatial answers a " +
        "vocabulary.",
    );
  }

  const threshold = cellSize * 2;
  const labelledClusters = clusters.map((cluster) => {
    // A cluster's centroid is a weighted mean of cell *indices*; the world point
    // is the centre of that fractional cell (ADR 0040 §1).
    const point = cluster.centroid.map((index) => (index + 0.5) * cellSize);
    const label = labelPoint(point, scene, axisMap, threshold);
    const drill = label.region != null ? { ...cluster.drill, region: label.region } : cluster.drill;
    return {
      ...cluster,
      ...(drill != null ? { drill } : {}),
      ...label,
    };
  });

  return { clusters: labelledClusters, caveats, labelled: true };
}
