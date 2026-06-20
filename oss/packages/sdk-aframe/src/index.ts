/**
 * `@uptimizr/aframe` — the A-Frame (WebXR) connector for Uptimizr.
 *
 * A-Frame renders **three.js** under the hood (`sceneEl.object3D`,
 * `sceneEl.camera`, `sceneEl.renderer` are all three.js objects), so this package
 * is a **thin A-Frame layer over `@uptimizr/three`** — it does not re-implement
 * capture, raycasting, or coordinate canonicalization. The integration surface is a
 * declarative component: `<a-scene uptimizr="projectId: ...; collector: ...">`.
 *
 * Importing this module registers the `uptimizr` component against the global
 * `AFRAME` (load A-Frame first). `aframe` and `three` are **peer dependencies** —
 * the connector reads the host page's instances and never bundles its own.
 *
 * The one place A-Frame does **more** than wrap three is WebXR: the
 * {@link xrCollector} maps XR controller/gaze pose and select/squeeze actions onto
 * the existing source-neutral schema events (ADR 0011). World-space data is
 * normalized to the canonical wire frame by `@uptimizr/three`; sessions are
 * attributed to the A-Frame connector (`connector.name === "aframe"`, ADR 0018).
 */

import { registerUptimizrComponent } from "./component.js";

export {
  registerUptimizrComponent,
  createUptimizrComponent,
  COMPONENT_NAME,
  UPTIMIZR_SCHEMA,
} from "./component.js";
export { buildTrackOptions } from "./options.js";
// WebXR controller/gaze capture lives in `@uptimizr/three` (A-Frame renders three);
// it is re-exported here so the A-Frame surface stays a one-import integration.
export { xrCollector } from "@uptimizr/three";
export type {
  XrCollectorOptions,
  XrCaptureOptions,
  XrRendererLike,
  XrRayHit,
  XrRayProbe,
} from "@uptimizr/three";
export type {
  UptimizrComponentData,
  UptimizrComponentInstance,
  AframeSceneElement,
  AframeLike,
  AframeComponentDefinition,
} from "./types.js";

// Re-export the three connector option types so A-Frame users can configure capture
// programmatically from one import (the option surface is three's TrackSceneOptions).
export type {
  TrackSceneOptions,
  ThreeCaptureOptions,
  MeshVisibilityOptions,
  HoverDwellOptions,
  ResourceSampleOptions,
} from "@uptimizr/three";

// Side effect: register `<a-scene uptimizr>` against the global AFRAME on import so
// a bare `import "@uptimizr/aframe"` is enough. No-ops if AFRAME isn't present.
registerUptimizrComponent();
