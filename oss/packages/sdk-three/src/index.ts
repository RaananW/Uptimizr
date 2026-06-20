/**
 * `@uptimizr/three` — the three.js connector for Uptimizr.
 *
 * The quickest integration is {@link trackScene}: one call wires capture into a
 * three.js scene. For finer control, register {@link threeCollector} with an
 * sdk-core client via `client.use(...)` and supply device caps via
 * {@link readDeviceCaps}.
 *
 * `three` is a peer dependency — the connector reads from the host application's
 * three.js instance and never bundles its own. World-space data is normalized from
 * three's native right-handed, y-up frame to the canonical wire frame (left-handed,
 * y-up) at the emission boundary (ADR 0018).
 */

export { trackScene } from "./trackScene.js";
export type { TrackSceneOptions } from "./trackScene.js";
export { threeCollector } from "./collector.js";
export type {
  ThreeCollectorOptions,
  ThreeCaptureOptions,
  ThreeActor,
  ThreeActorNode,
  MeshVisibilityOptions,
  HoverDwellOptions,
  ResourceSampleOptions,
  ThreeGazeOptions,
} from "./collector.js";
export { readDeviceCaps } from "./device.js";
export { readGraphics } from "./graphics.js";
export { readConnector } from "./connector.js";
export { readSceneMeta, classifyCamera } from "./scene.js";
export { scanSceneProxy } from "./proxy.js";
export type { ScanSceneProxyOptions } from "./proxy.js";
export { createSceneRaycaster, createGazeRaycaster } from "./raycast.js";
export type { RaycastHit, RaycastProbe, GazeProbe, GazeProbeOptions } from "./raycast.js";
export { xrCollector } from "./xr.js";
export type {
  XrCollectorOptions,
  XrRendererLike,
  XrCaptureOptions,
  XrRayHit,
  XrRayProbe,
} from "./xr.js";
export { toVec3, clamp01 } from "./vec.js";
