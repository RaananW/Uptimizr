/**
 * `@uptimizr/babylon` — the Babylon.js connector for Uptimizr.
 *
 * The quickest integration is {@link trackScene}: one call wires capture into a
 * Babylon scene. For finer control, register {@link babylonCollector} with an
 * sdk-core client via `client.use(...)` and supply device caps via
 * {@link readDeviceCaps}.
 *
 * `@babylonjs/core` is a peer dependency — the connector reads from the host
 * application's Babylon instance and never bundles its own.
 */

export { trackScene } from "./trackScene.js";
export type { TrackSceneOptions } from "./trackScene.js";
export { babylonCollector } from "./collector.js";
export type {
  BabylonCollectorOptions,
  BabylonCaptureOptions,
  BabylonActor,
  BabylonActorNode,
  MeshVisibilityOptions,
  HoverDwellOptions,
  GazeOptions,
} from "./collector.js";
export { readDeviceCaps } from "./device.js";
export { readGraphics } from "./graphics.js";
export { readConnector } from "./connector.js";
export { readSceneMeta, classifyCamera } from "./scene.js";
export { scanSceneProxy } from "./proxy.js";
export type { ScanSceneProxyOptions } from "./proxy.js";
export { babylonXrCollector } from "./xr.js";
export type {
  BabylonXrCollectorOptions,
  BabylonXrExperienceLike,
  XrCaptureOptions,
  XrRayHit,
  XrRayProbe,
} from "./xr.js";
export { toVec3, clamp01 } from "./vec.js";
