/**
 * Gaze (camera view-direction) overlay core for `@uptimizr/heatmap`.
 *
 * Where {@link "./overlay".buildHeatmapInstances} places voxel markers in world
 * space, the gaze form places markers on a **dome** around a center point: each
 * spherical direction bin (`azimuth_bin`, `elevation_bin`) from the collector's
 * `GET /api/v1/heatmaps/camera` endpoint is reconstructed back into a unit
 * direction and dropped onto a sphere of `radius`. Centering that dome on the
 * developer's live camera lets them stand inside the distribution of where
 * visitors looked.
 *
 * This module is engine-free: it turns bins into normalized, positioned, colored
 * {@link HeatmapInstance}s that any {@link HeatmapDriver} can draw. It is the
 * Tier 0 (ADR 0010) counterpart of the dashboard's `CameraDome3D` viewer and
 * reuses the same bin → angle reconstruction so both read identically.
 */
import { clamp01, defaultColorRamp } from "./colorRamp.js";
import type { ColorRamp, HeatmapDriver, HeatmapInstance } from "./types.js";

/**
 * One populated direction bin of a gaze heatmap, matching the collector's camera
 * heatmap rows (`azimuth_bin`, `elevation_bin`, `count`) but in camelCase. Bin
 * indices are in `[0, gridSize)`; see {@link GazeData.gridSize}.
 */
export interface GazeBin {
  /** Azimuth bucket index: `floor((atan2(z, x) + π) / 2π * gridSize)`. */
  azimuthBin: number;
  /** Elevation bucket index: `floor((asin(y / |v|) + π/2) / π * gridSize)`. */
  elevationBin: number;
  /** Number of camera samples that fell in this bin. */
  count: number;
}

/** Gaze bins plus the grid resolution (bins per axis) they were binned at. */
export interface GazeData {
  bins: readonly GazeBin[];
  /** Bins per axis (azimuth and elevation). Must match the query's `bins`. */
  gridSize: number;
}

/** Knobs controlling how the core turns gaze bins into dome {@link HeatmapInstance}s. */
export interface GazeStyle {
  /** Intensity → RGB. Defaults to {@link "./colorRamp".defaultColorRamp}. */
  colorRamp?: ColorRamp;
  /**
   * Dome radius in world units — how far the markers sit from {@link center}.
   * Pick a value that places the dome comfortably around the viewer in the host
   * scene's units. Default `5`.
   */
  radius?: number;
  /**
   * World-space point the dome is centered on. Default `[0, 0, 0]`. When the
   * Babylon helper follows a camera it overrides this with the camera position.
   */
  center?: readonly [x: number, y: number, z: number];
  /**
   * Shrink cold bins so busy directions read as larger markers. When `true`
   * (default) a marker's edge is `markerScale * radius * (minScale + (1 - minScale) * t)`;
   * when `false` every marker uses `markerScale * radius`.
   */
  scaleByIntensity?: boolean;
  /** Marker edge at full intensity, as a fraction of `radius`. Default `0.15`. */
  markerScale?: number;
  /** Smallest marker as a fraction of the full size, for `t = 0`. Default `0.2`. */
  minScale?: number;
  /** Constant alpha for every marker, in `[0, 1]`. Default `1`. */
  opacity?: number;
  /** Keep only the busiest `maxBins` directions. Defaults to all bins. */
  maxBins?: number;
}

const DEFAULTS = {
  radius: 5,
  scaleByIntensity: true,
  markerScale: 0.15,
  minScale: 0.2,
  opacity: 1,
} as const;

/**
 * Turn gaze direction bins into drawable {@link HeatmapInstance}s on a dome,
 * normalized so the busiest bin maps to `t = 1`. Pure and engine-free — exported
 * for testing and for hosts that render with a non-Babylon engine.
 *
 * Each bin's `(azimuthBin, elevationBin)` is inverted back to a continuous
 * spherical angle (the same reconstruction the dashboard's `CameraDome3D` uses)
 * and placed at `center + direction * radius`. A bin with `count <= 0` is
 * skipped.
 */
export function buildGazeInstances(data: GazeData, style: GazeStyle = {}): HeatmapInstance[] {
  const colorRamp = style.colorRamp ?? defaultColorRamp;
  const radius = style.radius !== undefined && style.radius > 0 ? style.radius : DEFAULTS.radius;
  const center = style.center ?? ([0, 0, 0] as const);
  const scaleByIntensity = style.scaleByIntensity ?? DEFAULTS.scaleByIntensity;
  const markerScale = style.markerScale ?? DEFAULTS.markerScale;
  const minScale = clamp01(style.minScale ?? DEFAULTS.minScale);
  const opacity = clamp01(style.opacity ?? DEFAULTS.opacity);
  const gridSize = data.gridSize > 0 ? data.gridSize : 1;

  // Keep only positive-count bins, busiest first, then optionally cap.
  let bins: readonly GazeBin[] = data.bins.filter((b) => b.count > 0);
  if (bins.length === 0) return [];
  bins = [...bins].sort((a, b) => b.count - a.count);
  if (typeof style.maxBins === "number" && style.maxBins >= 0) {
    bins = bins.slice(0, style.maxBins);
  }

  const busiest = bins[0];
  if (!busiest) return [];
  const maxCount = busiest.count;
  const fullEdge = markerScale * radius;
  const cx = center[0];
  const cy = center[1];
  const cz = center[2];

  const instances: HeatmapInstance[] = [];
  for (const b of bins) {
    const t = maxCount > 0 ? clamp01(b.count / maxCount) : 0;
    // Invert the server's binning: bin center → continuous spherical angle.
    const az = ((b.azimuthBin + 0.5) / gridSize) * Math.PI * 2 - Math.PI;
    const el = ((b.elevationBin + 0.5) / gridSize) * Math.PI - Math.PI / 2;
    const ce = Math.cos(el);
    const dx = ce * Math.cos(az);
    const dy = Math.sin(el);
    const dz = ce * Math.sin(az);

    const sizeFactor = scaleByIntensity ? minScale + (1 - minScale) * t : 1;
    const scale = fullEdge * sizeFactor;
    const [r, g, bl] = colorRamp(t);
    instances.push({
      position: [cx + dx * radius, cy + dy * radius, cz + dz * radius],
      scale,
      color: [r, g, bl, opacity],
    });
  }
  return instances;
}

/** Lifecycle handle returned by {@link GazeOverlay}. */
export interface GazeHandle {
  /** Recompute dome markers from `data` and push them to the driver. */
  render(data: GazeData): void;
  /** Clear drawn markers (keeps the overlay reusable). */
  clear(): void;
  /** Show or hide the overlay. */
  setVisible(visible: boolean): void;
  /** Dispose the underlying driver (and any extra resources) and release them. */
  dispose(): void;
}

/**
 * Stateful overlay that owns a {@link HeatmapDriver} and re-renders a gaze dome
 * from {@link GazeData}. Mirrors {@link "./overlay".HeatmapOverlay}, but builds
 * dome markers via {@link buildGazeInstances}. An optional `teardown` runs before
 * the driver is disposed (used by the Babylon helper to detach a camera follower).
 */
export class GazeOverlay implements GazeHandle {
  private readonly driver: HeatmapDriver;
  private readonly style: GazeStyle;
  private readonly teardown?: () => void;

  constructor(driver: HeatmapDriver, style: GazeStyle = {}, teardown?: () => void) {
    this.driver = driver;
    this.style = style;
    this.teardown = teardown;
  }

  render(data: GazeData): void {
    this.driver.render(buildGazeInstances(data, this.style));
  }

  clear(): void {
    this.driver.clear();
  }

  setVisible(visible: boolean): void {
    this.driver.setVisible(visible);
  }

  dispose(): void {
    this.teardown?.();
    this.driver.dispose();
  }
}
