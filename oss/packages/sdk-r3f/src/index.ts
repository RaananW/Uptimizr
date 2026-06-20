/**
 * `@uptimizr/r3f` — the react-three-fiber connector for Uptimizr.
 *
 * react-three-fiber renders three.js, so this package is a **thin React layer over
 * `@uptimizr/three`** — it does not re-implement capture, raycasting, or coordinate
 * canonicalization. The hook {@link useUptimizr} (and the declarative {@link Uptimizr}
 * component) read the live `scene` / `camera` / `gl` from the R3F store via
 * `useThree()` and hand them to the three connector's `trackScene`, then stop capture
 * on unmount.
 *
 * `react`, `@react-three/fiber`, and `three` are peer dependencies — the connector
 * reads the host application's instances and never bundles its own. World-space data
 * is normalized to the canonical wire frame by `@uptimizr/three`; sessions are
 * attributed to the R3F connector (`connector.name === "r3f"`, ADR 0018).
 */

export { useUptimizr } from "./useUptimizr.js";
export type { UptimizrClientRef } from "./useUptimizr.js";
export { Uptimizr } from "./Uptimizr.js";
export type { UptimizrOptions } from "./options.js";

// Re-export the three connector option types so R3F users configure capture from one
// import (the option surface is the three connector's `TrackSceneOptions`).
export type {
  TrackSceneOptions,
  ThreeCaptureOptions,
  MeshVisibilityOptions,
  HoverDwellOptions,
  ResourceSampleOptions,
} from "@uptimizr/three";
