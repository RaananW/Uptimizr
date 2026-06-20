import { trackScene } from "@uptimizr/three";
import type { Camera, Scene, WebGLRenderer } from "three";

import { buildTrackOptions } from "./options.js";
import type {
  AframeComponentDefinition,
  AframeLike,
  AframeSceneElement,
  UptimizrComponentData,
  UptimizrComponentInstance,
} from "./types.js";

/** The A-Frame component name: `<a-scene uptimizr="...">`. */
export const COMPONENT_NAME = "uptimizr";

/**
 * The `uptimizr` component schema. A-Frame parses the attribute string into the
 * matching {@link "./types".UptimizrComponentData}. Numeric dials default to `0`
 * ("unset" — the three connector's own default applies); the opt-in capture
 * channels default to `false` (privacy, ADR 0003); XR capture is on by default
 * since A-Frame is WebXR-first.
 */
export const UPTIMIZR_SCHEMA = {
  projectId: { type: "string", default: "" },
  collector: { type: "string", default: "" },
  sampleCameraMs: { type: "number", default: 0 },
  samplePerfMs: { type: "number", default: 0 },
  pointerMoveThrottleMs: { type: "number", default: 0 },
  sceneDescription: { type: "string", default: "" },
  meshVisibility: { type: "boolean", default: false },
  hoverDwell: { type: "boolean", default: false },
  resourceSample: { type: "boolean", default: false },
  gaze: { type: "boolean", default: false },
  cameraGesture: { type: "boolean", default: true },
  xr: { type: "boolean", default: true },
  xrSampleMs: { type: "number", default: 0 },
  disabled: { type: "boolean", default: false },
  debug: { type: "boolean", default: false },
} as const;

/**
 * Build the `uptimizr` A-Frame component definition. A-Frame wraps three.js, so the
 * component grabs the scene's live three objects (`object3D` / `camera` /
 * `renderer`) and hands them to `@uptimizr/three`'s {@link trackScene} — no capture
 * logic is re-implemented here. WebXR controller/gaze capture (A-Frame's
 * differentiator) is part of `trackScene` and on by default; the component only
 * forwards the `xr` / `xrSampleMs` schema fields through {@link buildTrackOptions}.
 *
 * A-Frame may not have an active camera or renderer at `init` time, so when the
 * scene isn't ready the component defers start until `loaded` / `camera-set-active`.
 * `remove()` (component teardown) calls `client.stop()`, tearing down every
 * listener, timer, and animation-frame callback the three connector and the XR
 * collector registered (ADR 0003: no cookies, no persistent ids).
 *
 * @param libraryVersion the A-Frame library version (`AFRAME.version`), recorded as
 *   connector provenance when present (ADR 0018).
 */
export function createUptimizrComponent(libraryVersion?: string): AframeComponentDefinition {
  return {
    schema: UPTIMIZR_SCHEMA,

    init(this: UptimizrComponentInstance) {
      this._uptimizrClient = null;
      this._uptimizrStart = () => this._startUptimizr();
      // For a component on `<a-scene>`, `el.sceneEl` is the scene itself; fall back
      // to `el` so the component also works if attached to the scene root directly.
      const sceneEl = (this.el.sceneEl ?? this.el) as AframeSceneElement;
      this._uptimizrSceneEl = sceneEl;

      if (this.data.disabled) return;

      if (sceneEl.hasLoaded && sceneEl.camera && sceneEl.renderer) {
        this._startUptimizr();
        return;
      }
      // Not ready yet: A-Frame sets the camera/renderer after the scene loads.
      sceneEl.addEventListener("loaded", this._uptimizrStart);
      sceneEl.addEventListener("camera-set-active", this._uptimizrStart);
    },

    update(this: UptimizrComponentInstance, oldData: Partial<UptimizrComponentData>) {
      // A-Frame re-invokes `update` whenever an attribute changes, so honor a
      // runtime `disabled` toggle the way any A-Frame component honors a property
      // change — this is the consent-gating path (ADR 0003: e.g. start only after
      // the visitor opts in). A-Frame fires `update` once right after `init` with
      // an empty `oldData`; `init` already wired the initial state, so act only on
      // an actual change to `disabled`.
      if (!("disabled" in oldData) || this.data.disabled === oldData.disabled) return;

      if (this.data.disabled) {
        // Opted out — tear down capture (and drop any pending readiness listeners).
        const sceneEl = this._uptimizrSceneEl;
        if (sceneEl) {
          sceneEl.removeEventListener("loaded", this._uptimizrStart);
          sceneEl.removeEventListener("camera-set-active", this._uptimizrStart);
        }
        const client = this._uptimizrClient;
        this._uptimizrClient = null;
        if (client) void client.stop("manual");
        return;
      }

      // Opted in — start now if the scene is ready, else defer to readiness events
      // exactly as `init` does.
      const sceneEl = this._uptimizrSceneEl;
      if (!sceneEl) return;
      if (sceneEl.hasLoaded && sceneEl.camera && sceneEl.renderer) {
        this._startUptimizr();
      } else {
        sceneEl.addEventListener("loaded", this._uptimizrStart);
        sceneEl.addEventListener("camera-set-active", this._uptimizrStart);
      }
    },

    _startUptimizr(this: UptimizrComponentInstance) {
      if (this._uptimizrClient) return; // idempotent: started already
      const sceneEl = this._uptimizrSceneEl;
      if (!sceneEl) return;
      const scene = sceneEl.object3D as Scene | undefined;
      const camera = sceneEl.camera as Camera | undefined;
      const renderer = sceneEl.renderer as WebGLRenderer | undefined;
      if (!scene || !camera || !renderer) return; // still not ready; wait for the next event

      // Ready — stop listening for further readiness events.
      sceneEl.removeEventListener("loaded", this._uptimizrStart);
      sceneEl.removeEventListener("camera-set-active", this._uptimizrStart);

      const client = trackScene(
        scene,
        camera,
        renderer,
        buildTrackOptions(this.data, libraryVersion),
      );
      this._uptimizrClient = client;
    },

    remove(this: UptimizrComponentInstance) {
      const sceneEl = this._uptimizrSceneEl;
      if (sceneEl && this._uptimizrStart) {
        sceneEl.removeEventListener("loaded", this._uptimizrStart);
        sceneEl.removeEventListener("camera-set-active", this._uptimizrStart);
      }
      const client = this._uptimizrClient;
      this._uptimizrClient = null;
      if (client) void client.stop("manual");
    },
  };
}

/**
 * Register the `uptimizr` component against an A-Frame instance — the global
 * `AFRAME` by default, or an explicit one (used by tests). Idempotent: it no-ops if
 * the component is already registered, and returns `false` when no A-Frame is
 * available (e.g. imported in a non-A-Frame page) instead of throwing.
 *
 * `@uptimizr/aframe`'s entry point calls this on import, so `import "@uptimizr/aframe"`
 * is enough to make `<a-scene uptimizr="...">` work.
 */
export function registerUptimizrComponent(aframe?: AframeLike): boolean {
  const A = aframe ?? (globalThis as { AFRAME?: AframeLike }).AFRAME;
  if (!A || typeof A.registerComponent !== "function") return false;
  if (A.components && Object.prototype.hasOwnProperty.call(A.components, COMPONENT_NAME)) {
    return true; // already registered — idempotent
  }
  const version = typeof A.version === "string" && A.version ? A.version : undefined;
  A.registerComponent(COMPONENT_NAME, createUptimizrComponent(version));
  return true;
}
