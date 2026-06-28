import type {
  AbstractMesh,
  Camera,
  KeyboardInfo,
  Observer,
  PointerInfo,
  Scene,
  TransformNode,
} from "@babylonjs/core";
import type {
  AggregatorConfig,
  CameraGestureSample,
  CameraPose,
  Collector,
  CollectorContext,
  CollectorHandle,
  NodeSample,
  NodeSamplingConfig,
  ResolvedCadence,
  SampleRate,
  SamplingProfile,
  VisibilityMeshObservation,
} from "@uptimizr/sdk-core";
import { poseUnchanged, resolveCadence, wireGpuDeviceLost } from "@uptimizr/sdk-core";
import type { GpuDeviceLostLike } from "@uptimizr/sdk-core";
import type { Aabb, InputSource } from "@uptimizr/schema";
import { resolveTrackedCamera } from "./scene.js";
import { clamp01, toVec3, toQuat } from "./vec.js";

/**
 * Map a DOM pointer's `pointerType` to an Uptimizr {@link InputSource} (ADR
 * 0011). Babylon forwards the originating browser event, so a stylus click and a
 * finger tap are distinguishable without any extra wiring. The three DOM values
 * (`mouse` / `pen` / `touch`) map straight through; anything else is `other`.
 * Returns `undefined` when the source is unknown so the field stays unset.
 */
function pointerSource(info: PointerInfo): InputSource | undefined {
  const pointerType = (info.event as { pointerType?: string } | undefined)?.pointerType;
  if (pointerType === "mouse" || pointerType === "pen" || pointerType === "touch") {
    return pointerType;
  }
  return typeof pointerType === "string" && pointerType.length > 0 ? "other" : undefined;
}

/**
 * True when the rendering canvas currently holds the browser Pointer Lock (ADR
 * 0034). While locked the OS cursor is hidden and `scene.pointerX/Y` freeze, so
 * the connector treats the crosshair (viewport centre) as the pointer. `getCanvas`
 * is read lazily and only when a lock is actually held, so headless capture (no
 * `document`) and engines without a canvas are never touched.
 */
function isPointerLocked(getCanvas: () => unknown): boolean {
  if (typeof document === "undefined") return false;
  const locked = document.pointerLockElement;
  return locked != null && (locked as unknown) === getCanvas();
}

/**
 * Babylon's `PointerEventTypes` bit flags, mirrored locally so this connector has
 * no runtime dependency on `@babylonjs/core` (it stays a peer dependency).
 * Values match Babylon's `Events/pointerEvents.ts`.
 */
const POINTER = {
  DOWN: 0x01,
  UP: 0x02,
  MOVE: 0x04,
  PICK: 0x10,
  TAP: 0x20,
} as const;

/**
 * Babylon's `KeyboardEventTypes` flags, mirrored locally so this connector keeps
 * `@babylonjs/core` a peer dependency. Values match Babylon's
 * `Events/keyboardEvents.ts`.
 */
const KEYBOARD = {
  KEYDOWN: 0x01,
  KEYUP: 0x02,
} as const;

/** Which signals the collector captures. All default to `true`. */
export interface BabylonCaptureOptions {
  camera?: boolean;
  pointerMove?: boolean;
  clicks?: boolean;
  /** Raw `pointer_down` / `pointer_up` button transitions (press-and-hold, drags). */
  buttons?: boolean;
  /**
   * Typed `camera_gesture` navigation capture (ADR 0025). **On by default**: it
   * separates navigation intent (orbit/pan/dolly/zoom/roll/fly) from object
   * selection so click/mesh heatmaps stay clean, costs only a snapshot+diff per
   * gesture, and carries no PII (a kind + magnitudes + duration, no mesh).
   */
  cameraGesture?: boolean;
  meshPicks?: boolean;
  perf?: boolean;
  /**
   * Per-object dwell / attention capture (`mesh_visibility`, #37). **Opt-in,
   * off by default** (privacy, ADR 0003): emits one bucketed summary per tracked
   * object per window (ADR 0012), never per frame. Configure via
   * {@link BabylonCollectorOptions.meshVisibility}.
   */
  meshVisibility?: boolean;
  /**
   * Hover-hesitation capture (`hover_dwell`, #48). **Opt-in, off by default**
   * (privacy, ADR 0003): emits one bucketed summary per hover episode (ADR
   * 0012) when the pointer lingers on an object *without acting on it* — the
   * "users don't realize this is interactive" signal. Configure via
   * {@link BabylonCollectorOptions.hoverDwell}.
   */
  hoverDwell?: boolean;
  /**
   * World-space gaze raycast (`camera_sample.hitPoint`/`hitMesh`, ADR 0030).
   * **Opt-in, off by default** (privacy + cost, ADR 0003 / ADR 0012): when
   * enabled, each emitted `camera_sample` is augmented with the surface point the
   * camera-forward (gaze) ray hits — the "what did people actually look at"
   * signal that powers the world-space gaze heatmap, valuable for orbit/viewer,
   * first-person, and XR scenes alike. The pick rides the existing camera cadence
   * (one pick per emitted pose, skipped when idle-suppressed) and never runs at
   * frame rate. Configure via {@link BabylonCollectorOptions.gaze}.
   */
  gaze?: boolean;
  /** Engine GPU `context_lost` / `context_restored` transitions. */
  contextLoss?: boolean;
  /**
   * Shader / pipeline compile-stall capture (`compile_stall`, #42). **On by
   * default** (design §C): compilation is the #1 source of first-interaction
   * hitches, is a bounded mostly-first-load cost, and carries no PII (just a
   * duration + coarse phase). Times Babylon's main-thread shader-compilation
   * span (`onBeforeShaderCompilationObservable` → `onAfterShaderCompilationObservable`).
   */
  compileStall?: boolean;
  /**
   * GPU / memory footprint capture (`resource_sample`, #44). **Opt-in, off by
   * default** (privacy + cost, ADR 0003): emits one low-rate summary sample per
   * window (ADR 0012) of the renderer's resident texture/geometry bytes, the
   * triangles/vertices submitted, and the JS heap size. Configure cadence via
   * {@link BabylonCollectorOptions.resourceSample}.
   */
  resourceSample?: boolean;
  /**
   * Keyboard `input_action` capture (ADR 0023). **Off unless `keyBindings` is
   * provided** — only explicitly bound keys are recorded, never arbitrary
   * typing (privacy, ADR 0003). Set `false` to disable even when bindings exist.
   */
  keyboard?: boolean;
  /**
   * Scene-actor transform capture (`node_transform`, ADR 0027 Tier 1). **Off
   * unless `actors` + `sampling.nodes` are provided** — captures the world
   * transform of developer-named moving nodes (an NPC, door, elevator) so replay
   * can reproduce their motion. Set `false` to disable even when actors exist.
   */
  nodes?: boolean;
  /**
   * Skeleton-bone transform capture (`node_transform` with `boneId`, ADR 0027
   * **Tier 2**). **Off unless `actors` + `sampling.bones` are provided** —
   * captures the skeleton-local pose of allowlisted bones on a rigged actor so
   * replay can reproduce articulation (a wave, a head turn). Higher cost and
   * privacy than Tier 1 (full-body gait is biometric-adjacent). Set `false` to
   * disable even when bone sampling is configured.
   */
  bones?: boolean;
}

export interface BabylonCollectorOptions {
  /** The Babylon scene to instrument. */
  scene: Scene;
  /**
   * Camera to record for the view-direction / pose timeline. Defaults to
   * `scene.activeCamera` (falling back to the first of `scene.activeCameras`).
   *
   * **Set this for multi-camera scenes** — picture-in-picture insets,
   * split-screen, or render-target rigs — where `scene.activeCamera` is
   * ambiguous and may resolve to a secondary/inset camera. Recording the wrong
   * camera produces a constant, incorrect pose (e.g. the gaze heatmap collapses
   * to a single direction and replay starts from the wrong viewpoint), so pass
   * the camera the viewer actually flies.
   */
  camera?: Camera;
  /** Camera-pose sampling interval in ms. Default 1000. */
  sampleCameraMs?: number;
  /** Performance (FPS) sampling interval in ms. Default 2000. */
  samplePerfMs?: number;
  /**
   * Frame-time threshold in ms above which a frame counts as a "long frame"
   * (jank) for `frame_perf.longFrames` (#41). Default 50 (≈ below 20fps — a
   * felt stall). Frame times are accumulated every render tick and summarised
   * (p95 / p99 / long-frame count) once per perf sample window.
   */
  jankFrameMs?: number;
  /** Minimum gap between `pointer_move` samples in ms. Default 250. */
  pointerMoveThrottleMs?: number;
  /**
   * Sensitivity dial for `camera_gesture` classification (ADR 0025). Scales every
   * motion dead-zone together: `> 1` is less sensitive (ignores smaller moves),
   * `< 1` more. Default 1.
   */
  cameraGestureSensitivity?: number;
  /**
   * Per-channel capture-fidelity dial in Hz / `"frame"` / `0`-off (ADR 0012).
   * Governs continuous channels only (camera pose, pointer move, perf); discrete
   * events are always captured. When a channel is set here it overrides the
   * matching legacy ms knob above; omitted channels keep the conservative
   * defaults. There is no enforced upper bound — `"frame"` captures every tick.
   */
  sampling?: SamplingProfile;
  /**
   * Skip timer-based **camera** samples when the pose is unchanged (within
   * {@link cameraEpsilon}). The first sample is always emitted so the timeline
   * has a baseline. Default `true` — a redundant pose carries no information.
   *
   * Note: this governs the camera channel only. Perf samples are kept even when
   * steady (see {@link suppressIdlePerfSamples}), because a stable FPS is itself
   * meaningful telemetry.
   */
  suppressIdleSamples?: boolean;
  /**
   * Skip timer-based `frame_perf` samples when FPS is unchanged (within
   * {@link perfFpsThreshold}). Default `false` — a steady FPS is meaningful
   * telemetry, so the perf channel reports continuously. Set `true` to dedupe a
   * stable FPS and emit only on change.
   */
  suppressIdlePerfSamples?: boolean;
  /** Max per-axis pose change treated as "unchanged" for camera dedupe. Default 1e-3. */
  cameraEpsilon?: number;
  /** Max FPS change treated as "unchanged" for perf dedupe. Default 1. */
  perfFpsThreshold?: number;
  /** Toggle individual capture channels. */
  capture?: BabylonCaptureOptions;
  /**
   * Keyboard bindings to capture as `input_action` events (ADR 0023): a map from
   * `KeyboardEvent.code` (e.g. `"KeyW"`, `"ArrowLeft"`) to a semantic app action
   * (e.g. `"move-forward"`). **Only bound keys are recorded** — unbound keys are
   * ignored so arbitrary typing is never captured (privacy, ADR 0003). Auto-
   * repeat (held keys) is suppressed; each press and release emits once.
   */
  keyBindings?: Record<string, string>;
  /**
   * Per-object dwell / attention capture configuration (`mesh_visibility`, #37).
   * Only used when `capture.meshVisibility` is enabled (it is off by default —
   * privacy, ADR 0003). Each window the connector emits one bucketed summary per
   * tracked object (ADR 0012): on-screen time, time spent near the view centre
   * (a gaze proxy), and the max screen fraction reached (a prominence proxy).
   */
  meshVisibility?: MeshVisibilityOptions;
  /**
   * Hover-hesitation capture configuration (`hover_dwell`, #48). Only used when
   * `capture.hoverDwell` is enabled (off by default — privacy, ADR 0003). One
   * bucketed summary is emitted per hover episode (ADR 0012) when the pointer
   * lingers on an object beyond {@link HoverDwellOptions.minDwellMs} without
   * clicking it.
   */
  hoverDwell?: HoverDwellOptions;
  /**
   * World-space gaze raycast configuration (`camera_sample.hitPoint`/`hitMesh`,
   * ADR 0030). Only used when `capture.gaze` is enabled (off by default —
   * privacy + cost, ADR 0003 / ADR 0012). Each emitted camera sample raycasts the
   * camera-forward ray into the scene and attaches the surface hit, powering the
   * world-space gaze heatmap. Use {@link GazeOptions.meshes} / {@link
   * GazeOptions.predicate} to exclude ground/skybox/helper meshes and bound
   * `hitMesh` cardinality.
   */
  gaze?: GazeOptions;
  /**
   * GPU / memory footprint capture configuration (`resource_sample`, #44). Only
   * used when `capture.resourceSample` is enabled (off by default — privacy +
   * cost, ADR 0003). One low-rate summary sample is emitted per window (ADR
   * 0012).
   */
  resourceSample?: ResourceSampleOptions;
  /**
   * Scene-actor map for `node_transform` capture (ADR 0027 Tier 1): developer
   * id → Babylon node. Accepts a **resolver function** `() => node | null`
   * (preferred — robust to load order and clones), an **engine name string** the
   * connector looks up (`getMeshByName` / `getTransformNodeByName`), or a
   * **direct node reference**. Only ids that ALSO appear in `sampling.nodes` are
   * sampled (default OFF); the resolved node's world transform is read each tick
   * and emitted as a `node_transform`. Cameras are refused (the visitor camera is
   * already `camera_sample` — "events live once"). Re-resolved lazily when a
   * resolver returns null.
   */
  actors?: Record<string, BabylonActor>;
}

/** A Babylon node that exposes a world transform (a `node_transform` actor, ADR 0027). */
export type BabylonActorNode = TransformNode | AbstractMesh;

/**
 * How a developer declares a scene actor (ADR 0027 §6): a resolver function
 * (preferred), an engine name/id string the connector looks up, or a direct
 * Babylon node reference. The value type is engine-specific — exactly like the
 * existing `scene`/`camera` args differ per connector.
 */
export type BabylonActor = (() => BabylonActorNode | null | undefined) | string | BabylonActorNode;

/** GPU / memory footprint capture options (`resource_sample`, #44). */
export interface ResourceSampleOptions {
  /**
   * Sampling interval in ms — one footprint summary per window (ADR 0012). The
   * footprint moves slowly, so the default is deliberately low-rate. Default
   * 15000 (every 15s).
   */
  intervalMs?: number;
}

/** Per-object dwell capture options (`mesh_visibility`, #37). */
export interface MeshVisibilityOptions {
  /** Summary window length in ms — one event per object per window. Default 5000. */
  windowMs?: number;
  /**
   * Allowlist of mesh names to track (low-cardinality, app-defined — ADR 0003).
   * When omitted, every enabled, vertex-bearing, non-overlay mesh is tracked,
   * capped by {@link maxMeshes}. Provide this for big scenes to bound per-frame
   * cost and keep `mesh` cardinality meaningful.
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
   * default (extra volume + discloses layout, ADR 0003). The box is sent once
   * per object and re-sent only when it moves/resizes beyond a small epsilon
   * (bounds are near-static), never every window.
   */
  boundingBox?: boolean;
}

/** Hover-hesitation capture options (`hover_dwell`, #48). */
export interface HoverDwellOptions {
  /**
   * Minimum uninterrupted hover time in ms before an episode is reported. Short
   * pass-overs aren't hesitation, so they're dropped. Default 500.
   */
  minDwellMs?: number;
  /**
   * Allowlist of mesh names to track (low-cardinality, app-defined — ADR 0003).
   * When omitted, hover over any picked mesh is tracked. Provide this to keep
   * `mesh` cardinality meaningful on big scenes.
   */
  meshes?: string[];
}

/** World-space gaze raycast options (`camera_sample.hitPoint`/`hitMesh`, ADR 0030). */
export interface GazeOptions {
  /**
   * Max gaze-ray length in world units. Caps how far a gaze ray reaches before it
   * counts as a miss, so a glance into open sky doesn't pick a distant helper.
   * Default 1000.
   */
  maxDistance?: number;
  /**
   * Allowlist of mesh names eligible for a gaze hit (low-cardinality, app-defined
   * — ADR 0003). When omitted, any pickable mesh can be hit. Provide this to keep
   * `hitMesh` cardinality meaningful and to exclude ground/skybox/helper meshes.
   */
  meshes?: string[];
  /**
   * Predicate escape hatch: return `false` to exclude a mesh from gaze picking
   * (e.g. skybox, ground, gizmos). Combined with {@link meshes} (a mesh must pass
   * both the allowlist, if any, and the predicate, if any).
   */
  predicate?: (mesh: AbstractMesh) => boolean;
}

interface CameraView {
  globalPosition: { x: number; y: number; z: number };
  getForwardRay(length?: number): { direction: { x: number; y: number; z: number } };
  fov?: number;
  /** Near-plane distance (`Camera.minZ`); used to reconstruct flat-pointer ray origins (issue #22). */
  minZ?: number;
  getTarget?: () => { x: number; y: number; z: number };
}

/**
 * Structural view of the engine's `getAspectRatio` used to capture the viewport
 * aspect on each `camera_sample` (issue #22). Typed structurally so the connector
 * keeps `@babylonjs/core` a peer dependency (no runtime import).
 */
interface EngineWithAspectRatio {
  getAspectRatio(viewportOwner: unknown, useScreen?: boolean): number;
}

/**
 * Capture the camera's projection intrinsics (vertical `fov` + viewport `aspect`
 * + near-plane `near`) when available, so flat-pointer click rays can later be
 * unprojected onto the near plane (issue #22). Each field is omitted when the
 * engine/camera doesn't expose a finite, positive value, keeping the sample
 * faithful and the schema fields optional.
 */
function readCameraIntrinsics(
  scene: Scene,
  cam: Camera,
): { fov?: number; aspect?: number; near?: number } {
  const view = cam as unknown as CameraView;
  const out: { fov?: number; aspect?: number; near?: number } = {};
  if (typeof view.fov === "number" && Number.isFinite(view.fov)) out.fov = view.fov;
  const engine = scene.getEngine() as unknown as Partial<EngineWithAspectRatio>;
  if (typeof engine.getAspectRatio === "function") {
    const aspect = engine.getAspectRatio(cam);
    if (Number.isFinite(aspect) && aspect > 0) out.aspect = aspect;
  }
  if (typeof view.minZ === "number" && Number.isFinite(view.minZ) && view.minZ > 0) {
    out.near = view.minZ;
  }
  return out;
}

/**
 * Minimal structural view of the scene's ray-picking API used for gaze raycasts
 * (ADR 0030). `getForwardRay` returns a Babylon `Ray`; `pickWithRay` consumes it
 * and reports the nearest surface hit. Typed structurally so the connector keeps
 * `@babylonjs/core` a peer dependency (no runtime import).
 */
interface GazePickInfo {
  hit?: boolean;
  pickedPoint?: { x: number; y: number; z: number } | null;
  pickedMesh?: { name: string } | null;
}
interface ScenePicker {
  pickWithRay(ray: unknown, predicate?: (mesh: AbstractMesh) => boolean): GazePickInfo | null;
}

/**
 * Raycast a camera's forward (gaze) ray into the scene and return the surface hit
 * (ADR 0030), mirroring how pointer events resolve `hitPoint`/`hitMesh`. Returns
 * an empty object on a miss so the fields stay unset.
 */
function sampleGaze(
  scene: Scene,
  cam: Camera,
  maxDistance: number,
  predicate: ((mesh: AbstractMesh) => boolean) | undefined,
): { hitPoint?: Vec3; hitMesh?: string } {
  const ray = (cam as unknown as { getForwardRay(length?: number): unknown }).getForwardRay(
    maxDistance,
  );
  const pick = (scene as unknown as ScenePicker).pickWithRay(ray, predicate);
  const hitPoint = pick?.hit && pick.pickedPoint ? toVec3(pick.pickedPoint) : undefined;
  const hitMesh = pick?.hit && pick.pickedMesh ? pick.pickedMesh.name : undefined;
  return { ...(hitPoint ? { hitPoint } : {}), ...(hitMesh ? { hitMesh } : {}) };
}

function readTarget(camera: Camera): [number, number, number] | undefined {
  const c = camera as unknown as CameraView;
  if (typeof c.getTarget === "function") {
    const t = c.getTarget();
    if (t) return toVec3(t);
  }
  return undefined;
}

/**
 * Structural view of the extra camera fields the gesture classifier (ADR 0025)
 * reads beyond {@link CameraView}: the up vector (for roll) and an arc-rotate
 * radius (an explicit camera-to-pivot distance, which makes pan/orbit unambiguous).
 */
interface GestureCameraView extends CameraView {
  upVector?: { x: number; y: number; z: number };
  radius?: number;
}

/**
 * Snapshot a Babylon camera into an engine-agnostic {@link CameraGestureSample}
 * (ADR 0025). Babylon's world frame is already the canonical frame (ADR 0018), so
 * no coordinate conversion is needed. `target`/`radius` are present for
 * `ArcRotateCamera` (giving an explicit pivot + distance); other cameras provide
 * position + forward (+ up + fov), and the classifier infers a pivot from the
 * view rays when one is not supplied.
 */
function readGestureSample(camera: Camera): CameraGestureSample {
  const c = camera as unknown as GestureCameraView;
  const sample: CameraGestureSample = {
    position: toVec3(c.globalPosition),
    forward: toVec3(c.getForwardRay().direction),
  };
  if (c.upVector) sample.up = toVec3(c.upVector);
  const target = readTarget(camera);
  if (target && typeof c.radius === "number") {
    sample.pivot = target;
    sample.distance = c.radius;
  }
  if (typeof c.fov === "number") sample.fov = c.fov;
  return sample;
}

type Vec3 = [number, number, number];

/** Minimal shape of a Babylon `Observable` used for context-loss wiring. */
interface MinimalObservable<T> {
  add(cb: (eventData: T) => void): unknown;
  remove(observer: unknown): unknown;
}

/** Structural view of the engine observables this collector subscribes to. */
interface EngineWithContextObservables {
  onContextLostObservable?: MinimalObservable<unknown>;
  onContextRestoredObservable?: MinimalObservable<unknown>;
}

/**
 * Structural view of a Babylon WebGPU engine's underlying `GPUDevice`. Babylon's
 * `WebGPUEngine` keeps the device on the internal `_device` field; we read it
 * structurally (it isn't on the public surface and differs from the WebGL engine)
 * to keep `@babylonjs/core` a peer dependency. `isWebGPU` gates the read so the
 * WebGL engine — which has no device-lost concept — is never touched.
 */
interface EngineWithWebGpuDevice {
  isWebGPU?: boolean;
  _device?: GpuDeviceLostLike;
}

/**
 * Structural view of the engine's shader-compilation observables (#42). Babylon
 * raises `onBeforeShaderCompilationObservable` just before, and
 * `onAfterShaderCompilationObservable` just after, it compiles a shader on the
 * main thread — the span we time as a `compile_stall`.
 */
interface EngineWithShaderCompilation {
  onBeforeShaderCompilationObservable?: MinimalObservable<unknown>;
  onAfterShaderCompilationObservable?: MinimalObservable<unknown>;
}

/**
 * Minimal structural view of a Babylon node we read a world transform from. We
 * deliberately avoid calling Babylon at runtime (it stays a peer dependency), so
 * we describe only the members we touch and read them defensively.
 */
interface WorldTransformNode {
  computeWorldMatrix?: (force?: boolean) => unknown;
  absolutePosition?: { x: number; y: number; z: number };
  absoluteRotationQuaternion?: { x: number; y: number; z: number; w: number };
  absoluteScaling?: { x: number; y: number; z: number };
  getClassName?: () => string;
  name?: string;
  /** `Node.getChildren()` — direct descendants, walked for Tier-1 subtree capture (ADR 0033). */
  getChildren?: () => WorldTransformNode[];
}

/** Resolved Tier-1 subtree-capture configuration for one actor (ADR 0033). */
interface SubtreeConfig {
  include: string[] | "*";
  maxDepth: number;
  maxNodes: number;
  exclude: Set<string>;
}

/** A descendant selected for subtree capture, with its `/`-joined path from the actor. */
interface CapturedChild {
  childPath: string;
  node: WorldTransformNode;
}

/**
 * Derive the per-tick capture rate from a `sampling.nodes` entry, which is either
 * a bare {@link SampleRate} (root-only, ADR 0027) or a {@link NodeSamplingConfig}
 * whose `hz` carries the rate (subtree, ADR 0033).
 */
function nodeRate(entry: SampleRate | NodeSamplingConfig | undefined): SampleRate | undefined {
  if (entry !== null && typeof entry === "object") return entry.hz;
  return entry;
}

/**
 * Resolve a `sampling.nodes` entry into a {@link SubtreeConfig}, or `null` when it
 * is a bare rate or declares no `include` (root-only). Applies the ADR 0033 caps
 * (`maxDepth` 8, `maxNodes` 64) and normalises `exclude` to a set.
 */
function nodeSubtree(entry: SampleRate | NodeSamplingConfig | undefined): SubtreeConfig | null {
  if (entry === null || typeof entry !== "object") return null;
  const include = entry.include;
  const ok = include === "*" || (Array.isArray(include) && include.length > 0);
  if (!ok) return null;
  return {
    include: include as string[] | "*",
    maxDepth: entry.maxDepth ?? 8,
    maxNodes: entry.maxNodes ?? 64,
    exclude: new Set(entry.exclude ?? []),
  };
}

/**
 * Breadth-first walk of an actor's descendants for Tier-1 subtree capture (ADR
 * 0033). Visits transform nodes only — cameras are refused (and not descended,
 * "events live once") and excluded names prune their subtree. Each kept node is
 * returned with its `/`-joined path from the actor (matched by name on replay).
 * The walk is bounded by `maxDepth`/`maxNodes` with deterministic FIFO
 * truncation so a deep/wide hierarchy cannot blow up the wire.
 */
function collectSubtree(root: WorldTransformNode, cfg: SubtreeConfig): CapturedChild[] {
  const out: CapturedChild[] = [];
  const includeAll = cfg.include === "*";
  const includeSet = includeAll ? null : new Set(cfg.include as string[]);
  const queue: Array<{ node: WorldTransformNode; path: string; depth: number }> = [];
  for (const child of root.getChildren?.() ?? []) {
    queue.push({ node: child, path: child.name ?? "", depth: 1 });
  }
  while (queue.length > 0 && out.length < cfg.maxNodes) {
    const { node, path, depth } = queue.shift()!;
    const name = node.name;
    if (typeof name !== "string" || name.length === 0) continue;
    if (cfg.exclude.has(name)) continue; // prune the whole subtree
    if (isCameraNode(node)) continue; // refuse cameras and don't descend
    if (includeAll || includeSet!.has(name)) out.push({ childPath: path, node });
    if (depth < cfg.maxDepth) {
      for (const child of node.getChildren?.() ?? []) {
        const cn = child.name ?? "";
        queue.push({ node: child, path: path ? `${path}/${cn}` : cn, depth: depth + 1 });
      }
    }
  }
  return out;
}

/** True when `node` is (or extends) a camera — refused for `node_transform` (ADR 0027 §7). */
function isCameraNode(node: WorldTransformNode): boolean {
  const name = node.getClassName?.();
  return typeof name === "string" && name.includes("Camera");
}

/**
 * Read a node's world transform into a `node_transform` sample. Forces a world-
 * matrix refresh so the read reflects the current frame, then reads the absolute
 * (world-frame) position/rotation/scale. Scale is omitted when it is identity so
 * the common static-scale case stays off the wire (ADR 0027).
 */
function readNodeTransform(node: WorldTransformNode, scaleEps: number): NodeSample {
  node.computeWorldMatrix?.(true);
  const p = node.absolutePosition ?? { x: 0, y: 0, z: 0 };
  const q = node.absoluteRotationQuaternion ?? { x: 0, y: 0, z: 0, w: 1 };
  const sample: NodeSample = { position: toVec3(p), rotation: toQuat(q) };
  const s = node.absoluteScaling;
  if (
    s &&
    (Math.abs(s.x - 1) > scaleEps || Math.abs(s.y - 1) > scaleEps || Math.abs(s.z - 1) > scaleEps)
  ) {
    sample.scale = toVec3(s);
  }
  return sample;
}

/** Structural view of a Babylon `Bone` whose skeleton-local pose Tier 2 reads. */
interface BoneNode {
  name?: string;
  /** `Bone.getLocalMatrix()` — the live local transform relative to the parent bone. */
  getLocalMatrix?: () => { m?: ArrayLike<number> } | null | undefined;
}

/** Structural view of a skinned node carrying a skeleton (Tier 2 source). */
interface SkinnedNode {
  skeleton?: { bones?: BoneNode[] } | null;
}

/**
 * Read a bone's **skeleton-local** matrix as a fresh, owned 16-float column-major
 * `Float32Array` (ADR 0027 Tier 2). The aggregator decomposes it into
 * position/rotation/scale (the offload-eligible math, #10) — keeping the bone's
 * live Babylon matrix untouched (the copy is what gets transferred to the worker).
 * Returns `null` when the bone exposes no readable local matrix.
 */
function readBoneMatrix(bone: BoneNode): Float32Array | null {
  const local = bone.getLocalMatrix?.();
  const m = local?.m;
  if (!m || m.length < 16) return null;
  return Float32Array.from(m as ArrayLike<number>);
}

/**
 * Resolve the bones to capture for one actor: the allowlisted names in order, or
 * — for the explicit `"*"` wildcard — every bone in the skeleton. Bones without a
 * name are skipped. Returns an empty array when the node has no skeleton.
 */
function resolveBones(node: SkinnedNode, include: string[] | "*"): BoneNode[] {
  const bones = node.skeleton?.bones;
  if (!bones || bones.length === 0) return [];
  if (include === "*") return bones.filter((b) => typeof b.name === "string");
  const byName = new Map<string, BoneNode>();
  for (const b of bones) if (typeof b.name === "string") byName.set(b.name, b);
  const out: BoneNode[] = [];
  for (const name of include) {
    const bone = byName.get(name);
    if (bone) out.push(bone);
  }
  return out;
}

/** Minimal structural view of the scene lookups used to resolve a named actor. */
interface ActorLookupScene {
  getMeshByName?: (name: string) => unknown;
  getTransformNodeByName?: (name: string) => unknown;
}

/**
 * Resolve a declared {@link BabylonActor} to a live node, or `null` when it is
 * not (yet) in the scene. A function is called each time (robust to load order
 * and disposal); a string is looked up by mesh name then transform-node name; a
 * direct reference is returned as-is.
 */
function resolveActorNode(scene: ActorLookupScene, actor: BabylonActor): WorldTransformNode | null {
  if (typeof actor === "function") {
    return (actor() as WorldTransformNode | null | undefined) ?? null;
  }
  if (typeof actor === "string") {
    const mesh = scene.getMeshByName?.(actor);
    if (mesh) return mesh as WorldTransformNode;
    const node = scene.getTransformNodeByName?.(actor);
    return node ? (node as WorldTransformNode) : null;
  }
  return (actor as WorldTransformNode | null) ?? null;
}

/**
 * Read a mesh's world-space bounding sphere (centre + radius) and AABB
 * defensively. The AABB (#53) reuses the scene-proxy tuple convention
 * `[minX, minY, minZ, maxX, maxY, maxZ]`.
 */
function readWorldSphere(mesh: {
  getBoundingInfo?: () => unknown;
}): { center: Vec3; radius: number; aabb: Aabb } | null {
  const info = mesh.getBoundingInfo?.() as
    | {
        boundingBox?: {
          minimumWorld?: { x: number; y: number; z: number };
          maximumWorld?: { x: number; y: number; z: number };
        };
      }
    | null
    | undefined;
  const lo = info?.boundingBox?.minimumWorld;
  const hi = info?.boundingBox?.maximumWorld;
  if (!lo || !hi) return null;
  const center: Vec3 = [(lo.x + hi.x) / 2, (lo.y + hi.y) / 2, (lo.z + hi.z) / 2];
  const radius = 0.5 * Math.hypot(hi.x - lo.x, hi.y - lo.y, hi.z - lo.z);
  const aabb: Aabb = [lo.x, lo.y, lo.z, hi.x, hi.y, hi.z];
  return { center, radius, aabb };
}

function sub3(a: Vec3, b: Vec3): Vec3 {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

function dot3(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

/**
 * Create the Babylon connector as an sdk-core {@link Collector}. This is the
 * Babylon-specific extension point: register it with `client.use(...)`.
 *
 * It samples camera pose (view-direction heatmap), pointer movement and clicks
 * (screen heatmaps), mesh picks (object engagement), and FPS (perf). It only
 * reads from the scene — it never mutates it — and tears everything down on stop.
 *
 * Device/GPU capabilities are captured separately via {@link readDeviceCaps}.
 */
export function babylonCollector(options: BabylonCollectorOptions): Collector {
  const {
    scene,
    sampleCameraMs = 1000,
    samplePerfMs = 2000,
    jankFrameMs = 50,
    pointerMoveThrottleMs = 250,
    cameraGestureSensitivity = 1,
    suppressIdleSamples = true,
    suppressIdlePerfSamples = false,
    cameraEpsilon = 1e-3,
    perfFpsThreshold = 1,
    capture = {},
    sampling = {},
  } = options;
  const explicitCamera = options.camera ?? null;
  const keyBindings = options.keyBindings ?? {};
  const hasKeyBindings = Object.keys(keyBindings).length > 0;

  // mesh_visibility (#37) configuration. Capture is opt-in (ADR 0003); the window
  // bucketing follows ADR 0012 — one summary per object per window, never per frame.
  const visOpts = options.meshVisibility ?? {};
  const visWindowMs = visOpts.windowMs ?? 5000;
  const visMeshAllowlist =
    visOpts.meshes && visOpts.meshes.length > 0 ? new Set(visOpts.meshes) : null;
  const visCenteredCos = Math.cos(((visOpts.centeredAngleDeg ?? 12) * Math.PI) / 180);
  const visMaxMeshes = visOpts.maxMeshes ?? 50;
  const visBoundingBox = visOpts.boundingBox ?? false;

  // hover_dwell (#48) configuration. Capture is opt-in (ADR 0003); one bucketed
  // summary per hover episode (ADR 0012), only when dwell exceeds the threshold.
  const hoverOpts = options.hoverDwell ?? {};
  const hoverMinDwellMs = hoverOpts.minDwellMs ?? 500;
  const hoverMeshAllowlist =
    hoverOpts.meshes && hoverOpts.meshes.length > 0 ? new Set(hoverOpts.meshes) : null;

  // Gaze raycast (ADR 0030) configuration. Capture is opt-in (ADR 0003); the pick
  // rides the camera cadence (one per emitted pose), never frame-rate. The
  // predicate combines an optional allowlist with the developer predicate so
  // ground/skybox/helper meshes can be excluded from "what did people look at".
  const gazeOpts = options.gaze ?? {};
  const gazeMaxDistance = gazeOpts.maxDistance ?? 1000;
  const gazeMeshAllowlist =
    gazeOpts.meshes && gazeOpts.meshes.length > 0 ? new Set(gazeOpts.meshes) : null;
  const gazeUserPredicate = gazeOpts.predicate;
  const gazePredicate: ((mesh: AbstractMesh) => boolean) | undefined =
    gazeMeshAllowlist || gazeUserPredicate
      ? (mesh: AbstractMesh) => {
          if (gazeMeshAllowlist && !gazeMeshAllowlist.has(mesh.name)) return false;
          if (gazeUserPredicate && !gazeUserPredicate(mesh)) return false;
          return true;
        }
      : undefined;

  // resource_sample (#44) configuration. Capture is opt-in (ADR 0003); the
  // footprint moves slowly so the cadence is deliberately low-rate (ADR 0012).
  const resourceOpts = options.resourceSample ?? {};
  const resourceIntervalMs = resourceOpts.intervalMs ?? 15000;

  // Resolve each continuous channel's cadence (ADR 0012). An explicit `sampling`
  // entry wins; otherwise we fall back to the legacy ms knob, preserving the old
  // defaults and behavior. A channel resolved to "off" is not captured.
  const cameraCadence = resolveCadence(sampling.camera, sampleCameraMs);
  const perfCadence = resolveCadence(sampling.perf, samplePerfMs);
  const pointerMoveCadence = resolveCadence(sampling.pointerMove, pointerMoveThrottleMs);

  const want = {
    camera: (capture.camera ?? true) && cameraCadence.mode !== "off",
    pointerMove: (capture.pointerMove ?? true) && pointerMoveCadence.mode !== "off",
    clicks: capture.clicks ?? true,
    buttons: capture.buttons ?? true,
    // Typed navigation gestures are on by default (ADR 0025): cheap, no PII, and
    // they keep click/mesh heatmaps free of orbit-drag contamination.
    cameraGesture: capture.cameraGesture ?? true,
    meshPicks: capture.meshPicks ?? true,
    perf: (capture.perf ?? true) && perfCadence.mode !== "off",
    // Per-object dwell is opt-in (privacy, ADR 0003): off unless explicitly enabled.
    meshVisibility: capture.meshVisibility ?? false,
    // Hover hesitation is opt-in (privacy, ADR 0003): off unless explicitly enabled.
    hoverDwell: capture.hoverDwell ?? false,
    // Gaze raycast is opt-in (privacy + cost, ADR 0003 / ADR 0012): off unless
    // enabled, and only meaningful when the camera channel is captured.
    gaze: (capture.gaze ?? false) && (capture.camera ?? true) && cameraCadence.mode !== "off",
    contextLoss: capture.contextLoss ?? true,
    // Compile stalls are on by default (design §C): bounded, mostly first-load,
    // and carry no PII — just a duration + coarse phase.
    compileStall: capture.compileStall ?? true,
    // GPU/memory footprint is opt-in (privacy + cost, ADR 0003): off unless enabled.
    resourceSample: capture.resourceSample ?? false,
    // Keyboard is opt-in: it requires an explicit binding allowlist (ADR 0023).
    keyboard: (capture.keyboard ?? true) && hasKeyBindings,
    // Scene-actor capture is opt-in (ADR 0027): off unless actors are declared
    // AND at least one of them has a sampling rate. Resolved further below.
    nodes: capture.nodes ?? true,
    // Tier-2 bone capture is opt-in (ADR 0027): off unless actors are declared
    // AND at least one has a `sampling.bones` entry. Resolved further below.
    bones: capture.bones ?? true,
  };

  // Scene-actor (`node_transform`, ADR 0027 Tier 1) configuration. Only ids that
  // are BOTH declared in `actors` and given a rate in `sampling.nodes` are
  // tracked (default OFF); each is driven by its own resolved cadence (ADR 0012).
  const actorMap = options.actors ?? {};
  const actorIds = want.nodes
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

  // Tier-2 bone (`node_transform` + `boneId`, ADR 0027) configuration. Only
  // actors declared in `actors` AND given a `sampling.bones` entry with a
  // non-empty allowlist are tracked (default OFF); each is driven by its own
  // resolved cadence. A "*" include is permitted but expensive (the full rig).
  const boneActorIds = want.bones
    ? Object.keys(sampling.bones ?? {}).filter((id) => {
        const declared = Object.prototype.hasOwnProperty.call(actorMap, id);
        if (!declared) {
          console.warn(
            `[uptimizr] sampling.bones["${id}"] has no matching entry in \`actors\`; ` +
              "ignoring. Declare the rigged node in `actors` to capture its bones.",
          );
          return false;
        }
        const cfg = sampling.bones?.[id];
        const include = cfg?.include;
        const ok = include === "*" || (Array.isArray(include) && include.length > 0);
        if (!ok) {
          console.warn(
            `[uptimizr] sampling.bones["${id}"].include is empty; nothing to capture. ` +
              'List bone names or use "*" for the whole rig (explicit, expensive).',
          );
        }
        return ok;
      })
    : [];
  const wantBones = boneActorIds.length > 0;

  // Pointer-move throttle in ms: a fixed interval throttles; "frame" means emit
  // every move (no throttle). Discrete pointer events are never throttled.
  const pointerThrottleMs = pointerMoveCadence.mode === "interval" ? pointerMoveCadence.ms : 0;

  return {
    name: "babylon",
    start(ctx: CollectorContext): CollectorHandle {
      // The engine-agnostic aggregator (#10): the connector reads live engine
      // state into plain-number snapshot DTOs and hands them here; the
      // offload-eligible math (percentiles, matrix decompose, visibility
      // bucketing, idle-diffs, gesture classification) runs main-thread by
      // default or inside the offload worker, behind the client `offload` flag.
      const aggregatorConfig: AggregatorConfig = {
        perf: { suppressIdle: suppressIdlePerfSamples, fpsThreshold: perfFpsThreshold },
        node: { suppressIdle: suppressIdleSamples },
        visibility: { centeredCos: visCenteredCos, boundingBox: visBoundingBox, boundsEps: 1e-3 },
      };
      const snapshot = ctx.createAggregation(aggregatorConfig);
      const timers: ReturnType<typeof setInterval>[] = [];
      const renderObservers: Array<() => void> = [];
      let pointerObserver: Observer<PointerInfo> | null = null;
      let keyboardObserver: Observer<KeyboardInfo> | null = null;
      // device.lost is a one-shot promise that can't be unsubscribed; this flag
      // lets us suppress a late-resolving emit after the collector has stopped.
      let stopped = false;
      let lastPointerMove = 0;
      // camera_gesture (ADR 0025) bracket state: the camera snapshot taken at
      // pointer-down, the time it opened, and the input source — diffed against
      // the pointer-up snapshot to classify the navigation gesture.
      let gestureStart: { sample: CameraGestureSample; ts: number; source?: InputSource } | null =
        null;
      // hover_dwell (#48) episode state: the object currently under the pointer,
      // when the hover began (ms), whether it was clicked (an action, not
      // hesitation), and the input source that opened the episode.
      let hoverMesh: string | null = null;
      let hoverStartMs = 0;
      let hoverActed = false;
      let hoverSource: InputSource | undefined;
      let lastPose: CameraPose | undefined;
      // Per-window frame-time samples for jank percentiles (#41). Filled every
      // render tick (see the perf frame observer below) and drained each perf
      // sample so the aggregator's p95/p99/longFrames describe the window just
      // elapsed.
      let frameTimes: number[] = [];
      const sampleCamera = () => {
        const cam = resolveTrackedCamera(scene, explicitCamera);
        if (!cam) return;
        const view = cam as unknown as CameraView;
        const target = readTarget(cam);
        const intrinsics = readCameraIntrinsics(scene, cam);
        const pose: CameraPose = {
          position: toVec3(view.globalPosition),
          direction: toVec3(view.getForwardRay().direction),
          ...(target ? { target } : {}),
          ...intrinsics,
        };
        // Cheap main-thread idle pre-gate: keep at most one gaze pick per emitted
        // pose (and none while the view is static) by diffing against the last
        // pose with the same `poseUnchanged` the aggregator uses (#10, no logic
        // fork). The aggregator's camera channel is then a pass-through.
        if (suppressIdleSamples && lastPose && poseUnchanged(lastPose, pose, cameraEpsilon)) {
          return;
        }
        lastPose = pose;
        // Gaze raycast (ADR 0030): only after the idle-dedup check passes, so we
        // run at most one pick per emitted pose and none while the view is static.
        const gaze = want.gaze ? sampleGaze(scene, cam, gazeMaxDistance, gazePredicate) : undefined;
        snapshot({
          channel: "camera",
          position: pose.position,
          direction: pose.direction,
          ...(pose.target ? { target: pose.target } : {}),
          ...(pose.fov !== undefined ? { fov: pose.fov } : {}),
          ...(pose.aspect !== undefined ? { aspect: pose.aspect } : {}),
          ...(pose.near !== undefined ? { near: pose.near } : {}),
          ...(gaze?.hitPoint ? { hitPoint: gaze.hitPoint } : {}),
          ...(gaze?.hitMesh ? { hitMesh: gaze.hitMesh } : {}),
        });
      };

      const samplePerf = () => {
        const engine = scene.getEngine();
        const fps = engine.getFps();
        // Drain the frame-time window collected since the last sample into a fresh
        // owned Float32Array so the percentile/longFrames/idle math can move to the
        // worker zero-copy (the buffer is transferred there, kept here in main mode).
        const window = frameTimes;
        frameTimes = [];
        const frameTimeArray = Float32Array.from(window);
        // Render resolution (#43): device pixel ratio and engine render scale
        // (1 = native; Babylon's hardware scaling level is the inverse).
        const dpr = (globalThis as { devicePixelRatio?: number }).devicePixelRatio;
        const scaling = (
          engine as unknown as { getHardwareScalingLevel?: () => number }
        ).getHardwareScalingLevel?.();
        const renderScale = typeof scaling === "number" && scaling > 0 ? 1 / scaling : undefined;
        snapshot({
          channel: "perf",
          frameTimes: frameTimeArray,
          fps,
          jankFrameMs,
          ...(typeof dpr === "number" && dpr > 0 ? { dpr } : {}),
          ...(renderScale !== undefined ? { renderScale } : {}),
        });
      };

      // Drive a continuous channel either on a timer (fixed interval) or once per
      // render tick ("frame"). The render observer is captured so stop() can
      // detach it. Idle suppression keeps per-frame capture cheap when static.
      const driveChannel = (cadence: ResolvedCadence, sample: () => void) => {
        if (cadence.mode === "interval") {
          timers.push(setInterval(sample, cadence.ms));
        } else if (cadence.mode === "frame") {
          const obs = scene.onBeforeRenderObservable.add(sample);
          renderObservers.push(() => scene.onBeforeRenderObservable.remove(obs));
        }
      };

      if (want.camera) {
        // Warn when a multi-camera scene is tracked without an explicit choice:
        // `scene.activeCamera` is ambiguous in PiP/split-screen/RTT rigs and may
        // record a fixed, wrong viewpoint. The viewer should pass `camera`.
        const rig = scene.activeCameras;
        if (!explicitCamera && Array.isArray(rig) && rig.length > 1) {
          console.warn(
            "[uptimizr] scene has multiple active cameras; recording " +
              `"${resolveTrackedCamera(scene, explicitCamera)?.name ?? "?"}" via scene.activeCamera. ` +
              "Pass `camera` to babylonCollector/trackScene to record the camera the viewer flies.",
          );
        }
        sampleCamera();
        driveChannel(cameraCadence, sampleCamera);
      }

      if (wantNodes) {
        // Scene-actor capture (`node_transform`, ADR 0027 Tier 1). Each declared
        // actor gets its own cadence-driven sampler: resolve the node (lazily —
        // resolvers handle load order), refuse cameras (the visitor camera is
        // already `camera_sample`; "events live once"), read the WORLD transform,
        // and hand it to the aggregator. Babylon world nodes are engine-decomposed,
        // so we pass the decomposed sample; the aggregator owns the idle-diff so a
        // static actor still costs nothing on the wire (#10).
        const refusedCamera = new Set<string>();
        for (const id of actorIds) {
          const actor = actorMap[id]!;
          const entry = sampling.nodes?.[id];
          const cadence = resolveCadence(nodeRate(entry), sampleCameraMs);
          if (cadence.mode === "off") continue;
          // Tier-1 subtree (ADR 0033): when the entry declares an `include`, the
          // actor stands in for a moving hierarchy and each captured descendant
          // is emitted with a `childPath` relative to the actor.
          const subtree = nodeSubtree(entry);
          const sampleNode = () => {
            const node = resolveActorNode(scene as unknown as ActorLookupScene, actor);
            if (!node) return;
            if (isCameraNode(node)) {
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
            // Subtree descendants (ADR 0033): walk the bounded hierarchy and emit
            // each kept node's WORLD transform with its `childPath`. The
            // aggregator idle-diffs per (actor, childPath) so a static part costs
            // nothing on the wire.
            if (subtree) {
              for (const { childPath, node: child } of collectSubtree(
                node as WorldTransformNode,
                subtree,
              )) {
                snapshot({
                  channel: "node",
                  nodeId: id,
                  childPath,
                  decomposed: readNodeTransform(child, cameraEpsilon),
                  scaleEps: cameraEpsilon,
                });
              }
            }
          };
          sampleNode();
          driveChannel(cadence, sampleNode);
        }
      }

      if (wantBones) {
        // Tier-2 skeleton-bone capture (`node_transform` + `boneId`, ADR 0027).
        // Each rigged actor gets a cadence-driven sampler that resolves the node,
        // walks its skeleton for the allowlisted bones, reads each bone's
        // skeleton-LOCAL matrix, and hands it to the aggregator (which decomposes
        // it and idle-diffs per (actor, bone), #10). A node that resolves without
        // a skeleton warns once.
        const warnedNoSkeleton = new Set<string>();
        for (const id of boneActorIds) {
          const actor = actorMap[id]!;
          const cfg = sampling.bones![id]!;
          const cadence = resolveCadence(cfg.hz, sampleCameraMs);
          if (cadence.mode === "off") continue;
          const include = cfg.include;
          const sampleBones = () => {
            const node = resolveActorNode(scene as unknown as ActorLookupScene, actor);
            if (!node) return;
            const bones = resolveBones(node as unknown as SkinnedNode, include);
            if (bones.length === 0) {
              if (!warnedNoSkeleton.has(id)) {
                warnedNoSkeleton.add(id);
                console.warn(
                  `[uptimizr] actor "${id}" has no matching skeleton bones for bone capture; ` +
                    "skipping. Tier-2 needs a skinned node with the named bones.",
                );
              }
              return;
            }
            for (const bone of bones) {
              const boneId = bone.name;
              if (typeof boneId !== "string") continue;
              const matrix = readBoneMatrix(bone);
              if (!matrix) continue;
              snapshot({
                channel: "node",
                nodeId: id,
                boneId,
                matrix,
                scaleEps: cameraEpsilon,
              });
            }
          };
          sampleBones();
          driveChannel(cadence, sampleBones);
        }
      }

      if (want.perf) {
        // Accumulate per-frame times every render tick so each perf sample can
        // report jank percentiles (#41). Cheap: one push per frame, drained on
        // each sample. Independent of the perf cadence (which governs emit rate).
        const beforeRender = (
          scene as unknown as {
            onBeforeRenderObservable?: {
              add(cb: () => void): unknown;
              remove(o: unknown): unknown;
            };
          }
        ).onBeforeRenderObservable;
        if (beforeRender) {
          const frameObs = beforeRender.add(() => {
            const dt = (
              scene.getEngine() as unknown as { getDeltaTime?: () => number }
            ).getDeltaTime?.();
            if (typeof dt === "number" && dt > 0) frameTimes.push(dt);
          });
          renderObservers.push(() => beforeRender.remove(frameObs));
        }
        driveChannel(perfCadence, samplePerf);
      }

      if (want.meshVisibility) {
        // Per-object dwell (#37). Each render tick we read which tracked objects
        // are on-screen (the engine frustum/bounds reads must stay main-thread)
        // and hand the raw per-tick observations to the aggregator; it owns the
        // dwell/centred/screen-fraction bucketing and the per-window flush
        // (ADR 0012, #10). Only the coarse aggregate leaves the device (ADR 0003).
        const beforeRender = (
          scene as unknown as {
            onBeforeRenderObservable?: {
              add(cb: () => void): unknown;
              remove(o: unknown): unknown;
            };
          }
        ).onBeforeRenderObservable;
        if (beforeRender) {
          const visObs = beforeRender.add(() => {
            const cam = resolveTrackedCamera(scene, explicitCamera);
            if (!cam) return;
            const view = cam as unknown as CameraView;
            const camPos = toVec3(view.globalPosition);
            const fwd = toVec3(view.getForwardRay().direction);
            const fov = typeof view.fov === "number" ? view.fov : 0.8;
            const dt = (
              scene.getEngine() as unknown as { getDeltaTime?: () => number }
            ).getDeltaTime?.();
            const stepMs = typeof dt === "number" && dt > 0 ? dt : 0;
            if (stepMs === 0) return;
            const planes = (scene as unknown as { frustumPlanes?: unknown }).frustumPlanes;
            const meshesRaw = (scene as unknown as { meshes?: unknown[] }).meshes;
            if (!Array.isArray(meshesRaw)) return;
            let tracked = 0;
            const observations: VisibilityMeshObservation[] = [];
            for (const raw of meshesRaw) {
              if (!visMeshAllowlist && tracked >= visMaxMeshes) break;
              const mesh = raw as {
                name?: string;
                isEnabled?: (checkAncestors?: boolean) => boolean;
                getTotalVertices?: () => number;
                isInFrustum?: (planes: unknown) => boolean;
                getBoundingInfo?: () => unknown;
              };
              const name = typeof mesh.name === "string" ? mesh.name : "";
              if (!name || name.startsWith("uptimizr-")) continue;
              if (visMeshAllowlist) {
                if (!visMeshAllowlist.has(name)) continue;
              } else {
                if (typeof mesh.isEnabled === "function" && !mesh.isEnabled(false)) continue;
                if (typeof mesh.getTotalVertices === "function" && mesh.getTotalVertices() <= 0)
                  continue;
              }
              const sphere = readWorldSphere(mesh);
              if (!sphere) continue;
              tracked++;

              // Visibility: prefer Babylon's frustum test; fall back to a forward
              // half-space check when frustum planes aren't available (e.g. tests).
              let visible: boolean;
              if (planes && typeof mesh.isInFrustum === "function") {
                visible = mesh.isInFrustum(planes);
              } else {
                visible = dot3(sub3(sphere.center, camPos), fwd) > 0;
              }
              if (!visible) continue;

              observations.push({
                mesh: name,
                center: sphere.center,
                radius: sphere.radius,
                // Ride the world AABB along only when bounds capture is on (#53);
                // the aggregator dedupes/rounds it across the window.
                ...(visBoundingBox ? { aabb: sphere.aabb } : {}),
              });
            }
            if (observations.length === 0) return;
            snapshot({
              channel: "visibilityTick",
              stepMs,
              camPos,
              // Pass the raw (un-normalized) forward; the aggregator normalizes.
              forward: fwd,
              fov,
              meshes: observations,
            });
          });
          renderObservers.push(() => beforeRender.remove(visObs));
        }

        const flushVisibility = () => snapshot({ channel: "visibilityFlush" });
        const visTimer = setInterval(flushVisibility, visWindowMs);
        timers.push(visTimer);
        // Flush any partial window on stop so trailing dwell isn't dropped.
        renderObservers.push(flushVisibility);
      }

      if (
        want.pointerMove ||
        want.clicks ||
        want.buttons ||
        want.meshPicks ||
        want.hoverDwell ||
        want.cameraGesture
      ) {
        // Close the current hover episode (#48), emitting a summary when the
        // pointer dwelt on an object past the threshold without clicking it.
        const flushHover = (now: number) => {
          if (hoverMesh != null && !hoverActed) {
            const dwellMs = now - hoverStartMs;
            if (dwellMs >= hoverMinDwellMs) {
              snapshot({
                channel: "hover",
                mesh: hoverMesh,
                dwellMs: Math.round(dwellMs),
                ...(hoverSource ? { source: hoverSource } : {}),
              });
            }
          }
          hoverMesh = null;
          hoverActed = false;
          hoverSource = undefined;
        };
        // Flush a trailing hover on stop so the last episode isn't dropped.
        if (want.hoverDwell) renderObservers.push(() => flushHover(ctx.now()));

        pointerObserver = scene.onPointerObservable.add((info) => {
          const engine = scene.getEngine();
          // Pointer Lock (ADR 0034): the OS cursor is frozen and the crosshair is
          // the viewport centre, so report centre and re-pick there instead of
          // using Babylon's cursor-position `info.pickInfo`.
          const locked = isPointerLocked(() => engine.getRenderingCanvas());
          const screen: [number, number] = locked
            ? [0.5, 0.5]
            : [
                clamp01(scene.pointerX / engine.getRenderWidth()),
                clamp01(scene.pointerY / engine.getRenderHeight()),
              ];
          const pick = locked
            ? scene.pick(engine.getRenderWidth() / 2, engine.getRenderHeight() / 2)
            : info.pickInfo;
          const hitPoint = pick?.hit && pick.pickedPoint ? toVec3(pick.pickedPoint) : undefined;
          const hitMesh = pick?.hit && pick.pickedMesh ? pick.pickedMesh.name : undefined;
          const source = pointerSource(info);

          // Hover hesitation (#48): track the object under the pointer across
          // moves; a click on it marks the episode as an action, not hesitation.
          if (want.hoverDwell) {
            if (info.type === POINTER.MOVE) {
              const target =
                hitMesh != null && (hoverMeshAllowlist == null || hoverMeshAllowlist.has(hitMesh))
                  ? hitMesh
                  : null;
              if (target !== hoverMesh) {
                flushHover(ctx.now());
                if (target != null) {
                  hoverMesh = target;
                  hoverStartMs = ctx.now();
                  hoverActed = false;
                  hoverSource = source;
                }
              }
            } else if (
              (info.type === POINTER.TAP || info.type === POINTER.DOWN) &&
              hoverMesh != null &&
              hitMesh === hoverMesh
            ) {
              hoverActed = true;
            }
          }

          // Camera-navigation gesture (ADR 0025): bracket the press, snapshot the
          // camera at down vs up, and classify the viewpoint change. Runs before
          // the button/click branches (which return early) so it is independent of
          // `want.buttons`. The mesh under the cursor is intentionally ignored — a
          // navigation gesture is not an object interaction.
          if (want.cameraGesture) {
            if (info.type === POINTER.DOWN) {
              const cam = resolveTrackedCamera(scene, explicitCamera);
              if (cam) {
                gestureStart = { sample: readGestureSample(cam), ts: ctx.now(), source };
              }
            } else if (info.type === POINTER.UP && gestureStart) {
              const cam = resolveTrackedCamera(scene, explicitCamera);
              const opened = gestureStart;
              gestureStart = null;
              if (cam) {
                // Hand the start→end bracket to the aggregator; the (pure)
                // classification math runs there, main-thread or in the worker (#10).
                snapshot({
                  channel: "gesture",
                  start: opened.sample,
                  end: readGestureSample(cam),
                  durationMs: Math.max(0, Math.round(ctx.now() - opened.ts)),
                  options: { sensitivity: cameraGestureSensitivity },
                  ...(opened.source ? { source: opened.source } : {}),
                });
              }
            }
          }

          if (info.type === POINTER.MOVE && want.pointerMove) {
            const now = ctx.now();
            if (now - lastPointerMove < pointerThrottleMs) return;
            lastPointerMove = now;
            ctx.emit({
              type: "pointer_move",
              screen,
              ...(hitPoint ? { hitPoint } : {}),
              ...(hitMesh ? { hitMesh } : {}),
              ...(source ? { source } : {}),
            });
            return;
          }

          if ((info.type === POINTER.DOWN || info.type === POINTER.UP) && want.buttons) {
            ctx.emit({
              type: info.type === POINTER.DOWN ? "pointer_down" : "pointer_up",
              screen,
              ...(hitPoint ? { hitPoint } : {}),
              ...(hitMesh ? { hitMesh } : {}),
              ...(typeof info.event?.button === "number" ? { button: info.event.button } : {}),
              ...(source ? { source } : {}),
            });
            return;
          }

          if (info.type === POINTER.TAP && want.clicks) {
            ctx.emit({
              type: "pointer_click",
              screen,
              ...(hitPoint ? { hitPoint } : {}),
              ...(hitMesh ? { hitMesh } : {}),
              ...(typeof info.event?.button === "number" ? { button: info.event.button } : {}),
              ...(source ? { source } : {}),
            });
          }

          if (info.type === POINTER.PICK && want.meshPicks && pick?.hit && pick.pickedMesh) {
            ctx.emit({
              type: "mesh_interaction",
              mesh: pick.pickedMesh.name,
              kind: "pick",
              ...(pick.pickedPoint ? { point: toVec3(pick.pickedPoint) } : {}),
              ...(source ? { source } : {}),
            });
          }
        });
      }

      // Engine GPU context loss/restore. These observables exist on Babylon's
      // engine; we access them structurally to keep `@babylonjs/core` a peer
      // dependency. Each emits a discrete lifecycle event so the timeline records
      // rendering interruptions and recoveries.
      const engineDetachers: Array<() => void> = [];
      if (want.contextLoss) {
        const engine = scene.getEngine() as unknown as EngineWithContextObservables;
        const lost = engine.onContextLostObservable;
        if (lost) {
          const obs = lost.add(() => ctx.emit({ type: "context_lost" }));
          engineDetachers.push(() => lost.remove(obs));
        }
        const restored = engine.onContextRestoredObservable;
        if (restored) {
          const obs = restored.add(() => ctx.emit({ type: "context_restored" }));
          engineDetachers.push(() => restored.remove(obs));
        }
      }

      // WebGPU device loss → `graphics_diagnostic` (`category: device-lost`, ADR
      // 0021 part 2). Opt-in: only wired when `captureGraphicsDiagnostics` is on
      // (the helper enforces the gate). We read the device structurally and only
      // when the engine is WebGPU — WebGL has no device-lost concept (its context
      // loss is already covered by `context_lost` above), so it stays a no-op.
      const gpuEngine = scene.getEngine() as unknown as EngineWithWebGpuDevice;
      if (gpuEngine.isWebGPU) {
        wireGpuDeviceLost(ctx, gpuEngine._device, () => !stopped);
      }

      // Shader / pipeline compile stalls (#42). Babylon raises a before/after
      // pair around each main-thread shader compilation; we time the outermost
      // span (compiles can nest) and emit one `compile_stall` per span. Accessed
      // structurally to keep `@babylonjs/core` a peer dependency.
      if (want.compileStall) {
        const engine = scene.getEngine() as unknown as EngineWithShaderCompilation;
        const before = engine.onBeforeShaderCompilationObservable;
        const after = engine.onAfterShaderCompilationObservable;
        if (before && after) {
          let compileDepth = 0;
          let compileStartMs = 0;
          const onBefore = before.add(() => {
            if (compileDepth === 0) compileStartMs = ctx.now();
            compileDepth += 1;
          });
          const onAfter = after.add(() => {
            if (compileDepth === 0) return;
            compileDepth -= 1;
            if (compileDepth > 0) return;
            const durationMs = Math.max(0, ctx.now() - compileStartMs);
            ctx.emit({ type: "compile_stall", durationMs, phase: "shader" });
          });
          engineDetachers.push(() => before.remove(onBefore));
          engineDetachers.push(() => after.remove(onAfter));
        }
      }

      // GPU / memory footprint (#44). A low-rate timer samples the actual cost
      // the scene asks of the device: triangles/vertices submitted last frame,
      // and the JS heap. Read structurally (peer-dep boundary). Texture/geometry
      // resident bytes aren't cheaply available from Babylon's public surface, so
      // they're omitted here; only defined metrics are emitted (the aggregate's
      // NULLIF then keeps absent metrics out of the averages).
      if (want.resourceSample) {
        const sampleResources = () => {
          const sample: {
            triangles?: number;
            vertices?: number;
            jsHeapBytes?: number;
          } = {};

          const sc = scene as unknown as {
            getActiveIndices?: () => number;
            getTotalVertices?: () => number;
          };
          // Active indices are the indices actually drawn last frame; /3 ≈ tris.
          const indices =
            typeof sc.getActiveIndices === "function" ? sc.getActiveIndices() : undefined;
          if (typeof indices === "number" && indices > 0) {
            sample.triangles = Math.round(indices / 3);
          }
          const verts =
            typeof sc.getTotalVertices === "function" ? sc.getTotalVertices() : undefined;
          if (typeof verts === "number" && verts > 0) sample.vertices = verts;

          // Chromium-only: performance.memory.usedJSHeapSize. Absent elsewhere.
          const mem = (
            globalThis as unknown as { performance?: { memory?: { usedJSHeapSize?: number } } }
          ).performance?.memory;
          if (mem && typeof mem.usedJSHeapSize === "number" && mem.usedJSHeapSize > 0) {
            sample.jsHeapBytes = mem.usedJSHeapSize;
          }

          // Nothing measurable this tick (e.g. headless before first render).
          if (Object.keys(sample).length === 0) return;
          ctx.emit({ type: "resource_sample", ...sample });
        };
        timers.push(setInterval(sampleResources, resourceIntervalMs));
      }

      if (want.keyboard) {
        // Capture only explicitly bound keys (ADR 0023): look the physical
        // `code` up in the allowlist and emit the mapped semantic action. Babylon
        // sets `repeat` on auto-repeating keydowns, which we drop so a held key
        // fires once. Unbound keys are ignored, so arbitrary typing is never seen.
        keyboardObserver = scene.onKeyboardObservable.add((info) => {
          const isDown = info.type === KEYBOARD.KEYDOWN;
          const isUp = info.type === KEYBOARD.KEYUP;
          if (!isDown && !isUp) return;
          const event = info.event as { code?: string; repeat?: boolean } | undefined;
          const code = event?.code;
          if (!code || (isDown && event?.repeat)) return;
          const action = keyBindings[code];
          if (!action) return;
          ctx.trackInput(action, { source: "keyboard", code, pressed: isDown });
        });
      }

      return {
        stop() {
          stopped = true;
          for (const t of timers) clearInterval(t);
          for (const detach of renderObservers) detach();
          renderObservers.length = 0;
          for (const detach of engineDetachers) detach();
          engineDetachers.length = 0;
          if (pointerObserver) scene.onPointerObservable.remove(pointerObserver);
          pointerObserver = null;
          if (keyboardObserver) scene.onKeyboardObservable.remove(keyboardObserver);
          keyboardObserver = null;
        },
      };
    },
  };
}
