/**
 * `@uptimizr/playcanvas` — the PlayCanvas connector for Uptimizr.
 *
 * The quickest integration is {@link trackScene}: one call wires capture into a
 * PlayCanvas application. For finer control, register {@link playcanvasCollector}
 * with an sdk-core client via `client.use(...)` and supply device caps via
 * {@link readDeviceCaps}.
 *
 * `playcanvas` is a peer dependency — the connector reads from the host
 * application's PlayCanvas instance and never bundles its own. World-space data is
 * normalized from PlayCanvas' native right-handed, y-up frame to the canonical wire
 * frame (left-handed, y-up) at the emission boundary (ADR 0018).
 */

export { trackScene } from "./trackScene.js";
export type { TrackSceneOptions } from "./trackScene.js";
export { playcanvasCollector } from "./collector.js";
export type {
  PlayCanvasCollectorOptions,
  PlayCanvasCaptureOptions,
  PlayCanvasActor,
  PlayCanvasActorNode,
  MeshVisibilityOptions,
  HoverDwellOptions,
  ResourceSampleOptions,
  PlayCanvasGazeOptions,
} from "./collector.js";
export { readDeviceCaps } from "./device.js";
export { readGraphics } from "./graphics.js";
export { readConnector } from "./connector.js";
export { readSceneMeta, classifyCamera } from "./scene.js";
export { scanSceneProxy } from "./proxy.js";
export type { ScanSceneProxyOptions } from "./proxy.js";
export { createSceneRaycaster, createGazeRaycaster } from "./raycast.js";
export type { RaycastHit, RaycastProbe, GazeProbe, GazeProbeOptions } from "./raycast.js";
export { toVec3, clamp01 } from "./vec.js";
