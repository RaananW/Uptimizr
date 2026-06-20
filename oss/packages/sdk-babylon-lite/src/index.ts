/**
 * `@uptimizr/babylon-lite` — the Babylon Lite (`@babylonjs/lite`) connector for
 * Uptimizr.
 *
 * Babylon Lite is a brand-new **functional / data-oriented, WebGPU** Babylon
 * engine — a different paradigm from `@babylonjs/core` (no classes, no scene
 * observables; free functions operate on context structs). This connector
 * mirrors the three.js adapter's shape (the app owns the canvas + DOM input and
 * picking is explicit) rather than the class-based `@uptimizr/babylon` adapter.
 *
 * The quickest integration is {@link trackScene}: one call wires capture into a
 * Lite scene. For finer control, register {@link liteCollector} with an sdk-core
 * client via `client.use(...)`.
 *
 * `@babylonjs/lite` is an optional peer dependency — the connector reads from the
 * host application's Lite instance and never bundles its own. Lite's native frame
 * is **left-handed, y-up, unit-scale 1** — the same as the canonical wire frame
 * (ADR 0018) — so the `toCanonical*` normalizers are identities, still applied at
 * the emission boundary for provenance/symmetry.
 */

export { trackScene, trackSceneAsync } from "./trackScene.js";
export type { TrackSceneOptions } from "./trackScene.js";
export { liteCollector } from "./collector.js";
export type {
  LiteCollectorOptions,
  LiteCaptureOptions,
  LiteActor,
  LiteActorNode,
  MeshVisibilityOptions,
  HoverDwellOptions,
  ResourceSampleOptions,
  LiteGazeOptions,
} from "./collector.js";
export { readDeviceCaps } from "./device.js";
export { readGraphics, readGraphicsAsync } from "./graphics.js";
export { readConnector } from "./connector.js";
export { readSceneMeta, classifyCamera } from "./scene.js";
export { scanSceneProxy } from "./proxy.js";
export type { ScanSceneProxyOptions } from "./proxy.js";
export { createScenePicker } from "./picker.js";
export type { LitePickProbe, LitePickHit } from "./picker.js";
export { toVec3, clamp01 } from "./vec.js";
