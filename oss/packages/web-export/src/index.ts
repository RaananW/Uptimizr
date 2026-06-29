/**
 * `@uptimizr/web-export` — the shared foundation for Uptimizr's web-export engine
 * connectors (Unity, Godot, Unreal — ADR 0045).
 *
 * Three reusable pieces, consumed by `@uptimizr/unity`, `@uptimizr/godot`, and
 * `@uptimizr/unreal`:
 *
 * 1. **The versioned JS bridge contract** ({@link createEngineBridge},
 *    {@link EngineBridge}, {@link BRIDGE_PROTOCOL_VERSION}) — the tiny, stable API
 *    the engine-side WASM shim calls to push world-space pose / picks / perf /
 *    scene-proxy across the JS interop boundary.
 * 2. **The JS-only (zero-engine-code) capture tier** ({@link startJsOnlyCapture}) —
 *    pointer heatmaps, rAF FPS, and error capture driven purely from the `<canvas>`
 *    DOM, with no engine memory read.
 * 3. **Native-frame normalization** ({@link normalizePosition} etc.) — converts each
 *    engine's world-space data to the canonical wire frame (left-handed, y-up, unit
 *    scale 1 — ADR 0018), including the Unreal z-up rebase and centimeter scale.
 *
 * Plus {@link webExportCollector} (the combined sdk-core collector) and
 * {@link trackWebExport} (one-call setup). No `@uptimizr/schema` change is required.
 */

export type { NativeFrame } from "./types.js";

export {
  BRIDGE_PROTOCOL_VERSION,
  createEngineBridge,
} from "./bridge.js";
export type { EngineBridge, CreateEngineBridgeOptions } from "./bridge.js";

export {
  normalizePosition,
  normalizeDirection,
  normalizeAabb,
  rebaseZUpToYUp,
} from "./normalize.js";

export { buildConnector } from "./connector.js";

export { buildSceneProxy } from "./sceneProxy.js";
export type { BridgeSceneNode, BuildSceneProxyOptions } from "./sceneProxy.js";

export { startJsOnlyCapture } from "./jsOnly.js";
export type { CanvasView, JsOnlyOptions, JsOnlyCaptureOptions } from "./jsOnly.js";

export { webExportCollector } from "./collector.js";
export type { WebExportCollectorOptions } from "./collector.js";

export { trackWebExport } from "./trackWebExport.js";
export type { TrackWebExportOptions, WebExportSession } from "./trackWebExport.js";
