import type { Camera, Mat4, SceneContext } from "@babylonjs/lite";
// Runtime import: Lite's per-frame hook and view-projection getter. `onBeforeRender`
// is the engine's own render-loop callback (Lite has no observable the connector
// owns), used to drive `"frame"`-cadence channels and to measure the frame delta
// for FPS. `getViewProjectionMatrix` powers the `mesh_visibility` frustum test
// (#37). The host page provides `@babylonjs/lite` (optional peer dependency);
// esbuild keeps it external — it is never bundled.
import { getViewProjectionMatrix, onBeforeRender } from "@babylonjs/lite";
import type {
  AggregatorConfig,
  CameraGestureSample,
  CameraPose,
  Collector,
  CollectorContext,
  CollectorHandle,
  NodeSamplingConfig,
  ResolvedCadence,
  SampleRate,
  SamplingProfile,
  VisibilityMeshObservation,
} from "@uptimizr/sdk-core";
import {
  poseUnchanged,
  resolveCadence,
  toCanonicalDirection,
  toCanonicalPosition,
  toCanonicalQuat,
} from "@uptimizr/sdk-core";
import type { Aabb, InputSource, Vec3 } from "@uptimizr/schema";
import { clamp01 } from "./vec.js";
import { createScenePicker } from "./picker.js";
import type { LitePickProbe } from "./picker.js";

/**
 * Map a DOM pointer's `pointerType` to an Uptimizr {@link InputSource} (ADR
 * 0011) — identical mapping to the Babylon/three connectors. The DOM values
 * (`mouse` / `pen` / `touch`) map straight through; any other non-empty value is
 * `other`; absence (e.g. a `MouseEvent` from `click`) leaves the field unset.
 */
function pointerSource(ev: PointerEventView): InputSource | undefined {
  const t = ev.pointerType;
  if (t === "mouse" || t === "pen" || t === "touch") return t;
  return typeof t === "string" && t.length > 0 ? "other" : undefined;
}

/** Structural view of a DOM pointer/mouse event's fields we read. */
interface PointerEventView {
  clientX: number;
  clientY: number;
  button?: number;
  pointerType?: string;
}

/** Structural view of the host canvas the app passed to `createEngine`. */
interface CanvasView {
  addEventListener(type: string, handler: (e: unknown) => void): void;
  removeEventListener(type: string, handler: (e: unknown) => void): void;
  getBoundingClientRect?: () => { left: number; top: number; width: number; height: number };
}

/** Structural view of a Lite `ArcRotateCamera` we read for the look-at target. */
interface ArcRotateView {
  alpha?: number;
  target?: { x: number; y: number; z: number };
}

type Vec3T = [number, number, number];

/** Read a Mat4 index, coercing the (index-signature) read to a concrete number. */
function m(mat: Mat4, i: number): number {
  return (mat as unknown as Record<number, number>)[i] ?? 0;
}

function sub3(a: Vec3T, b: Vec3T): Vec3T {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}
function dot3(a: Vec3T, b: Vec3T): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

/**
 * Structural view of a Lite mesh read for `mesh_visibility` (#37). `boundMin` /
 * `boundMax` are Lite's world-space bounding box (loader-populated; procedural
 * meshes must be stamped by the host — same source the scene-proxy scan reads).
 */
interface MeshVisibilityView {
  name?: string;
  visible?: boolean;
  boundMin?: readonly [number, number, number];
  boundMax?: readonly [number, number, number];
}

/** World-space bounding sphere + AABB of a Lite mesh (already canonical, ADR 0018). */
interface WorldBounds {
  center: Vec3T;
  radius: number;
  aabb: Aabb;
}

/**
 * Read a Lite mesh's world bounds from its `boundMin` / `boundMax` box. Lite is
 * left-handed (canonical), so no Z flip is applied (unlike the three connector,
 * which negates Z). Returns `null` when the mesh has no bounds — procedural
 * meshes without loader bounds are skipped unless the host stamps them.
 */
function readWorldBounds(mesh: MeshVisibilityView): WorldBounds | null {
  const lo = mesh.boundMin;
  const hi = mesh.boundMax;
  if (!lo || !hi) return null;
  const minX = lo[0],
    minY = lo[1],
    minZ = lo[2];
  const maxX = hi[0],
    maxY = hi[1],
    maxZ = hi[2];
  return {
    center: [(minX + maxX) / 2, (minY + maxY) / 2, (minZ + maxZ) / 2],
    radius: 0.5 * Math.hypot(maxX - minX, maxY - minY, maxZ - minZ),
    aabb: [minX, minY, minZ, maxX, maxY, maxZ],
  };
}

/**
 * Whether a world-space bounding sphere is inside the camera frustum. Projects
 * the sphere centre through Lite's `getViewProjectionMatrix` (column-major,
 * `clip = VP · pos`) and tests the clip cube with a radius margin (vertical focal
 * scale `1/tan(fov/2)`). When the VP can't be computed (e.g. a stub camera in a
 * unit test), falls back to the forward half-space test the three connector also
 * uses as its fallback.
 */
function sphereInFrustum(
  camera: Camera,
  aspect: number,
  center: Vec3T,
  radius: number,
  camPos: Vec3T,
  forward: Vec3T,
): boolean {
  let vp: Mat4 | undefined;
  try {
    vp = getViewProjectionMatrix(camera, aspect);
  } catch {
    vp = undefined;
  }
  if (vp) {
    const cx = center[0],
      cy = center[1],
      cz = center[2];
    const x = m(vp, 0) * cx + m(vp, 4) * cy + m(vp, 8) * cz + m(vp, 12);
    const y = m(vp, 1) * cx + m(vp, 5) * cy + m(vp, 9) * cz + m(vp, 13);
    const z = m(vp, 2) * cx + m(vp, 6) * cy + m(vp, 10) * cz + m(vp, 14);
    const w = m(vp, 3) * cx + m(vp, 7) * cy + m(vp, 11) * cz + m(vp, 15);
    if (Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(z) && Number.isFinite(w)) {
      if (w <= 0) return false; // behind the camera
      const focalY = typeof camera.fov === "number" ? 1 / Math.tan(camera.fov / 2) : 1;
      const margin = Math.abs(radius * focalY);
      return (
        x >= -w - margin &&
        x <= w + margin &&
        y >= -w - margin &&
        y <= w + margin &&
        z >= -w - margin &&
        z <= w + margin
      );
    }
  }
  // Fallback: anything in front of the camera (VP unavailable / non-finite).
  return dot3(sub3(center, camPos), forward) > 0;
}

/**
 * Snapshot a Lite camera into an engine-agnostic {@link CameraGestureSample}
 * (ADR 0025) for navigation-gesture classification. Reads the same world matrix
 * as {@link CameraPose} sampling: translation for position, +Z basis for forward,
 * +Y basis for up. Lite is left-handed, so `toCanonical*` are identities. An
 * `ArcRotateCamera` supplies an explicit pivot (its target) and distance; other
 * cameras leave them unset and the classifier infers a pivot from the view rays.
 */
function readGestureSample(camera: Camera): CameraGestureSample {
  const wm = camera.worldMatrix;
  const position = toCanonicalPosition([m(wm, 12), m(wm, 13), m(wm, 14)], "left") as Vec3T;
  const fLen = Math.hypot(m(wm, 8), m(wm, 9), m(wm, 10)) || 1;
  const forward = toCanonicalDirection(
    [m(wm, 8) / fLen, m(wm, 9) / fLen, m(wm, 10) / fLen],
    "left",
  ) as Vec3T;
  const uLen = Math.hypot(m(wm, 4), m(wm, 5), m(wm, 6)) || 1;
  const up = toCanonicalDirection(
    [m(wm, 4) / uLen, m(wm, 5) / uLen, m(wm, 6) / uLen],
    "left",
  ) as Vec3T;
  const sample: CameraGestureSample = { position, forward, up };
  const arc = camera as unknown as ArcRotateView;
  if (typeof arc.alpha === "number" && arc.target) {
    const pivot = toCanonicalPosition([arc.target.x, arc.target.y, arc.target.z], "left") as Vec3T;
    sample.pivot = pivot;
    sample.distance = Math.hypot(
      position[0] - pivot[0],
      position[1] - pivot[1],
      position[2] - pivot[2],
    );
  }
  if (typeof camera.fov === "number") sample.fov = camera.fov;
  return sample;
}

type QuatT = [number, number, number, number];

/** A captured world transform for a scene actor (`node_transform`, ADR 0027). */
interface NodeSample {
  position: Vec3;
  rotation: QuatT;
  scale?: Vec3;
}

/** Structural view of a Lite node we read a world transform from. */
interface WorldMatrixNode {
  worldMatrix: Mat4;
}

/**
 * Decompose a Lite world `Mat4` into position / rotation quaternion / scale (the
 * same column-major algorithm Babylon/three use): scale is the length of each
 * basis column (negate `sx` on a negative determinant to keep a proper rotation),
 * then the scale-normalized 3×3 is converted to a quaternion. Lite is left-handed
 * (canonical), so no handedness reflection is applied (ADR 0018).
 */
function decomposeWorldMatrix(mat: Mat4): NodeSample {
  const position: Vec3 = [m(mat, 12), m(mat, 13), m(mat, 14)];
  let sx = Math.hypot(m(mat, 0), m(mat, 1), m(mat, 2));
  const sy = Math.hypot(m(mat, 4), m(mat, 5), m(mat, 6));
  const sz = Math.hypot(m(mat, 8), m(mat, 9), m(mat, 10));
  const det =
    m(mat, 0) * (m(mat, 5) * m(mat, 10) - m(mat, 6) * m(mat, 9)) -
    m(mat, 4) * (m(mat, 1) * m(mat, 10) - m(mat, 2) * m(mat, 9)) +
    m(mat, 8) * (m(mat, 1) * m(mat, 6) - m(mat, 2) * m(mat, 5));
  if (det < 0) sx = -sx;
  const ix = sx !== 0 ? 1 / sx : 0;
  const iy = sy !== 0 ? 1 / sy : 0;
  const iz = sz !== 0 ? 1 / sz : 0;
  const m11 = m(mat, 0) * ix,
    m21 = m(mat, 1) * ix,
    m31 = m(mat, 2) * ix;
  const m12 = m(mat, 4) * iy,
    m22 = m(mat, 5) * iy,
    m32 = m(mat, 6) * iy;
  const m13 = m(mat, 8) * iz,
    m23 = m(mat, 9) * iz,
    m33 = m(mat, 10) * iz;
  const trace = m11 + m22 + m33;
  let x: number, y: number, z: number, w: number;
  if (trace > 0) {
    const s = 0.5 / Math.sqrt(trace + 1);
    w = 0.25 / s;
    x = (m32 - m23) * s;
    y = (m13 - m31) * s;
    z = (m21 - m12) * s;
  } else if (m11 > m22 && m11 > m33) {
    const s = 2 * Math.sqrt(1 + m11 - m22 - m33);
    w = (m32 - m23) / s;
    x = 0.25 * s;
    y = (m12 + m21) / s;
    z = (m13 + m31) / s;
  } else if (m22 > m33) {
    const s = 2 * Math.sqrt(1 + m22 - m11 - m33);
    w = (m13 - m31) / s;
    x = (m12 + m21) / s;
    y = 0.25 * s;
    z = (m23 + m32) / s;
  } else {
    const s = 2 * Math.sqrt(1 + m33 - m11 - m22);
    w = (m21 - m12) / s;
    x = (m13 + m31) / s;
    y = (m23 + m32) / s;
    z = 0.25 * s;
  }
  return { position, rotation: [x, y, z, w], scale: [sx, sy, sz] };
}

/**
 * Read a Lite node's world transform into a `node_transform` sample. Lite is
 * left-handed (canonical), so `toCanonical*` are identities (called for
 * provenance/symmetry). Scale is omitted when identity (ADR 0027).
 */
function readNodeTransform(node: WorldMatrixNode, scaleEps: number): NodeSample {
  const local = decomposeWorldMatrix(node.worldMatrix);
  const sample: NodeSample = {
    position: toCanonicalPosition(local.position, "left") as Vec3,
    rotation: toCanonicalQuat(local.rotation, "left") as QuatT,
  };
  const s = local.scale;
  if (
    s &&
    (Math.abs(s[0] - 1) > scaleEps ||
      Math.abs(s[1] - 1) > scaleEps ||
      Math.abs(s[2] - 1) > scaleEps)
  ) {
    sample.scale = s;
  }
  return sample;
}

/** Structural view of a Lite node that might be a camera (refused for node_transform). */
interface MaybeCameraNode {
  worldMatrix?: Mat4;
  fov?: number;
  getClassName?: () => string;
}

/** True when `node` is a camera — refused for `node_transform` (ADR 0027 §7). */
function isCameraNode(node: MaybeCameraNode): boolean {
  const name = node.getClassName?.();
  if (typeof name === "string" && name.includes("Camera")) return true;
  // Lite cameras expose `fov` but no `getClassName`; the field is a strong hint.
  return typeof node.fov === "number";
}

/** Minimal structural view of the Lite scene lookup used to resolve a named actor. */
interface ActorLookupScene {
  meshes?: Array<{ name?: string }>;
}

/**
 * Derive the per-tick capture rate from a `sampling.nodes` entry: either a bare
 * {@link SampleRate} (root-only, ADR 0027) or a {@link NodeSamplingConfig} whose
 * `hz` carries the rate (subtree, ADR 0033). Lite's scene is a flat mesh list
 * with no hierarchy, so the subtree `include` is not walked here (see the
 * dev-mode warning at the sampler) — only the rate is honoured.
 */
function nodeRate(entry: SampleRate | NodeSamplingConfig | undefined): SampleRate | undefined {
  if (entry !== null && typeof entry === "object") return entry.hz;
  return entry;
}

/**
 * Resolve a declared {@link LiteActor} to a live node, or `null` when it is not
 * (yet) in the scene. A function is called each time (robust to load order); a
 * string is matched against `scene.meshes[].name`; a direct reference is returned
 * as-is.
 */
function resolveActorNode(scene: ActorLookupScene, actor: LiteActor): WorldMatrixNode | null {
  if (typeof actor === "function") {
    return (actor() as WorldMatrixNode | null | undefined) ?? null;
  }
  if (typeof actor === "string") {
    const found = scene.meshes?.find((mesh) => mesh.name === actor);
    return found ? (found as unknown as WorldMatrixNode) : null;
  }
  return (actor as WorldMatrixNode | null) ?? null;
}

/** Which signals the collector captures. All default to `true`. */
export interface LiteCaptureOptions {
  camera?: boolean;
  pointerMove?: boolean;
  clicks?: boolean;
  /** Raw `pointer_down` / `pointer_up` button transitions (press-and-hold, drags). */
  buttons?: boolean;
  /**
   * Typed `camera_gesture` navigation capture (ADR 0025). **On by default**: it
   * separates navigation intent (orbit/pan/dolly/zoom/roll/fly) from object
   * selection, costs only a snapshot+diff per gesture, and carries no PII.
   */
  cameraGesture?: boolean;
  meshPicks?: boolean;
  perf?: boolean;
  /**
   * Scene-actor transform capture (`node_transform`, ADR 0027 Tier 1). **On by
   * default**, but inert unless actors are declared in
   * {@link LiteCollectorOptions.actors} AND given a rate in `sampling.nodes`.
   */
  nodes?: boolean;
  /**
   * Per-object dwell / attention capture (`mesh_visibility`, #37). **Opt-in, off
   * by default** (privacy, ADR 0003). Each window the connector emits one
   * bucketed summary per tracked object (ADR 0012): on-screen time, time spent
   * near the view centre (a gaze proxy), and the max screen fraction reached.
   * Configure via {@link LiteCollectorOptions.meshVisibility}.
   */
  meshVisibility?: boolean;
  /**
   * Hover-hesitation capture (`hover_dwell`, #48). **Opt-in, off by default**
   * (privacy, ADR 0003): emits one bucketed summary per hover episode (ADR 0012)
   * when the pointer lingers on an object *without acting on it*. Lite picking is
   * async/GPU-based, so hover is sampled at the pointer-move cadence (a documented
   * divergence from the synchronous three/Babylon adapters). Configure via
   * {@link LiteCollectorOptions.hoverDwell}.
   */
  hoverDwell?: boolean;
  /**
   * GPU / memory footprint capture (`resource_sample`, #44). **Opt-in, off by
   * default** (privacy + cost, ADR 0003): emits one low-rate summary per window
   * (ADR 0012). Lite exposes no schema-mapped geometry counters on its public
   * surface (its `drawCallCount` has no matching `resource_sample` field), so the
   * Lite connector reports only the JS heap size (Chromium-only). Configure
   * cadence via {@link LiteCollectorOptions.resourceSample}.
   */
  resourceSample?: boolean;
  /**
   * World-space gaze capture (`camera_sample.hitPoint`/`hitMesh`, ADR 0030).
   * **Opt-in, off by default** (privacy + cost, ADR 0003 / ADR 0012). When on, each
   * emitted camera pose resolves the surface under the **screen centre** (the
   * camera-forward direction) via Lite's GPU picker — a world-space "what did people
   * actually look at" heatmap, independent of pointer/click. Lite picking is
   * async/GPU-based, so the hit is attached to the *next* emitted camera_sample (at
   * most one sample of latency — a documented divergence from the synchronous
   * three/Babylon adapters). The pick reuses the pointer GPU picker and rides the
   * throttled, idle-suppressed camera cadence, so cost is bounded. Configure via
   * {@link LiteCollectorOptions.gaze}.
   */
  gaze?: boolean;
}

/** Per-object dwell capture options (`mesh_visibility`, #37) — mirrors three/Babylon. */
export interface MeshVisibilityOptions {
  /** Summary window length in ms — one event per object per window. Default 5000. */
  windowMs?: number;
  /**
   * Allowlist of mesh names to track (low-cardinality, app-defined — ADR 0003).
   * When omitted, every visible, bounded, non-overlay mesh is tracked, capped by
   * {@link maxMeshes}.
   */
  meshes?: string[];
  /**
   * Half-angle in degrees from the camera forward axis within which an object's
   * centre counts as "near the view centre" for `centeredMs`. Default 12.
   */
  centeredAngleDeg?: number;
  /** Max meshes to track when no allowlist is given. Default 50. */
  maxMeshes?: number;
  /**
   * Attach each tracked object's world-space AABB to its summary (#53), so the
   * dashboard can render a coarse "ghost" reconstruction of the scene. Off by
   * default (extra volume + discloses layout, ADR 0003). The box is sent once per
   * object and re-sent only when it moves/resizes beyond a small epsilon.
   */
  boundingBox?: boolean;
}

/** Hover-hesitation capture options (`hover_dwell`, #48) — mirrors three/Babylon. */
export interface HoverDwellOptions {
  /**
   * Minimum uninterrupted hover time in ms before an episode is reported. Short
   * pass-overs aren't hesitation, so they're dropped. Default 500.
   */
  minDwellMs?: number;
  /**
   * Allowlist of mesh names to track (low-cardinality, app-defined — ADR 0003).
   * When omitted, hover over any picked mesh is tracked.
   */
  meshes?: string[];
}

/** GPU / memory footprint capture options (`resource_sample`, #44) — mirrors three/Babylon. */
export interface ResourceSampleOptions {
  /**
   * Sampling interval in ms — one footprint summary per window (ADR 0012). The
   * footprint moves slowly, so the default is deliberately low-rate. Default
   * 15000 (every 15s).
   */
  intervalMs?: number;
}

/**
 * World-space gaze capture tuning (`camera_sample.hitPoint`/`hitMesh`, ADR 0030).
 * Lite resolves gaze via a GPU pick at the screen centre, so unlike the geometric
 * three/Babylon raycasters it can only filter by **name** after the fact and cap
 * by distance — it cannot run a per-mesh predicate.
 */
export interface LiteGazeOptions {
  /**
   * Max gaze distance in world units: a center-pixel hit farther than this from the
   * camera counts as a miss (so a glance into a distant skybox doesn't register).
   * Default 1000.
   */
  maxDistance?: number;
  /**
   * Allowlist of mesh names eligible for a gaze hit (low-cardinality, app-defined
   * — ADR 0003). When omitted, any picked mesh can be hit. Provide this to keep
   * `hitMesh` cardinality meaningful and to exclude ground/skybox/helper meshes.
   */
  meshes?: string[];
}

/** A Babylon Lite node that exposes a world transform (a `node_transform` actor, ADR 0027). */
export type LiteActorNode = WorldMatrixNode;

/**
 * A declared scene actor (ADR 0027): a live {@link LiteActorNode}, a mesh **name**
 * matched against `scene.meshes[].name`, or a `() => node` resolver called each
 * sample (robust to load order and disposal).
 */
export type LiteActor = (() => LiteActorNode | null | undefined) | string | LiteActorNode;

export interface LiteCollectorOptions {
  /** The Babylon Lite scene to instrument (read-only). */
  scene: SceneContext;
  /**
   * Camera to record for the view-direction / pose timeline. Lite has no
   * `scene.activeCamera` the connector can rely on, so the camera the viewer
   * flies is passed explicitly (mirrors the three connector).
   */
  camera: Camera;
  /**
   * The host canvas (the `HTMLCanvasElement` passed to `createEngine`). Lite
   * surfaces no pointer observable, so DOM pointer listeners are attached here.
   */
  canvas: HTMLCanvasElement;
  /** Camera-pose sampling interval in ms. Default 1000. */
  sampleCameraMs?: number;
  /** Performance (FPS) sampling interval in ms. Default 2000. */
  samplePerfMs?: number;
  /** Minimum gap between `pointer_move` samples in ms. Default 250. */
  pointerMoveThrottleMs?: number;
  /**
   * Sensitivity dial for `camera_gesture` classification (ADR 0025). Scales every
   * motion dead-zone together: `> 1` is less sensitive, `< 1` more. Default 1.
   */
  cameraGestureSensitivity?: number;
  /**
   * Per-channel capture-fidelity dial in Hz / `"frame"` / `0`-off (ADR 0012).
   * Governs continuous channels only (camera pose, pointer move, perf); discrete
   * events are always captured. When a channel is set here it overrides the
   * matching legacy ms knob; omitted channels keep the conservative defaults.
   */
  sampling?: SamplingProfile;
  /**
   * Skip timer-based **camera** samples when the pose is unchanged (within
   * {@link cameraEpsilon}). The first sample is always emitted. Default `true`.
   */
  suppressIdleSamples?: boolean;
  /**
   * Skip timer-based `frame_perf` samples when FPS is unchanged (within
   * {@link perfFpsThreshold}). Default `false` — a steady FPS is meaningful
   * telemetry, so the perf channel reports continuously.
   */
  suppressIdlePerfSamples?: boolean;
  /** Max per-axis pose change treated as "unchanged" for camera dedupe. Default 1e-3. */
  cameraEpsilon?: number;
  /** Max FPS change treated as "unchanged" for perf dedupe. Default 1. */
  perfFpsThreshold?: number;
  /** Toggle individual capture channels. */
  capture?: LiteCaptureOptions;
  /**
   * Scene-actor map for `node_transform` capture (ADR 0027 Tier 1): self-moving
   * Lite nodes (NPCs, lifts, vehicles) whose world transform is recorded so
   * replay can reproduce them. Each value resolves to a live node — a direct
   * reference (anything with a `worldMatrix`), a mesh **name** (matched against
   * `scene.meshes[].name`), or a `() => node` resolver (robust to load order).
   * A node is only captured when its id also has a rate in `sampling.nodes`;
   * cameras are refused (the visitor camera is already `camera_sample`).
   */
  actors?: Record<string, LiteActor>;
  /**
   * Per-object dwell capture tuning (`mesh_visibility`, #37). Only consulted when
   * `capture.meshVisibility` is enabled.
   */
  meshVisibility?: MeshVisibilityOptions;
  /**
   * Hover-hesitation capture tuning (`hover_dwell`, #48). Only consulted when
   * `capture.hoverDwell` is enabled.
   */
  hoverDwell?: HoverDwellOptions;
  /**
   * GPU / memory footprint capture tuning (`resource_sample`, #44). Only consulted
   * when `capture.resourceSample` is enabled.
   */
  resourceSample?: ResourceSampleOptions;
  /**
   * World-space gaze capture tuning (`camera_sample.hitPoint`/`hitMesh`, ADR 0030).
   * Only consulted when `capture.gaze` is enabled.
   */
  gaze?: LiteGazeOptions;
  /**
   * Override the picking probe used to resolve pointer hits (world point + mesh
   * name). Defaults to a Lite GPU picker against the scene ({@link createScenePicker}).
   * Tests inject a stub so picking is exercised without a real WebGPU device.
   */
  picker?: LitePickProbe;
  /**
   * Override the per-frame hook registration. Defaults to Lite's
   * `onBeforeRender(scene, cb)`. Injected by tests so FPS / `"frame"`-cadence
   * channels are exercised without a real engine driving the render loop.
   */
  frameHook?: (scene: SceneContext, cb: (deltaMs: number) => void) => void;
  /**
   * Multiply CSS-pixel pointer coordinates by this factor before handing them to
   * the GPU picker. Lite's swapchain backing store defaults to
   * `devicePixelRatio`-scaled, so pass `window.devicePixelRatio` when the host
   * renders at native resolution. Default `1` (CSS pixels), which is correct when
   * the surface's `maxDevicePixelRatio` is `1`.
   */
  pickPixelRatio?: number;
}

/**
 * Create the Babylon Lite connector as an sdk-core {@link Collector}. Register it
 * with `client.use(...)`.
 *
 * It samples camera pose (view-direction heatmap), pointer movement and clicks
 * (screen heatmaps), mesh picks (object engagement), and FPS (perf). It only
 * reads from the scene — it never mutates it — and tears every listener, timer,
 * frame hook, and GPU picker down on stop (ADR 0003: no cookies, no persistent ids).
 *
 * ## Babylon Lite adaptations (vs. the `@babylonjs/core` connector)
 * - **Functional/data-oriented:** Lite has no `Scene` class with observables.
 *   The per-frame hook is the free function `onBeforeRender(scene, cb)` — which
 *   returns `void` (no unsubscribe handle), so the callback body is guarded by a
 *   `disposed` flag instead of being removed.
 * - **Pointer/picking:** Lite surfaces no pointer observable and picking is
 *   **async, GPU-based** (`createGpuPicker` + `await pickAsync`). DOM listeners
 *   are attached to the host canvas and hits are resolved asynchronously; late
 *   pick resolutions after `stop()` are dropped via the `disposed` flag.
 * - **FPS:** derived from the `deltaMs` Lite passes to `onBeforeRender`.
 * - **Coordinate frame:** Lite is **left-handed, y-up, unit-scale 1** — the same
 *   as the canonical wire frame — so the `toCanonical*` helpers are identities,
 *   still called at the emission boundary for provenance/symmetry (ADR 0018).
 */
export function liteCollector(options: LiteCollectorOptions): Collector {
  const {
    scene,
    camera,
    canvas,
    sampleCameraMs = 1000,
    samplePerfMs = 2000,
    pointerMoveThrottleMs = 250,
    cameraGestureSensitivity = 1,
    suppressIdleSamples = true,
    suppressIdlePerfSamples = false,
    cameraEpsilon = 1e-3,
    perfFpsThreshold = 1,
    capture = {},
    sampling = {},
    pickPixelRatio = 1,
  } = options;
  // Resolve each continuous channel's cadence (ADR 0012). An explicit `sampling`
  // entry wins; otherwise we fall back to the legacy ms knob.
  const cameraCadence = resolveCadence(sampling.camera, sampleCameraMs);
  const perfCadence = resolveCadence(sampling.perf, samplePerfMs);
  const pointerMoveCadence = resolveCadence(sampling.pointerMove, pointerMoveThrottleMs);

  const want = {
    camera: (capture.camera ?? true) && cameraCadence.mode !== "off",
    pointerMove: (capture.pointerMove ?? true) && pointerMoveCadence.mode !== "off",
    clicks: capture.clicks ?? true,
    buttons: capture.buttons ?? true,
    // Typed navigation gestures are on by default (ADR 0025): cheap, no PII.
    cameraGesture: capture.cameraGesture ?? true,
    meshPicks: capture.meshPicks ?? true,
    perf: (capture.perf ?? true) && perfCadence.mode !== "off",
    // Opt-in, off by default (privacy + cost, ADR 0003).
    meshVisibility: capture.meshVisibility ?? false,
    hoverDwell: capture.hoverDwell ?? false,
    resourceSample: capture.resourceSample ?? false,
    // Gaze raycast is opt-in (privacy + cost, ADR 0003 / ADR 0012): off unless
    // enabled, and only meaningful when the camera channel is captured.
    gaze: (capture.gaze ?? false) && (capture.camera ?? true) && cameraCadence.mode !== "off",
  };

  // Gaze (`camera_sample.hitPoint`/`hitMesh`, ADR 0030) tuning. Lite picks the
  // screen-centre pixel (camera-forward) via the GPU picker, then filters by an
  // optional name allowlist and a max camera-to-hit distance.
  const gazeOpts = options.gaze ?? {};
  const gazeMaxDistance = gazeOpts.maxDistance ?? 1000;
  const gazeMeshAllowlist =
    gazeOpts.meshes && gazeOpts.meshes.length > 0 ? new Set(gazeOpts.meshes) : undefined;

  // Per-object dwell (`mesh_visibility`, #37) tuning.
  const visOpts = options.meshVisibility ?? {};
  const visWindowMs = visOpts.windowMs ?? 5000;
  const visMeshAllowlist =
    visOpts.meshes && visOpts.meshes.length > 0 ? new Set(visOpts.meshes) : undefined;
  const visCenteredCos = Math.cos(((visOpts.centeredAngleDeg ?? 12) * Math.PI) / 180);
  const visMaxMeshes = visOpts.maxMeshes ?? 50;
  const visBoundingBox = visOpts.boundingBox ?? false;

  // Hover-hesitation (`hover_dwell`, #48) tuning.
  const hoverOpts = options.hoverDwell ?? {};
  const hoverMinDwellMs = hoverOpts.minDwellMs ?? 500;
  const hoverMeshAllowlist =
    hoverOpts.meshes && hoverOpts.meshes.length > 0 ? new Set(hoverOpts.meshes) : undefined;

  // GPU/memory footprint (`resource_sample`, #44) tuning.
  const resourceOpts = options.resourceSample ?? {};
  const resourceIntervalMs = resourceOpts.intervalMs ?? 15000;

  // Scene-actor (`node_transform`, ADR 0027 Tier 1) configuration. Only ids that
  // are BOTH declared in `actors` and given a rate in `sampling.nodes` are
  // tracked (default OFF); each is driven by its own resolved cadence (ADR 0012).
  const wantNodesChannel = capture.nodes ?? true;
  const actorMap = options.actors ?? {};
  const actorIds = wantNodesChannel
    ? Object.keys(sampling.nodes ?? {}).filter((id) => {
        const declared = Object.prototype.hasOwnProperty.call(actorMap, id);
        if (!declared) {
          console.warn(
            `[uptimizr] sampling.nodes["${id}"] has no matching entry in \`actors\`; ` +
              "ignoring. Declare the node in `actors` to capture its transform.",
          );
        }
        return declared;
      })
    : [];
  const wantNodes = actorIds.length > 0;

  // Pointer-move throttle in ms: a fixed interval throttles; "frame" means emit
  // every move (no throttle). Discrete pointer events are never throttled.
  const pointerThrottleMs = pointerMoveCadence.mode === "interval" ? pointerMoveCadence.ms : 0;

  // The per-frame hook registration (Lite's `onBeforeRender` by default).
  const installFrameHook = options.frameHook ?? onBeforeRender;

  return {
    name: "babylon-lite",
    start(ctx: CollectorContext): CollectorHandle {
      // The engine-agnostic aggregator (#10): the connector reads live engine
      // state into plain-number snapshot DTOs and hands them here; the
      // offload-eligible math (matrix decompose, visibility bucketing,
      // idle-diffs, gesture classification) runs main-thread by default or
      // inside the offload worker, behind the client `offload` flag.
      const aggregatorConfig: AggregatorConfig = {
        perf: { suppressIdle: suppressIdlePerfSamples, fpsThreshold: perfFpsThreshold },
        node: { suppressIdle: suppressIdleSamples },
        visibility: { centeredCos: visCenteredCos, boundingBox: visBoundingBox, boundsEps: 1e-3 },
      };
      const snapshot = ctx.createAggregation(aggregatorConfig);
      const timers: ReturnType<typeof setInterval>[] = [];
      const domListeners: Array<{ type: string; handler: (e: unknown) => void }> = [];
      const frameCallbacks: Array<(deltaMs: number) => void> = [];
      // Run-once-on-stop hooks (trailing flushes for windowed/episodic captures).
      const stopCallbacks: Array<() => void> = [];
      let disposed = false;
      let frameHookInstalled = false;

      let lastPointerMove = 0;
      let lastPose: CameraPose | undefined;
      // Gaze (ADR 0030) state: the most recent resolved center-pixel hit, and the
      // async refresher that updates it. Lite picking is async, so the hit is
      // attached to the *next* emitted camera_sample (≤ one sample of latency).
      let lastGaze: { hitPoint?: Vec3T; hitMesh?: string } = {};
      let refreshGaze: (() => void) | undefined;
      // camera_gesture (ADR 0025) bracket state: the camera snapshot at
      // pointer-down, diffed against pointer-up to classify the navigation.
      let gestureStart: { sample: CameraGestureSample; ts: number; source?: InputSource } | null =
        null;
      // Smoothed instantaneous FPS, fed from Lite's per-frame `deltaMs`.
      let smoothedFps: number | undefined;

      // Install Lite's per-frame hook lazily — only when a "frame"-cadence channel
      // or the FPS estimator needs it. It returns void (no unsubscribe), so the
      // callback is guarded by `disposed` and simply no-ops after stop.
      const ensureFrameHook = () => {
        if (frameHookInstalled) return;
        frameHookInstalled = true;
        installFrameHook(scene, (deltaMs: number) => {
          if (disposed) return;
          // Exponential moving average of FPS (deltaMs is ms/frame).
          if (deltaMs > 0) {
            const inst = 1000 / deltaMs;
            smoothedFps = smoothedFps === undefined ? inst : smoothedFps * 0.8 + inst * 0.2;
          }
          for (const cb of frameCallbacks) cb(deltaMs);
        });
      };

      const driveChannel = (cadence: ResolvedCadence, sample: () => void) => {
        if (cadence.mode === "interval") {
          timers.push(setInterval(sample, cadence.ms));
        } else if (cadence.mode === "frame") {
          frameCallbacks.push(() => sample());
          ensureFrameHook();
        }
      };

      // --- Camera pose ---
      const sampleCamera = () => {
        const wm = camera.worldMatrix;
        // Position is the world-matrix translation (indices 12,13,14).
        const px = m(wm, 12);
        const py = m(wm, 13);
        const pz = m(wm, 14);
        // Forward is the world +Z basis (indices 8,9,10) — Babylon's getDirection(Z).
        let fx = m(wm, 8);
        let fy = m(wm, 9);
        let fz = m(wm, 10);
        const len = Math.hypot(fx, fy, fz) || 1;
        fx /= len;
        fy /= len;
        fz /= len;

        // Lite is left-handed → toCanonical* are identities (provenance/symmetry).
        const position = toCanonicalPosition([px, py, pz], "left") as Vec3T;
        const direction = toCanonicalDirection([fx, fy, fz], "left") as Vec3T;
        const fov = typeof camera.fov === "number" ? camera.fov : undefined;

        // ArcRotateCamera carries an explicit look-at target — emit it so replay
        // is unambiguous (a free camera has none).
        const arc = camera as unknown as ArcRotateView;
        const target =
          typeof arc.alpha === "number" && arc.target
            ? (toCanonicalPosition([arc.target.x, arc.target.y, arc.target.z], "left") as Vec3T)
            : undefined;

        const pose: CameraPose = {
          position,
          direction,
          ...(target ? { target } : {}),
          ...(fov !== undefined ? { fov } : {}),
        };
        // Cheap main-thread idle pre-gate: keep at most one gaze pick per emitted
        // pose (and none while the view is static) by diffing against the last
        // pose with the same `poseUnchanged` the aggregator uses (#10, no logic
        // fork). The aggregator's camera channel is then a pass-through.
        if (suppressIdleSamples && lastPose && poseUnchanged(lastPose, pose, cameraEpsilon)) {
          return;
        }
        lastPose = pose;
        snapshot({
          channel: "camera",
          position: pose.position,
          direction: pose.direction,
          ...(pose.target ? { target: pose.target } : {}),
          ...(pose.fov !== undefined ? { fov: pose.fov } : {}),
          ...(lastGaze.hitPoint ? { hitPoint: lastGaze.hitPoint } : {}),
          ...(lastGaze.hitMesh ? { hitMesh: lastGaze.hitMesh } : {}),
        });
        // Kick off the async center-pixel pick for the NEXT sample (ADR 0030). No-op
        // unless gaze capture is on. Runs only on emitted poses, so it inherits the
        // throttle + idle suppression — never per frame.
        refreshGaze?.();
      };

      // --- Frame perf (FPS) ---
      const samplePerf = () => {
        if (smoothedFps === undefined) return;
        const fps = smoothedFps;
        // Lite exposes no frame-time series, so the perf snapshot carries an empty
        // window (the aggregator's percentile/longFrames path stays a no-op). The
        // FPS idle-diff moves to the aggregator behind `perf.suppressIdle` (#10).
        snapshot({ channel: "perf", frameTimes: new Float32Array(0), fps, jankFrameMs: 0 });
      };

      if (want.camera) {
        sampleCamera();
        driveChannel(cameraCadence, sampleCamera);
      }

      if (want.perf) {
        // FPS is fed by the per-frame hook regardless of the perf cadence mode.
        ensureFrameHook();
        driveChannel(perfCadence, samplePerf);
      }

      if (wantNodes) {
        // Scene-actor capture (`node_transform`, ADR 0027 Tier 1). Each declared
        // actor gets its own cadence-driven sampler: resolve the node (lazily —
        // resolvers handle load order), refuse cameras (the visitor camera is
        // already `camera_sample`; "events live once"), read the WORLD transform,
        // and hand it to the aggregator. Lite is left-handed (canonical), so we
        // pass the engine-decomposed sample; the aggregator owns the idle-diff so
        // a static actor still costs nothing on the wire (#10).
        const lookupScene = scene as unknown as ActorLookupScene;
        const refusedCamera = new Set<string>();
        for (const id of actorIds) {
          const actor = actorMap[id]!;
          const entry = sampling.nodes?.[id];
          const cadence = resolveCadence(nodeRate(entry), sampleCameraMs);
          if (cadence.mode === "off") continue;
          // Tier-1 subtree (ADR 0033) needs a node hierarchy; Lite's scene is a
          // flat mesh list, so an `include` config is warned and ignored here.
          if (entry !== null && typeof entry === "object" && entry.include !== undefined) {
            console.warn(
              `[uptimizr] sampling.nodes["${id}"].include is not supported by the Lite ` +
                "connector (flat scene, no hierarchy); capturing the actor root only.",
            );
          }
          const sampleNode = () => {
            const node = resolveActorNode(lookupScene, actor);
            if (!node) return;
            if (isCameraNode(node as MaybeCameraNode)) {
              if (!refusedCamera.has(id)) {
                refusedCamera.add(id);
                console.warn(
                  `[uptimizr] actor "${id}" resolves to a camera; refusing node_transform ` +
                    "capture. The visitor camera is already captured as camera_sample.",
                );
              }
              return;
            }
            snapshot({
              channel: "node",
              nodeId: id,
              decomposed: readNodeTransform(node, cameraEpsilon),
              scaleEps: cameraEpsilon,
            });
          };
          sampleNode();
          driveChannel(cadence, sampleNode);
        }
      }

      // --- Per-object dwell (`mesh_visibility`, #37) ---
      // Each render tick we read which tracked objects are on-screen (the engine
      // frustum/bounds reads must stay main-thread) and hand the raw per-tick
      // observations to the aggregator; it owns the dwell/centred/screen-fraction
      // bucketing, the AABB dedupe/round (#53) and the per-window flush (ADR 0012,
      // #10). World bounds come from each mesh's `boundMin`/`boundMax` (the same
      // source the scene-proxy scan reads); the frustum test uses Lite's
      // getViewProjectionMatrix.
      if (want.meshVisibility) {
        const visCanvas = canvas as unknown as CanvasView;
        let lastVisTime = ctx.now();

        const sampleVisibility = () => {
          const now = ctx.now();
          const stepMs = now - lastVisTime;
          lastVisTime = now;
          if (stepMs <= 0) return;

          const wm = camera.worldMatrix;
          const camPos: Vec3T = [m(wm, 12), m(wm, 13), m(wm, 14)];
          // Raw (un-normalized) world +Z basis; the aggregator normalizes it. The
          // frustum test only uses its sign, so the raw vector is equivalent.
          const forward: Vec3T = [m(wm, 8), m(wm, 9), m(wm, 10)];
          // Vertical FOV in radians (Lite fov is already radians); the aggregator
          // halves it. `0.8` mirrors the previous `0.4` half-FOV default.
          const fov = typeof camera.fov === "number" ? camera.fov : 0.8;
          const rect =
            typeof visCanvas.getBoundingClientRect === "function"
              ? visCanvas.getBoundingClientRect()
              : { left: 0, top: 0, width: 0, height: 0 };
          const aspect = (rect.width || 1) / (rect.height || 1);

          let tracked = 0;
          const meshes = (scene as unknown as { meshes?: unknown[] }).meshes;
          if (!Array.isArray(meshes)) return;
          const observations: VisibilityMeshObservation[] = [];
          for (const raw of meshes) {
            const obj = raw as MeshVisibilityView;
            const name = obj.name;
            if (!name || name.startsWith("uptimizr-")) continue;
            if (visMeshAllowlist) {
              if (!visMeshAllowlist.has(name)) continue;
            } else {
              if (obj.visible === false) continue;
              if (tracked >= visMaxMeshes) continue;
            }
            const bounds = readWorldBounds(obj);
            if (!bounds) continue;
            tracked++;
            if (!sphereInFrustum(camera, aspect, bounds.center, bounds.radius, camPos, forward)) {
              continue;
            }
            observations.push({
              mesh: name,
              center: bounds.center,
              radius: bounds.radius,
              // Ride the world AABB along only when bounds capture is on (#53); Lite
              // is left-handed (canonical) so it needs no Z flip (ADR 0018). The
              // aggregator dedupes/rounds it across the window.
              ...(visBoundingBox ? { aabb: bounds.aabb } : {}),
            });
          }
          if (observations.length === 0) return;
          snapshot({
            channel: "visibilityTick",
            stepMs,
            camPos,
            forward,
            fov,
            meshes: observations,
          });
        };

        const flushVisibility = () => snapshot({ channel: "visibilityFlush" });

        // Sample every frame; flush on the window timer + once on stop (trailing).
        frameCallbacks.push(sampleVisibility);
        ensureFrameHook();
        timers.push(setInterval(flushVisibility, visWindowMs));
        stopCallbacks.push(flushVisibility);
      }

      // --- Pointer / picking wiring (DOM listeners on the host canvas) ---
      const wantPointer =
        want.pointerMove || want.clicks || want.buttons || want.meshPicks || want.hoverDwell;
      const canvasView = canvas as unknown as CanvasView;
      // The GPU picker is shared by the pointer path and the gaze probe (ADR 0030),
      // so create it once when either needs it.
      const wantPicker = wantPointer || want.gaze;
      const picker: LitePickProbe | undefined = wantPicker
        ? (options.picker ?? createScenePicker(scene))
        : undefined;
      // The picker is owned here only when we created it (a caller-supplied probe
      // is the caller's to dispose).
      const ownsPicker = wantPicker && options.picker === undefined;

      const addListener = (type: string, handler: (e: unknown) => void) => {
        canvasView.addEventListener(type, handler);
        domListeners.push({ type, handler });
      };

      const rectOf = () =>
        typeof canvasView.getBoundingClientRect === "function"
          ? canvasView.getBoundingClientRect()
          : { left: 0, top: 0, width: 0, height: 0 };

      // Normalized screen [0,1], origin top-left — engine-independent.
      const screenOf = (ev: PointerEventView): [number, number] => {
        const rect = rectOf();
        const w = rect.width || 1;
        const h = rect.height || 1;
        return [clamp01((ev.clientX - rect.left) / w), clamp01((ev.clientY - rect.top) / h)];
      };

      // Pixel coordinates on the canvas for the GPU picker. CSS pixels by default;
      // scaled by `pickPixelRatio` when the swapchain is DPR-scaled.
      const pixelOf = (ev: PointerEventView): [number, number] => {
        const rect = rectOf();
        return [
          (ev.clientX - rect.left) * pickPixelRatio,
          (ev.clientY - rect.top) * pickPixelRatio,
        ];
      };

      interface ResolvedHit {
        hitPoint?: Vec3;
        hitMesh?: string;
      }
      const resolveHit = async (ev: PointerEventView): Promise<ResolvedHit> => {
        if (!picker) return {};
        const [px, py] = pixelOf(ev);
        const hit = await picker.pick(px, py);
        if (disposed || !hit) return {};
        // Hit point is in Lite's left-handed world frame → canonical (identity).
        const hitPoint = hit.point ? (toCanonicalPosition(hit.point, "left") as Vec3) : undefined;
        return {
          ...(hitPoint ? { hitPoint } : {}),
          ...(hit.mesh ? { hitMesh: hit.mesh } : {}),
        };
      };

      // --- Gaze probe (`camera_sample.hitPoint`/`hitMesh`, ADR 0030) ---
      // One async pick at the screen centre (camera-forward) per emitted
      // camera_sample, reusing the shared GPU picker. The resolved hit is cached in
      // `lastGaze` and attached to the next sample (≤ one sample latency). Filtered
      // by an optional name allowlist and a max camera-to-hit distance.
      if (want.gaze && picker) {
        refreshGaze = () => {
          const rect = rectOf();
          const cx = (rect.width / 2) * pickPixelRatio;
          const cy = (rect.height / 2) * pickPixelRatio;
          void picker
            .pick(cx, cy)
            .then((hit) => {
              if (disposed) return;
              if (!hit || !hit.point) {
                lastGaze = {};
                return;
              }
              if (gazeMeshAllowlist && (!hit.mesh || !gazeMeshAllowlist.has(hit.mesh))) {
                lastGaze = {};
                return;
              }
              // Distance gate against the live camera position (world translation).
              const wm = camera.worldMatrix;
              const dx = hit.point[0] - m(wm, 12);
              const dy = hit.point[1] - m(wm, 13);
              const dz = hit.point[2] - m(wm, 14);
              if (Math.hypot(dx, dy, dz) > gazeMaxDistance) {
                lastGaze = {};
                return;
              }
              // Lite is left-handed → canonical (identity, ADR 0018).
              const hitPoint = toCanonicalPosition(hit.point, "left") as Vec3T;
              lastGaze = { hitPoint, ...(hit.mesh ? { hitMesh: hit.mesh } : {}) };
            })
            .catch(() => {
              // A failed pick simply leaves the previous gaze in place.
            });
        };
        // Prime the cache so the next emitted sample can carry a hit.
        refreshGaze();
      }

      // --- Hover hesitation (`hover_dwell`, #48) episode state ---
      // An episode runs while the pointer rests on one object. It is reported only
      // if it lasted >= minDwellMs AND the user never acted on the object (a
      // click/press means deliberate engagement, not hesitation). Lite picking is
      // async, so hover is tracked from the throttled pointer-move pick resolution
      // (a documented divergence from the synchronous three/Babylon adapters).
      let hoverMesh: string | undefined;
      let hoverStartMs = 0;
      let hoverActed = false;
      let hoverSource: InputSource | undefined;

      const flushHover = (now: number) => {
        if (hoverMesh !== undefined && !hoverActed) {
          const dwellMs = now - hoverStartMs;
          // Keep the dwell-threshold gate on the main thread (the aggregator's
          // hover channel is a pass-through); only completed episodes are emitted.
          if (dwellMs >= hoverMinDwellMs) {
            snapshot({
              channel: "hover",
              mesh: hoverMesh,
              dwellMs,
              ...(hoverSource ? { source: hoverSource } : {}),
            });
          }
        }
        hoverMesh = undefined;
        hoverActed = false;
        hoverSource = undefined;
      };

      const trackHover = (
        now: number,
        mesh: string | undefined,
        source: InputSource | undefined,
      ) => {
        // Only track allowlisted meshes (or all, when no allowlist is given).
        const target =
          mesh !== undefined && (!hoverMeshAllowlist || hoverMeshAllowlist.has(mesh))
            ? mesh
            : undefined;
        if (target === hoverMesh) return;
        flushHover(now);
        if (target !== undefined) {
          hoverMesh = target;
          hoverStartMs = now;
          hoverActed = false;
          hoverSource = source;
        }
      };

      const onPointerMove = (raw: unknown) => {
        if (!want.pointerMove && !want.hoverDwell) return;
        const now = ctx.now();
        if (now - lastPointerMove < pointerThrottleMs) return;
        lastPointerMove = now;
        const ev = raw as PointerEventView;
        const screen = screenOf(ev);
        const source = pointerSource(ev);
        // Picking is async; emit once the hit resolves (moves are throttled, so
        // this stays bounded). A late resolution after stop is dropped.
        void resolveHit(ev).then(({ hitPoint, hitMesh }) => {
          if (disposed) return;
          if (want.hoverDwell) trackHover(now, hitMesh, source);
          if (want.pointerMove) {
            ctx.emit({
              type: "pointer_move",
              screen,
              ...(hitPoint ? { hitPoint } : {}),
              ...(hitMesh ? { hitMesh } : {}),
              ...(source ? { source } : {}),
            });
          }
        });
      };

      // Hover-acted detection: a press on the hovered object marks the episode as
      // deliberate engagement (suppressed). One GPU pick per press is cheap (presses
      // are infrequent, unlike moves).
      const onHoverActed = (raw: unknown) => {
        if (!want.hoverDwell) return;
        void resolveHit(raw as PointerEventView).then(({ hitMesh }) => {
          if (disposed) return;
          if (hitMesh !== undefined && hitMesh === hoverMesh) hoverActed = true;
        });
      };

      const emitButton = (type: "pointer_down" | "pointer_up", raw: unknown) => {
        if (!want.buttons) return;
        const ev = raw as PointerEventView;
        // Button transitions emit screen + button + source without a GPU pick, to
        // bound the number of async readbacks (a press/drag fires rapidly).
        ctx.emit({
          type,
          screen: screenOf(ev),
          ...(typeof ev.button === "number" ? { button: ev.button } : {}),
          ...(pointerSource(ev) ? { source: pointerSource(ev) } : {}),
        });
      };

      // camera_gesture (ADR 0025): bracket the press and classify the viewpoint
      // change between down and up. No GPU pick and no mesh — a navigation gesture
      // is not an object interaction.
      const onGestureDown = (raw: unknown) => {
        gestureStart = {
          sample: readGestureSample(camera),
          ts: ctx.now(),
          source: pointerSource(raw as PointerEventView),
        };
      };
      const onGestureUp = () => {
        const opened = gestureStart;
        gestureStart = null;
        if (!opened) return;
        // Hand the start→end bracket to the aggregator; the (pure) classification
        // math runs there, main-thread or in the worker (#10).
        snapshot({
          channel: "gesture",
          start: opened.sample,
          end: readGestureSample(camera),
          durationMs: Math.max(0, Math.round(ctx.now() - opened.ts)),
          options: { sensitivity: cameraGestureSensitivity },
          ...(opened.source ? { source: opened.source } : {}),
        });
      };

      const onClick = (raw: unknown) => {
        if (!(want.clicks || want.meshPicks || want.hoverDwell)) return;
        const ev = raw as PointerEventView;
        const screen = screenOf(ev);
        const source = pointerSource(ev);
        const button = typeof ev.button === "number" ? ev.button : undefined;
        void resolveHit(ev).then(({ hitPoint, hitMesh }) => {
          if (disposed) return;
          // A click on the hovered object marks the episode as acted-on (suppressed).
          if (want.hoverDwell && hitMesh !== undefined && hitMesh === hoverMesh) {
            hoverActed = true;
          }
          if (want.clicks) {
            ctx.emit({
              type: "pointer_click",
              screen,
              ...(hitPoint ? { hitPoint } : {}),
              ...(hitMesh ? { hitMesh } : {}),
              ...(button !== undefined ? { button } : {}),
              ...(source ? { source } : {}),
            });
          }
          if (want.meshPicks && hitMesh) {
            ctx.emit({
              type: "mesh_interaction",
              mesh: hitMesh,
              kind: "pick",
              ...(hitPoint ? { point: hitPoint } : {}),
              ...(source ? { source } : {}),
            });
          }
        });
      };

      if (want.pointerMove || want.hoverDwell) addListener("pointermove", onPointerMove);
      if (want.buttons) {
        addListener("pointerdown", (e) => emitButton("pointer_down", e));
        addListener("pointerup", (e) => emitButton("pointer_up", e));
      }
      if (want.hoverDwell) addListener("pointerdown", onHoverActed);
      if (want.cameraGesture) {
        addListener("pointerdown", onGestureDown);
        addListener("pointerup", onGestureUp);
      }
      if (want.clicks || want.meshPicks || want.hoverDwell) addListener("click", onClick);

      // Trailing flush: report an in-progress hover episode on stop.
      if (want.hoverDwell) stopCallbacks.push(() => flushHover(ctx.now()));

      // GPU / memory footprint (`resource_sample`, #44). A low-rate timer samples
      // the JS heap. Lite exposes no schema-mapped GPU geometry counters on its
      // public surface (its `drawCallCount` has no matching `resource_sample`
      // field), so only the JS heap is reported — and only on Chromium, where
      // `performance.memory` exists. Nothing is emitted when nothing is measurable.
      if (want.resourceSample) {
        const sampleResources = () => {
          const sample: { jsHeapBytes?: number } = {};
          const mem = (
            globalThis as unknown as { performance?: { memory?: { usedJSHeapSize?: number } } }
          ).performance?.memory;
          if (mem && typeof mem.usedJSHeapSize === "number" && mem.usedJSHeapSize > 0) {
            sample.jsHeapBytes = mem.usedJSHeapSize;
          }
          if (Object.keys(sample).length === 0) return;
          ctx.emit({ type: "resource_sample", ...sample });
        };
        timers.push(setInterval(sampleResources, resourceIntervalMs));
      }

      return {
        stop() {
          // Run trailing flushes (windowed/episodic captures) before teardown.
          for (const cb of stopCallbacks) cb();
          stopCallbacks.length = 0;
          disposed = true;
          for (const t of timers) clearInterval(t);
          timers.length = 0;
          frameCallbacks.length = 0;
          for (const l of domListeners) canvasView.removeEventListener(l.type, l.handler);
          domListeners.length = 0;
          if (picker && ownsPicker) picker.dispose();
        },
      };
    },
  };
}
