import type { UptimizrClient } from "@uptimizr/sdk-core";

/**
 * Parsed `uptimizr` component data (A-Frame fills this from the component schema
 * before `init`). Mirrors {@link "./component".UPTIMIZR_SCHEMA}; numeric "use the
 * default" sentinels are `0` (the three connector's own defaults then apply).
 */
export interface UptimizrComponentData {
  /** Project identifier (public, non-secret). */
  projectId: string;
  /** Collector endpoint base URL, e.g. `https://collect.example.com`. */
  collector: string;
  /** Camera-pose sampling interval in ms (`0` ⇒ three connector default). */
  sampleCameraMs: number;
  /** Performance (FPS) sampling interval in ms (`0` ⇒ default). */
  samplePerfMs: number;
  /** Minimum gap between `pointer_move` samples in ms (`0` ⇒ default). */
  pointerMoveThrottleMs: number;
  /** Free-text label for the scene/experience, merged into scene metadata. */
  sceneDescription: string;
  /** Opt-in per-object dwell capture (`mesh_visibility`). */
  meshVisibility: boolean;
  /** Opt-in hover-hesitation capture (`hover_dwell`). */
  hoverDwell: boolean;
  /** Opt-in GPU/memory footprint capture (`resource_sample`). */
  resourceSample: boolean;
  /** Opt-in world-space gaze capture (`camera_sample.hitPoint`/`hitMesh`, ADR 0030). */
  gaze: boolean;
  /** Typed navigation-gesture capture (`camera_gesture`, ADR 0025). Default `true`. */
  cameraGesture: boolean;
  /** Capture XR controller/gaze pose + select/squeeze actions. Default `true`. */
  xr: boolean;
  /** XR controller/gaze pose sampling interval in ms (`0` ⇒ default). */
  xrSampleMs: number;
  /** Collect nothing (e.g. respect Do-Not-Track). */
  disabled: boolean;
  /** Emit debug logs to the console. */
  debug: boolean;
}

/**
 * Structural view of the A-Frame `<a-scene>` element. A-Frame wraps three.js, so
 * the scene element exposes the live three objects we hand to `@uptimizr/three`
 * (`object3D` is the `THREE.Scene`, `camera` the active `THREE.Camera`, `renderer`
 * the `THREE.WebGLRenderer`). Typed structurally so the connector never hard-imports
 * A-Frame internals (it is a peer dependency, supplied by the host page).
 */
export interface AframeSceneElement {
  /** The scene's root `THREE.Scene`. */
  object3D?: unknown;
  /** The active `THREE.Camera`. May be unset until `camera-set-active`. */
  camera?: unknown;
  /** The `THREE.WebGLRenderer`. Unset until the scene has rendered. */
  renderer?: unknown;
  /** True once the scene has finished loading. */
  hasLoaded?: boolean;
  /** Back-reference to the owning scene (identity when the component is on the scene). */
  sceneEl?: AframeSceneElement;
  addEventListener(type: string, handler: (...args: unknown[]) => void): void;
  removeEventListener(type: string, handler: (...args: unknown[]) => void): void;
}

/**
 * The `this` context A-Frame binds to the `uptimizr` component's methods: the
 * owning element + parsed `data`, plus the mutable capture state we attach.
 */
export interface UptimizrComponentInstance {
  /** The element the component is attached to (the `<a-scene>`). */
  el: AframeSceneElement;
  /** Parsed component data (from the schema). */
  data: UptimizrComponentData;
  /** The live capture client, or `null` before start / after teardown. */
  _uptimizrClient: UptimizrClient | null;
  /** Bound start handler used to defer capture until the scene is ready. */
  _uptimizrStart: () => void;
  /** The resolved scene element (`el.sceneEl ?? el`). */
  _uptimizrSceneEl: AframeSceneElement | undefined;
  /** Begin capture once `scene`/`camera`/`renderer` are available. */
  _startUptimizr(): void;
}

/** A single A-Frame component schema field. */
export interface AframeComponentSchemaField {
  type: string;
  default: unknown;
}

/** The `uptimizr` component definition passed to `AFRAME.registerComponent`. */
export interface AframeComponentDefinition {
  schema: Record<string, AframeComponentSchemaField>;
  init(this: UptimizrComponentInstance): void;
  update(this: UptimizrComponentInstance, oldData: Partial<UptimizrComponentData>): void;
  remove(this: UptimizrComponentInstance): void;
  _startUptimizr(this: UptimizrComponentInstance): void;
}

/**
 * Structural view of the global `AFRAME` object — only the members the connector
 * needs to register itself and read the library version (ADR 0018 provenance).
 */
export interface AframeLike {
  registerComponent(name: string, definition: AframeComponentDefinition): unknown;
  /** Registered components, used to make registration idempotent. */
  components?: Record<string, unknown>;
  /** A-Frame library version, recorded as connector provenance when present. */
  version?: string;
}
