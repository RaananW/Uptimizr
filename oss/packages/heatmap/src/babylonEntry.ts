/**
 * Bundle entry for the browser ESM build (`dist/uptimizr-heatmap.babylon.js`).
 * Re-exports the Babylon adapter; `@babylonjs/core` is left external so the
 * bundle binds to the host page's own Babylon instance.
 */
export {
  createBabylonHeatmapDriver,
  showWorldHeatmap,
  showGazeDome,
  showGazeSkydome,
  type BabylonHeatmapDriverOptions,
  type ShowWorldHeatmapOptions,
  type ShowGazeDomeOptions,
  type ShowGazeSkydomeOptions,
  type GazeSkydomeHandle,
} from "./drivers/babylon.js";
export { HeatmapOverlay, buildHeatmapInstances } from "./overlay.js";
export { GazeOverlay, buildGazeInstances } from "./gaze.js";
export { buildGazeEquirect } from "./gazeSkydome.js";
export { defaultColorRamp } from "./colorRamp.js";
export { fetchWorldHeatmap, fetchGazeHeatmap } from "./fetchHeatmap.js";
