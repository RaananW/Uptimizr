import { clamp01, defaultColorRamp } from "./colorRamp.js";
import type {
  HeatmapData,
  HeatmapDriver,
  HeatmapHandle,
  HeatmapInstance,
  HeatmapStyle,
  HeatmapVoxel,
} from "./types.js";

const DEFAULTS = {
  scaleByIntensity: true,
  minScale: 0.35,
  fill: 0.9,
  opacity: 1,
} as const;

/**
 * Turn voxel rows into drawable {@link HeatmapInstance}s, normalized so the
 * busiest voxel maps to `t = 1`. Pure and engine-free — exported for testing and
 * for hosts that want to render heat with a non-Babylon engine.
 *
 * Counts are normalized against the maximum `count` in `voxels` (not a fixed
 * scale) so a heatmap is always legible regardless of absolute traffic. A voxel
 * with `count <= 0` is skipped.
 */
export function buildHeatmapInstances(
  data: HeatmapData,
  style: HeatmapStyle = {},
): HeatmapInstance[] {
  const colorRamp = style.colorRamp ?? defaultColorRamp;
  const scaleByIntensity = style.scaleByIntensity ?? DEFAULTS.scaleByIntensity;
  const minScale = clamp01(style.minScale ?? DEFAULTS.minScale);
  const fill = style.fill ?? DEFAULTS.fill;
  const opacity = clamp01(style.opacity ?? DEFAULTS.opacity);
  const cell = data.cellSize > 0 ? data.cellSize : 1;

  // Keep only positive-count voxels, busiest first, then optionally cap.
  let voxels: readonly HeatmapVoxel[] = data.voxels.filter((v) => v.count > 0);
  if (voxels.length === 0) return [];
  voxels = [...voxels].sort((a, b) => b.count - a.count);
  if (typeof style.maxVoxels === "number" && style.maxVoxels >= 0) {
    voxels = voxels.slice(0, style.maxVoxels);
  }

  const busiest = voxels[0];
  if (!busiest) return [];
  const maxCount = busiest.count;
  const instances: HeatmapInstance[] = [];
  for (const v of voxels) {
    const t = maxCount > 0 ? clamp01(v.count / maxCount) : 0;
    const sizeFactor = scaleByIntensity ? minScale + (1 - minScale) * t : 1;
    const scale = cell * fill * sizeFactor;
    const [r, g, b] = colorRamp(t);
    instances.push({
      position: [(v.vx + 0.5) * cell, (v.vy + 0.5) * cell, (v.vz + 0.5) * cell],
      scale,
      color: [r, g, b, opacity],
    });
  }
  return instances;
}

/**
 * Stateful overlay that owns a {@link HeatmapDriver} and re-renders it from
 * {@link HeatmapData}. This is the recommended entry point for hosts: construct
 * it once with an engine driver, then call {@link HeatmapOverlay.render} whenever
 * new heatmap data arrives.
 */
export class HeatmapOverlay implements HeatmapHandle {
  private readonly driver: HeatmapDriver;
  private readonly style: HeatmapStyle;

  constructor(driver: HeatmapDriver, style: HeatmapStyle = {}) {
    this.driver = driver;
    this.style = style;
  }

  render(data: HeatmapData): void {
    this.driver.render(buildHeatmapInstances(data, this.style));
  }

  clear(): void {
    this.driver.clear();
  }

  setVisible(visible: boolean): void {
    this.driver.setVisible(visible);
  }

  dispose(): void {
    this.driver.dispose();
  }
}
