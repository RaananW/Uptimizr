/**
 * Public types for `@uptimizr/heatmap`.
 *
 * The package mirrors the `@uptimizr/replay` split: a framework-agnostic core
 * (this module + {@link "./overlay"}) plus an engine-specific driver
 * (`./drivers/babylon`). The core never touches a rendering engine — it turns
 * voxel counts into normalized, positioned, colored {@link HeatmapInstance}s and
 * hands them to a {@link HeatmapDriver}.
 */

/**
 * One populated voxel of a world-space heatmap, as returned by the collector's
 * `GET /api/v1/heatmaps/world` endpoint. `(vx, vy, vz)` are integer cell indices;
 * the voxel's world-space center is `((v + 0.5) * cellSize)` per axis. `count` is
 * the number of hits in the cell.
 */
export interface HeatmapVoxel {
  vx: number;
  vy: number;
  vz: number;
  count: number;
}

/** A voxel heatmap plus the cell size (world units) used to bin it. */
export interface HeatmapData {
  voxels: readonly HeatmapVoxel[];
  /** Edge length of one voxel, in world units. Must match the query's `cellSize`. */
  cellSize: number;
}

/** An RGBA color, each channel in `[0, 1]`. */
export type Rgba = readonly [r: number, g: number, b: number, a: number];

/**
 * Maps a normalized intensity `t` in `[0, 1]` (0 = coldest voxel, 1 = busiest)
 * to an RGB triple, each channel in `[0, 1]`.
 */
export type ColorRamp = (t: number) => readonly [r: number, g: number, b: number];

/**
 * A single box the driver should draw: a world-space `position` (voxel center),
 * a uniform `scale` (cube edge length in world units) and an RGBA `color`.
 */
export interface HeatmapInstance {
  position: readonly [x: number, y: number, z: number];
  scale: number;
  color: Rgba;
}

/**
 * An engine-specific sink for heatmap instances. Implementations own one
 * reusable batch of geometry (e.g. a Babylon thin-instanced box) and rewrite it
 * on every {@link render}. The core calls these methods; it never imports an
 * engine itself.
 */
export interface HeatmapDriver {
  /** Replace the drawn set with `instances` (clears first if empty). */
  render(instances: readonly HeatmapInstance[]): void;
  /** Remove all drawn instances but keep the driver usable. */
  clear(): void;
  /** Toggle visibility without discarding the built instances. */
  setVisible(visible: boolean): void;
  /** Release all engine resources; the driver is unusable afterwards. */
  dispose(): void;
}

/** Knobs controlling how the core turns counts into {@link HeatmapInstance}s. */
export interface HeatmapStyle {
  /** Intensity → RGB. Defaults to {@link "./colorRamp".defaultColorRamp}. */
  colorRamp?: ColorRamp;
  /**
   * Shrink cold voxels so dense regions read as larger blocks. When `true`
   * (default) a voxel's edge is `cellSize * fill * (minScale + (1 - minScale) * t)`;
   * when `false` every voxel fills `cellSize * fill`.
   */
  scaleByIntensity?: boolean;
  /** Smallest cube edge as a fraction of the full cell, for `t = 0`. Default `0.35`. */
  minScale?: number;
  /** Cube edge as a fraction of the cell at full size. Default `0.9` (small gaps). */
  fill?: number;
  /** Constant alpha for every voxel, in `[0, 1]`. Default `1`. */
  opacity?: number;
  /**
   * Keep only the busiest `maxVoxels` cells (the rest are dropped). Defaults to
   * rendering all supplied voxels. Use it to bound instance count on huge scenes.
   */
  maxVoxels?: number;
}

/** Lifecycle handle returned by {@link "./overlay".HeatmapOverlay}. */
export interface HeatmapHandle {
  /** Recompute instances from `data` and push them to the driver. */
  render(data: HeatmapData): void;
  /** Clear drawn voxels (keeps the overlay reusable). */
  clear(): void;
  /** Show or hide the overlay. */
  setVisible(visible: boolean): void;
  /** Dispose the underlying driver and release resources. */
  dispose(): void;
}
