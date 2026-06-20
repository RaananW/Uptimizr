/**
 * Engine-agnostic entry for `@uptimizr/heatmap`. The Babylon adapter lives at
 * the `@uptimizr/heatmap/babylon` subpath so this root stays free of any
 * rendering-engine import (and thus testable without a GPU).
 */
export type {
  ColorRamp,
  HeatmapData,
  HeatmapDriver,
  HeatmapHandle,
  HeatmapInstance,
  HeatmapStyle,
  HeatmapVoxel,
  Rgba,
} from "./types.js";
export { clamp01, defaultColorRamp } from "./colorRamp.js";
export { buildHeatmapInstances, HeatmapOverlay } from "./overlay.js";
export {
  buildGazeInstances,
  GazeOverlay,
  type GazeBin,
  type GazeData,
  type GazeHandle,
  type GazeStyle,
} from "./gaze.js";
export {
  buildGazeEquirect,
  type GazeEquirectOptions,
  type GazeEquirectTexture,
} from "./gazeSkydome.js";
export { fetchWorldHeatmap, type FetchWorldHeatmapOptions } from "./fetchHeatmap.js";
export { fetchGazeHeatmap, type FetchGazeHeatmapOptions } from "./fetchHeatmap.js";
