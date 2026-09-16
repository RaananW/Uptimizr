/**
 * **Deterministic greedy cluster merge** for binned and voxelised metrics
 * (design sketch §B.2).
 *
 * A 500-bin heatmap or a voxel cloud is the wrong shape for a language model:
 * every cell is individually meaningless and collectively unaffordable. This
 * module collapses the grid into a handful of *hotspots* — connected runs of
 * adjacent occupied cells whose weight clears a density threshold — each
 * reporting where it is, how big it is and how much of the total it holds.
 *
 * ## Why not k-means
 *
 * A summary has to be reproducible: the same rows must produce the same words,
 * whatever order the store returned them in and however many times it is asked.
 * k-means needs seeds, so it is neither. What is implemented here is a plain
 * connected-components merge over the grid:
 *
 * 1. duplicate coordinates are summed, so a metric with extra dimensions (a
 *    per-mesh flow link, say) collapses onto its grid first;
 * 2. cells with weight at or above `densityThreshold` qualify — by default the
 *    mean weight per occupied cell, which keeps the busy cells and drops the
 *    long thin tail that would otherwise fuse every hotspot into one blob;
 * 3. qualifying cells are merged with their neighbours — the 8-neighbourhood
 *    for a 2D grid, the 26-neighbourhood for a 3D one (every cell whose indices
 *    differ by at most one on each axis);
 * 4. clusters are ranked by summed weight, and the rest is reported in bulk.
 *
 * Connected components do not depend on iteration order, and every accumulation
 * (centroid, weight) is done over the component's cells in **sorted coordinate
 * order**, so even floating-point summation is bit-identical when the input is
 * shuffled. `__tests__/summary.test.ts` asserts exactly that.
 *
 * Pure and browser-safe: no I/O, no `node:` import, no store reference.
 */

import type { SpatialCluster } from "./types.js";

/** One occupied grid cell: its integer indices on each axis, and its weight. */
export interface GridCell {
  coords: readonly number[];
  weight: number;
}

/** Knobs for {@link clusterCells}. */
export interface ClusterOptions {
  /**
   * Minimum weight a cell needs to take part in the merge. Defaults to the mean
   * weight per occupied cell. Pass `0` to cluster every occupied cell.
   */
  densityThreshold?: number;
  /** Maximum clusters to report individually; the remainder goes to `rest`. */
  maxClusters?: number;
}

/** What {@link clusterCells} found. */
export interface ClusterResult {
  clusters: SpatialCluster[];
  /** Distinct occupied cells, after duplicate coordinates were summed. */
  occupiedCells: number;
  /** Summed weight of every occupied cell (clustered or not). */
  totalWeight: number;
  /** The threshold that was actually applied. */
  densityThreshold: number;
  /** Clusters, cells and weight not reported individually. */
  rest: { clusters: number; cells: number; weight: number };
}

/** Compare two coordinate tuples lexicographically (ascending). */
function compareCoords(a: readonly number[], b: readonly number[]): number {
  for (let i = 0; i < a.length; i++) {
    const left = a[i] ?? 0;
    const right = b[i] ?? 0;
    if (left !== right) return left - right;
  }
  return 0;
}

/**
 * Every neighbour offset for a grid of `axes` dimensions: all combinations of
 * `-1 | 0 | +1` per axis, minus the all-zero one. Eight offsets in 2D, twenty-six
 * in 3D — the neighbourhoods the sketch specifies, derived rather than typed out.
 */
function neighbourOffsets(axes: number): number[][] {
  let offsets: number[][] = [[]];
  for (let axis = 0; axis < axes; axis++) {
    const next: number[][] = [];
    for (const prefix of offsets) {
      for (const delta of [-1, 0, 1]) next.push([...prefix, delta]);
    }
    offsets = next;
  }
  return offsets.filter((offset) => offset.some((delta) => delta !== 0));
}

/** Cached offsets — the only two shapes that occur are 2D and 3D. */
const OFFSETS = new Map<number, number[][]>();
function offsetsFor(axes: number): number[][] {
  let cached = OFFSETS.get(axes);
  if (cached == null) {
    cached = neighbourOffsets(axes);
    OFFSETS.set(axes, cached);
  }
  return cached;
}

/**
 * Merge adjacent occupied cells into ranked hotspots.
 *
 * Cells with a non-finite or non-positive weight are ignored (an empty bin is
 * not a hotspot), as are cells whose coordinate arity does not match the first
 * cell's — a malformed row must not silently shift the grid.
 *
 * Returns clusters ordered by weight descending, ties broken by their lowest
 * corner then by cell count, so the output is a pure function of the cell *set*.
 */
export function clusterCells(
  cells: readonly GridCell[],
  options: ClusterOptions = {},
): ClusterResult {
  const axes = cells[0]?.coords.length ?? 0;
  const empty: ClusterResult = {
    clusters: [],
    occupiedCells: 0,
    totalWeight: 0,
    densityThreshold: options.densityThreshold ?? 0,
    rest: { clusters: 0, cells: 0, weight: 0 },
  };
  if (axes === 0) return empty;

  // 1. Collapse duplicate coordinates onto the grid.
  const grid = new Map<string, { coords: number[]; weight: number }>();
  let totalWeight = 0;
  for (const cell of cells) {
    if (cell.coords.length !== axes) continue;
    if (!Number.isFinite(cell.weight) || cell.weight <= 0) continue;
    if (!cell.coords.every((coordinate) => Number.isFinite(coordinate))) continue;
    const coords = cell.coords.map((coordinate) => Math.trunc(coordinate));
    const key = coords.join(",");
    const existing = grid.get(key);
    if (existing) existing.weight += cell.weight;
    else grid.set(key, { coords, weight: cell.weight });
    totalWeight += cell.weight;
  }
  if (grid.size === 0) return empty;

  // 2. Qualify cells against the density threshold (mean weight by default).
  const densityThreshold = options.densityThreshold ?? totalWeight / grid.size;
  const qualifying = new Map<string, { coords: number[]; weight: number }>();
  for (const [key, cell] of grid) {
    if (cell.weight >= densityThreshold) qualifying.set(key, cell);
  }

  // 3. Connected components over the qualifying cells (8- or 26-neighbourhood).
  const offsets = offsetsFor(axes);
  const seen = new Set<string>();
  const components: { coords: number[]; weight: number }[][] = [];
  // Seed order only affects which component is discovered first, never their
  // membership — but iterate the grid in sorted order anyway so a debugger shows
  // the same thing twice.
  const seeds = [...qualifying.keys()].sort();
  for (const seed of seeds) {
    if (seen.has(seed)) continue;
    const component: { coords: number[]; weight: number }[] = [];
    const stack = [seed];
    seen.add(seed);
    while (stack.length > 0) {
      const key = stack.pop() as string;
      const cell = qualifying.get(key);
      if (cell == null) continue;
      component.push(cell);
      for (const offset of offsets) {
        const neighbourKey = cell.coords
          .map((value, axis) => value + (offset[axis] ?? 0))
          .join(",");
        if (seen.has(neighbourKey) || !qualifying.has(neighbourKey)) continue;
        seen.add(neighbourKey);
        stack.push(neighbourKey);
      }
    }
    components.push(component);
  }

  // 4. Describe each component. Accumulating in sorted coordinate order makes
  //    the floating-point sums independent of the input's row order.
  const described: SpatialCluster[] = components.map((component) => {
    const ordered = [...component].sort((a, b) => compareCoords(a.coords, b.coords));
    const min = [...(ordered[0] as { coords: number[] }).coords];
    const max = [...min];
    const weighted = new Array<number>(axes).fill(0);
    let weight = 0;
    for (const cell of ordered) {
      weight += cell.weight;
      for (let axis = 0; axis < axes; axis++) {
        const value = cell.coords[axis] as number;
        if (value < (min[axis] as number)) min[axis] = value;
        if (value > (max[axis] as number)) max[axis] = value;
        weighted[axis] = (weighted[axis] as number) + value * cell.weight;
      }
    }
    return {
      centroid: weighted.map((sum) => (weight > 0 ? sum / weight : 0)),
      extent: { min, max },
      cells: ordered.length,
      weight,
      share: totalWeight > 0 ? weight / totalWeight : null,
    };
  });

  described.sort(
    (a, b) => b.weight - a.weight || compareCoords(a.extent.min, b.extent.min) || b.cells - a.cells,
  );

  const cap = Math.max(0, options.maxClusters ?? described.length);
  const clusters = described.slice(0, cap);
  const dropped = described.slice(cap);
  const clusteredCells = described.reduce((sum, cluster) => sum + cluster.cells, 0);
  const reportedWeight = clusters.reduce((sum, cluster) => sum + cluster.weight, 0);

  return {
    clusters,
    occupiedCells: grid.size,
    totalWeight,
    densityThreshold,
    rest: {
      clusters: dropped.length,
      // Everything not listed individually: the dropped clusters' cells plus
      // every occupied cell that never cleared the threshold.
      cells: grid.size - clusteredCells + dropped.reduce((sum, cluster) => sum + cluster.cells, 0),
      weight: totalWeight - reportedWeight,
    },
  };
}
