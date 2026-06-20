import type { AppBase, BoundingBox, Entity } from "playcanvas";
import type {
  CameraGestureSample,
  Collector,
  CollectorContext,
  CollectorHandle,
  NodeSamplingConfig,
  ResolvedCadence,
  SampleRate,
  SamplingProfile,
} from "@uptimizr/sdk-core";
import {
  classifyCameraGesture,
  resolveCadence,
  toCanonicalDirection,
  toCanonicalPosition,
  toCanonicalQuat,
} from "@uptimizr/sdk-core";
import type { Aabb, InputSource, Vec3 } from "@uptimizr/schema";
import { clamp01, toVec3 } from "./vec.js";
import { createGazeRaycaster, createSceneRaycaster } from "./raycast.js";
import type { GazeProbe, GazeProbeOptions, RaycastHit, RaycastProbe } from "./raycast.js";

/** Minimal `{x,y,z}` shape — both `getPosition()` and `forward` return this. */
interface Vec3Like {
  x: number;
  y: number;
  z: number;
}

/**
 * Structural view of the PlayCanvas camera Entity world-transform readers we call.
 * Reading these structurally lets the connector reuse the engine's own world-space
 * math **without importing `playcanvas` at runtime** (it stays a peer dependency).
 *
 * Unlike three (whose camera looks along local **−Z**, requiring a negate), a
 * PlayCanvas Entity's `forward` getter already returns the **true world-space look
 * direction**, so no extra negation is needed before `toCanonicalDirection`.
 */
interface CameraWorldView {
  getPosition(): Vec3Like;
  /** World-space forward (look) direction. */
  forward: Vec3Like;
  /** World-space up direction (for `camera_gesture` roll, ADR 0025). */
  up: Vec3Like;
  camera?: {
    /** Field of view in **degrees** (PlayCanvas convention). */
    fov?: number;
    /** When `true`, `fov` is the horizontal FOV (else vertical). */
    horizontalFov?: boolean;
    /** Aspect ratio used to convert horizontal → vertical FOV. */
    aspectRatio?: number;
  };
}

/** Structural view of `app.graphicsDevice.canvas` (the DOM event target). */
interface EventTargetView {
  addEventListener(type: string, handler: (e: unknown) => void): void;
  removeEventListener(type: string, handler: (e: unknown) => void): void;
  getBoundingClientRect?: () => { left: number; top: number; width: number; height: number };
}

/** Structural view of the PlayCanvas app fields the connector reads. */
interface AppView {
  graphicsDevice?: { canvas?: EventTargetView };
  stats?: { frame?: { fps?: number; triangles?: number } };
  root?: { forEach?: (cb: (node: unknown) => void) => void };
  on(name: string, callback: (...args: unknown[]) => void): unknown;
  off(name: string, callback: (...args: unknown[]) => void): unknown;
}

/** Structural view of a DOM pointer/mouse event's fields we read. */
interface PointerEventView {
  clientX: number;
  clientY: number;
  button?: number;
  pointerType?: string;
}

/**
 * Map a DOM pointer's `pointerType` to an Uptimizr {@link InputSource} (ADR 0011)
 * — identical mapping to the Babylon / three connectors.
 */
function pointerSource(ev: PointerEventView): InputSource | undefined {
  const t = ev.pointerType;
  if (t === "mouse" || t === "pen" || t === "touch") return t;
  return typeof t === "string" && t.length > 0 ? "other" : undefined;
}

type Vec3T = [number, number, number];

function vec3Close(a: Vec3T, b: Vec3T, eps: number): boolean {
  return (
    Math.abs(a[0] - b[0]) <= eps && Math.abs(a[1] - b[1]) <= eps && Math.abs(a[2] - b[2]) <= eps
  );
}

interface CameraPose {
  position: Vec3T;
  direction: Vec3T;
  fov?: number;
}

/** True when two poses are equal within `eps`. */
function poseUnchanged(a: CameraPose, b: CameraPose, eps: number): boolean {
  if (!vec3Close(a.position, b.position, eps)) return false;
  if (!vec3Close(a.direction, b.direction, eps)) return false;
  if ((a.fov === undefined) !== (b.fov === undefined)) return false;
  if (a.fov !== undefined && b.fov !== undefined && Math.abs(a.fov - b.fov) > eps) return false;
  return true;
}

function sub3(a: Vec3T, b: Vec3T): Vec3T {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}
function dot3(a: Vec3T, b: Vec3T): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}
function len3(a: Vec3T): number {
  return Math.hypot(a[0], a[1], a[2]);
}

type Quat = [number, number, number, number];

/** A captured world transform for a scene actor (`node_transform`, ADR 0027). */
interface NodeSample {
  position: Vec3;
  rotation: Quat;
  scale?: Vec3;
}

/**
 * Structural view of a PlayCanvas graph node we read a world transform from. We
 * never import `playcanvas` at runtime (it stays a peer dependency), so we
 * describe only the members we touch and read them defensively. `getPosition()`
 * and `getRotation()` return the **world-space** translation/orientation;
 * `getWorldTransform().getScale()` yields the world scale.
 */
interface WorldTransformEntity {
  getPosition?: () => Vec3Like;
  getRotation?: () => { x: number; y: number; z: number; w: number };
  getWorldTransform?: () => { getScale?: () => Vec3Like };
  /** Present (non-null) when this Entity carries a camera component. */
  camera?: unknown;
  name?: string;
  /** `GraphNode.children` — direct descendants, walked for Tier-1 subtree capture (ADR 0033). */
  children?: WorldTransformEntity[];
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
  node: WorldTransformEntity;
}

/**
 * Derive the per-tick capture rate from a `sampling.nodes` entry: either a bare
 * {@link SampleRate} (root-only, ADR 0027) or a {@link NodeSamplingConfig} whose
 * `hz` carries the rate (subtree, ADR 0033).
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
function collectSubtree(root: WorldTransformEntity, cfg: SubtreeConfig): CapturedChild[] {
  const out: CapturedChild[] = [];
  const includeAll = cfg.include === "*";
  const includeSet = includeAll ? null : new Set(cfg.include as string[]);
  const queue: Array<{ node: WorldTransformEntity; path: string; depth: number }> = [];
  for (const child of root.children ?? []) {
    queue.push({ node: child, path: child.name ?? "", depth: 1 });
  }
  while (queue.length > 0 && out.length < cfg.maxNodes) {
    const { node, path, depth } = queue.shift()!;
    const name = node.name;
    if (typeof name !== "string" || name.length === 0) continue;
    if (cfg.exclude.has(name)) continue; // prune the whole subtree
    if (isCameraEntity(node)) continue; // refuse cameras and don't descend
    if (includeAll || includeSet!.has(name)) out.push({ childPath: path, node });
    if (depth < cfg.maxDepth) {
      for (const child of node.children ?? []) {
        const cn = child.name ?? "";
        queue.push({ node: child, path: path ? `${path}/${cn}` : cn, depth: depth + 1 });
      }
    }
  }
  return out;
}

/** True when `node` is a camera — refused for `node_transform` (ADR 0027 §7). */
function isCameraEntity(node: WorldTransformEntity): boolean {
  return node.camera != null;
}

/**
 * Read a PlayCanvas node's world transform into a `node_transform` sample, then
 * convert it from PlayCanvas' right-handed frame to the canonical frame (ADR
 * 0018): the position negates Z and the quaternion is reflected `(−x,−y,z,w)`.
 * Scale is invariant under the reflection and is omitted when identity so the
 * common static-scale case stays off the wire (ADR 0027).
 */
function readNodeTransform(node: WorldTransformEntity, scaleEps: number): NodeSample {
  const p = node.getPosition?.() ?? { x: 0, y: 0, z: 0 };
  const q = node.getRotation?.() ?? { x: 0, y: 0, z: 0, w: 1 };
  const sample: NodeSample = {
    position: toCanonicalPosition([p.x, p.y, p.z], "right") as Vec3,
    rotation: toCanonicalQuat([q.x, q.y, q.z, q.w], "right") as Quat,
  };
  const s = node.getWorldTransform?.()?.getScale?.();
  if (
    s &&
    (Math.abs(s.x - 1) > scaleEps || Math.abs(s.y - 1) > scaleEps || Math.abs(s.z - 1) > scaleEps)
  ) {
    sample.scale = toVec3(s);
  }
  return sample;
}

/** True when two node samples are equal within `eps` (scale presence must also match). */
function nodeSampleUnchanged(a: NodeSample, b: NodeSample, eps: number): boolean {
  if (!vec3Close(a.position, b.position, eps)) return false;
  if (
    Math.abs(a.rotation[0] - b.rotation[0]) > eps ||
    Math.abs(a.rotation[1] - b.rotation[1]) > eps ||
    Math.abs(a.rotation[2] - b.rotation[2]) > eps ||
    Math.abs(a.rotation[3] - b.rotation[3]) > eps
  ) {
    return false;
  }
  if ((a.scale === undefined) !== (b.scale === undefined)) return false;
  if (a.scale && b.scale && !vec3Close(a.scale, b.scale, eps)) return false;
  return true;
}

/** Minimal structural view of the scene-graph lookup used to resolve a named actor. */
interface ActorLookupRoot {
  findByName?: (name: string) => unknown;
}

/**
 * Resolve a declared {@link PlayCanvasActor} to a live node, or `null` when it is
 * not (yet) in the scene. A function is called each time (robust to load order
 * and disposal); a string is looked up by entity name via `app.root.findByName`;
 * a direct reference is returned as-is.
 */
function resolveActorNode(
  root: ActorLookupRoot,
  actor: PlayCanvasActor,
): WorldTransformEntity | null {
  if (typeof actor === "function") {
    return (actor() as WorldTransformEntity | null | undefined) ?? null;
  }
  if (typeof actor === "string") {
    return (root.findByName?.(actor) as WorldTransformEntity | null | undefined) ?? null;
  }
  return (actor as WorldTransformEntity | null) ?? null;
}

/**
 * Structural view of a PlayCanvas skeleton bone (a `GraphNode`). PlayCanvas
 * skinning stores bones as graph nodes referenced by each mesh instance's
 * `skinInstance.bones`; their `getLocal*` accessors return the parent-relative
 * **local** TRS we capture for Tier 2 (ADR 0027) — the only frame portable
 * across differing world placements of the same rig.
 */
interface BoneGraphNode {
  name?: string;
  getLocalPosition?: () => Vec3Like;
  getLocalRotation?: () => { x: number; y: number; z: number; w: number };
  getLocalScale?: () => Vec3Like;
}

/** Structural view of a mesh instance carrying a skin (Tier-2 bone source). */
interface SkinnedMeshInstanceView {
  skinInstance?: { bones?: BoneGraphNode[] | null } | null;
}

/** Structural view of a renderable node whose mesh instances may carry skins. */
interface SkinnedNodeView {
  render?: { meshInstances?: SkinnedMeshInstanceView[] | null } | null;
  model?: { meshInstances?: SkinnedMeshInstanceView[] | null } | null;
}

/**
 * Collect the unique skeleton bones referenced by a node's mesh instances
 * (`render` and legacy `model`), de-duplicated by name in first-seen order. A
 * skinned mesh shares one bone set across its instances, so dedup keeps each
 * named bone once. Returns an empty array when the node carries no skin.
 */
function collectSkinBones(node: SkinnedNodeView): BoneGraphNode[] {
  const seen = new Set<string>();
  const out: BoneGraphNode[] = [];
  const instances = [...(node.render?.meshInstances ?? []), ...(node.model?.meshInstances ?? [])];
  for (const mi of instances) {
    const bones = mi.skinInstance?.bones;
    if (!bones) continue;
    for (const bone of bones) {
      const name = bone?.name;
      if (typeof name !== "string" || seen.has(name)) continue;
      seen.add(name);
      out.push(bone);
    }
  }
  return out;
}

/**
 * Resolve the bones to capture for one actor: the allowlisted names in order, or
 * — for the explicit `"*"` wildcard — every named bone in first-seen order.
 * Returns an empty array when the node carries no skin.
 */
function resolvePlayCanvasBones(node: SkinnedNodeView, include: string[] | "*"): BoneGraphNode[] {
  const bones = collectSkinBones(node);
  if (bones.length === 0) return [];
  if (include === "*") return bones;
  const byName = new Map<string, BoneGraphNode>();
  for (const b of bones) if (typeof b.name === "string") byName.set(b.name, b);
  const out: BoneGraphNode[] = [];
  for (const name of include) {
    const bone = byName.get(name);
    if (bone) out.push(bone);
  }
  return out;
}

/**
 * Read a PlayCanvas bone's skeleton-local transform into a canonical-frame
 * `node_transform` sample (ADR 0027 Tier 2). The local TRS is read via the
 * `getLocal*` accessors and reflected into the canonical frame the same way a
 * world transform is (the reflection conjugates a local transform identically) —
 * Z-negated position, reflected quaternion `(−x,−y,z,w)`. Scale is invariant and
 * omitted when identity. Returns `null` when the bone exposes no local pose.
 */
function readPlayCanvasBoneTransform(bone: BoneGraphNode, scaleEps: number): NodeSample | null {
  if (!bone.getLocalPosition || !bone.getLocalRotation) return null;
  const p = bone.getLocalPosition();
  const q = bone.getLocalRotation();
  const sample: NodeSample = {
    position: toCanonicalPosition([p.x, p.y, p.z], "right") as Vec3,
    rotation: toCanonicalQuat([q.x, q.y, q.z, q.w], "right") as Quat,
  };
  const s = bone.getLocalScale?.();
  if (
    s &&
    (Math.abs(s.x - 1) > scaleEps || Math.abs(s.y - 1) > scaleEps || Math.abs(s.z - 1) > scaleEps)
  ) {
    sample.scale = toVec3(s);
  }
  return sample;
}

/** Round an AABB to mm precision so tiny float jitter doesn't re-send the box. */
function roundAabb(b: Aabb): Aabb {
  return b.map((v) => Math.round(v * 1000) / 1000) as Aabb;
}
/** True when two AABBs match within `eps` on every axis. */
function aabbClose(a: Aabb, b: Aabb, eps: number): boolean {
  for (let i = 0; i < 6; i++) if (Math.abs((a[i] ?? 0) - (b[i] ?? 0)) > eps) return false;
  return true;
}

/** Structural view of a PlayCanvas mesh instance we read for visibility. */
interface MeshInstanceVisView {
  visible?: boolean;
  aabb?: Pick<BoundingBox, "getMin" | "getMax">;
}
/** Structural view of a renderable graph node (Entity with mesh instances). */
interface RenderableNodeView {
  name?: string;
  enabled?: boolean;
  render?: { meshInstances?: MeshInstanceVisView[] | null };
  model?: { meshInstances?: MeshInstanceVisView[] | null };
}

/** World-space bounding sphere + AABB of an object, in PlayCanvas' RH frame. */
interface WorldBounds {
  center: Vec3T;
  radius: number;
  /** Min/max in PlayCanvas' right-handed world frame. */
  aabb: Aabb;
}

function meshInstancesOf(node: RenderableNodeView): MeshInstanceVisView[] {
  return node.render?.meshInstances ?? node.model?.meshInstances ?? [];
}

/**
 * Read a renderable node's world-space AABB as the union of its mesh-instance
 * world AABBs. PlayCanvas exposes each instance's world `aabb` directly
 * (`getMin`/`getMax`) — no manual corner transform (unlike three).
 */
function readWorldBounds(node: RenderableNodeView): WorldBounds | null {
  let minX = Infinity,
    minY = Infinity,
    minZ = Infinity,
    maxX = -Infinity,
    maxY = -Infinity,
    maxZ = -Infinity;
  let found = false;
  for (const mi of meshInstancesOf(node)) {
    const box = mi.aabb;
    if (!box || typeof box.getMin !== "function" || typeof box.getMax !== "function") continue;
    const lo = box.getMin();
    const hi = box.getMax();
    found = true;
    if (lo.x < minX) minX = lo.x;
    if (lo.y < minY) minY = lo.y;
    if (lo.z < minZ) minZ = lo.z;
    if (hi.x > maxX) maxX = hi.x;
    if (hi.y > maxY) maxY = hi.y;
    if (hi.z > maxZ) maxZ = hi.z;
  }
  if (!found) return null;
  return {
    center: [(minX + maxX) / 2, (minY + maxY) / 2, (minZ + maxZ) / 2],
    radius: 0.5 * Math.hypot(maxX - minX, maxY - minY, maxZ - minZ),
    aabb: [minX, minY, minZ, maxX, maxY, maxZ],
  };
}

/**
 * Whether a world-space bounding sphere is (roughly) in front of the camera.
 * PlayCanvas exposes a per-camera `Frustum`, but reading it structurally without
 * importing the engine is brittle, so the connector uses the forward half-space
 * test the Babylon / three connectors also use as their fallback — anything in
 * front of the camera counts. This is the documented PlayCanvas divergence from
 * three's full VP-matrix frustum path (matches three's stub-camera behavior).
 */
function sphereInFront(center: Vec3T, radius: number, camPos: Vec3T, forward: Vec3T): boolean {
  return dot3(sub3(center, camPos), forward) + radius > 0;
}

/** Per-object visibility accumulator for the current window (mirrors Babylon). */
interface VisibilityAccumulator {
  visibleMs: number;
  centeredMs: number;
  maxScreenFraction: number;
  bounds?: Aabb;
}

/** Which signals the collector captures. All default to `true`. */
export interface PlayCanvasCaptureOptions {
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
  /** WebGL `webglcontextlost` / `webglcontextrestored` transitions on the canvas. */
  contextLoss?: boolean;
  /**
   * Per-object dwell / attention capture (`mesh_visibility`, #37). **Opt-in, off
   * by default** (privacy, ADR 0003). Each window the connector emits one
   * bucketed summary per tracked object (ADR 0012): on-screen time, time spent
   * near the view centre (a gaze proxy), and the max screen fraction reached.
   * Configure via {@link PlayCanvasCollectorOptions.meshVisibility}.
   */
  meshVisibility?: boolean;
  /**
   * Hover-hesitation capture (`hover_dwell`, #48). **Opt-in, off by default**
   * (privacy, ADR 0003): emits one bucketed summary per hover episode (ADR 0012)
   * when the pointer lingers on an object *without acting on it*. Configure via
   * {@link PlayCanvasCollectorOptions.hoverDwell}.
   */
  hoverDwell?: boolean;
  /**
   * GPU / memory footprint capture (`resource_sample`, #44). **Opt-in, off by
   * default** (privacy + cost, ADR 0003): emits one low-rate summary per window
   * (ADR 0012) of the triangles submitted last frame (`app.stats.frame`) and the
   * JS heap size. Configure cadence via {@link PlayCanvasCollectorOptions.resourceSample}.
   */
  resourceSample?: boolean;
  /**
   * Gaze raycast capture (`camera_sample.hitPoint`/`hitMesh`, ADR 0030). **Opt-in,
   * off by default** (privacy + cost, ADR 0003): when on, each emitted
   * `camera_sample` carries the world-space point (and object name) the camera is
   * looking at — one camera-forward raycast per sample, riding the throttled,
   * idle-suppressed camera cadence. Configure via
   * {@link PlayCanvasCollectorOptions.gaze}.
   */
  gaze?: boolean;
  /**
   * Scene-actor transform capture (`node_transform`, ADR 0027 Tier 1). **On by
   * default**, but inert unless actors are declared in
   * {@link PlayCanvasCollectorOptions.actors} AND given a rate in
   * `sampling.nodes` — so nothing is captured until you opt a node in.
   */
  nodes?: boolean;
  /**
   * Skeleton bone-transform capture (`node_transform` with `boneId`, ADR 0027
   * Tier 2). **On by default**, but inert unless an actor is declared in
   * {@link PlayCanvasCollectorOptions.actors} AND given a per-bone allowlist in
   * `sampling.bones` — each allowlisted bone's skeleton-local pose is captured so
   * replay can re-drive an animated character.
   */
  bones?: boolean;
}

/** Per-object dwell capture options (`mesh_visibility`, #37) — mirrors Babylon. */
export interface MeshVisibilityOptions {
  /** Summary window length in ms — one event per object per window. Default 5000. */
  windowMs?: number;
  /**
   * Allowlist of mesh names to track (low-cardinality, app-defined — ADR 0003).
   * When omitted, every visible, renderable, non-overlay object is tracked, capped
   * by {@link maxMeshes}.
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
   * per object and re-sent only when it moves/resizes beyond a small epsilon.
   */
  boundingBox?: boolean;
}

/** Hover-hesitation capture options (`hover_dwell`, #48) — mirrors Babylon. */
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

/** GPU / memory footprint capture options (`resource_sample`, #44) — mirrors Babylon. */
export interface ResourceSampleOptions {
  /**
   * Sampling interval in ms — one footprint summary per window (ADR 0012). The
   * footprint moves slowly, so the default is deliberately low-rate. Default
   * 15000 (every 15s).
   */
  intervalMs?: number;
}

/**
 * Gaze probe tuning (`camera_sample.hitPoint`/`hitMesh`, ADR 0030). Only consulted
 * when `capture.gaze` is enabled. Mirrors Babylon's `GazeOptions`.
 */
export interface PlayCanvasGazeOptions extends GazeProbeOptions {
  /**
   * Override the gaze probe (a camera-forward raycaster). Defaults to
   * {@link createGazeRaycaster}. Tests inject a stub so gaze is exercised without
   * real geometry.
   */
  probe?: GazeProbe;
}

export interface PlayCanvasCollectorOptions {
  /** The PlayCanvas application to instrument (read-only). */
  app: AppBase;
  /**
   * Camera Entity to record for the view-direction / pose timeline. PlayCanvas
   * supports multiple camera entities with no single "active" camera, so the one
   * the viewer flies must be passed explicitly.
   */
  camera: Entity;
  /** Camera-pose sampling interval in ms. Default 1000. */
  sampleCameraMs?: number;
  /** Performance (FPS) sampling interval in ms. Default 2000. */
  samplePerfMs?: number;
  /** Minimum gap between `pointer_move` samples in ms. Default 250. */
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
   * matching legacy ms knob above; omitted channels keep the conservative
   * defaults. There is no enforced upper bound — `"frame"` captures every tick.
   */
  sampling?: SamplingProfile;
  /**
   * Skip timer-based **camera** samples when the pose is unchanged (within
   * {@link cameraEpsilon}). The first sample is always emitted so the timeline has
   * a baseline. Default `true`.
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
  capture?: PlayCanvasCaptureOptions;
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
   * Gaze probe tuning (`camera_sample.hitPoint`/`hitMesh`, ADR 0030). Only
   * consulted when `capture.gaze` is enabled.
   */
  gaze?: PlayCanvasGazeOptions;
  /**
   * Override the raycast probe used to resolve pointer hits (world point + object
   * name). Defaults to a `pc.Ray` against the scene's mesh-instance world AABBs
   * ({@link createSceneRaycaster}). Provide one to customize picking — and tests
   * inject a stub so picking is exercised without real geometry.
   */
  raycast?: RaycastProbe;
  /**
   * Scene-actor map for `node_transform` capture (ADR 0027 Tier 1): developer-
   * controlled, self-moving nodes (a patrolling NPC, a lift, a vehicle) whose
   * world transform is sampled so replay can reproduce them. Each value resolves
   * to a live node — a direct Entity reference, an entity **name** (looked up via
   * `app.root.findByName`), or a `() => Entity` resolver (robust to load order).
   * A node is only captured when its id also has a rate in `sampling.nodes`;
   * cameras are refused (the visitor camera is already `camera_sample`).
   */
  actors?: Record<string, PlayCanvasActor>;
}

/** A PlayCanvas node that exposes a world transform (a `node_transform` actor, ADR 0027). */
export type PlayCanvasActorNode = Entity;

/**
 * A declared scene actor (ADR 0027): a live {@link PlayCanvasActorNode}, an entity
 * **name** resolved via `app.root.findByName`, or a `() => Entity` resolver called
 * each sample (robust to load order and disposal).
 */
export type PlayCanvasActor =
  | (() => PlayCanvasActorNode | null | undefined)
  | string
  | PlayCanvasActorNode;

/**
 * Create the PlayCanvas connector as an sdk-core {@link Collector}. Register it
 * with `client.use(...)`.
 *
 * It samples camera pose (view-direction heatmap), pointer movement and clicks
 * (screen heatmaps), mesh picks (object engagement), and FPS (perf). It only reads
 * from the scene — it never mutates it — and tears every listener, timer, and
 * frame handler down on stop (ADR 0003: no cookies, no persistent ids).
 *
 * Device/GPU capabilities are captured separately via {@link "./device".readDeviceCaps}.
 *
 * ## PlayCanvas adaptations (vs. the three connector)
 * - **Camera pose:** a PlayCanvas Entity's `forward` getter already returns the
 *   true world look direction (no local −Z negation), so it converts straight
 *   through `toCanonicalDirection`.
 * - **FPS:** PlayCanvas computes FPS itself, so perf reads `app.stats.frame.fps`
 *   directly rather than deriving it from a frame-counter delta.
 * - **"frame" cadence:** the connector owns no rAF loop; it subscribes to the
 *   engine's `frameend` event (the app's own render tick) and removes it on stop.
 * - **World AABBs:** `meshInstance.aabb` is already a world-space box, so mesh
 *   visibility unions those directly instead of transforming local corners.
 */
export function playcanvasCollector(options: PlayCanvasCollectorOptions): Collector {
  const {
    app,
    camera,
    sampleCameraMs = 1000,
    samplePerfMs = 2000,
    pointerMoveThrottleMs = 250,
    suppressIdleSamples = true,
    suppressIdlePerfSamples = false,
    cameraEpsilon = 1e-3,
    perfFpsThreshold = 1,
    cameraGestureSensitivity = 1,
    capture = {},
    sampling = {},
  } = options;

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
    // Typed navigation gestures are on by default (ADR 0025): cheap, no PII.
    cameraGesture: capture.cameraGesture ?? true,
    meshPicks: capture.meshPicks ?? true,
    perf: (capture.perf ?? true) && perfCadence.mode !== "off",
    contextLoss: capture.contextLoss ?? true,
    // Opt-in, off by default (privacy, ADR 0003).
    meshVisibility: capture.meshVisibility ?? false,
    hoverDwell: capture.hoverDwell ?? false,
    // GPU/memory footprint is opt-in (privacy + cost, ADR 0003).
    resourceSample: capture.resourceSample ?? false,
    // Gaze raycast is opt-in (privacy + cost, ADR 0003 / ADR 0012): off unless
    // enabled, and only meaningful when the camera channel is captured.
    gaze: (capture.gaze ?? false) && (capture.camera ?? true) && cameraCadence.mode !== "off",
    // Scene-actor capture is opt-in via actors + sampling.nodes (ADR 0027).
    nodes: capture.nodes ?? true,
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

  // Skeleton bone (`node_transform` + `boneId`, ADR 0027 Tier 2) configuration.
  // Only ids that are BOTH declared in `actors` and given a per-bone allowlist in
  // `sampling.bones` are tracked (default OFF); each actor is driven by its own
  // resolved cadence (ADR 0012).
  const boneActorIds = want.bones
    ? Object.keys(sampling.bones ?? {}).filter((id) => {
        const declared = Object.prototype.hasOwnProperty.call(actorMap, id);
        if (!declared) {
          console.warn(
            `[uptimizr] sampling.bones["${id}"] has no matching entry in \`actors\`; ` +
              "ignoring. Declare the node in `actors` to capture its bones.",
          );
          return false;
        }
        const cfg = sampling.bones![id]!;
        const include = cfg.include;
        if (include !== "*" && (!Array.isArray(include) || include.length === 0)) {
          console.warn(
            `[uptimizr] sampling.bones["${id}"].include is empty; ignoring. Provide bone ` +
              'names or "*" to capture bones.',
          );
          return false;
        }
        return true;
      })
    : [];
  const wantBones = boneActorIds.length > 0;

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

  // Pointer-move throttle in ms: a fixed interval throttles; "frame" means emit
  // every move (no throttle). Discrete pointer events are never throttled.
  const pointerThrottleMs = pointerMoveCadence.mode === "interval" ? pointerMoveCadence.ms : 0;

  return {
    name: "playcanvas",
    start(ctx: CollectorContext): CollectorHandle {
      const appView = app as unknown as AppView;
      const timers: ReturnType<typeof setInterval>[] = [];
      const domListeners: Array<{
        target: EventTargetView;
        type: string;
        handler: (e: unknown) => void;
      }> = [];
      const frameCallbacks: Array<() => void> = [];
      // Run-once-on-stop hooks (trailing flushes for windowed/episodic captures).
      const stopCallbacks: Array<() => void> = [];
      let frameendBound = false;
      let disposed = false;

      let lastPointerMove = 0;
      let lastPose: CameraPose | undefined;
      let lastFps: number | undefined;
      // camera_gesture (ADR 0025) bracket state: the camera snapshot at
      // pointer-down, diffed against pointer-up to classify the navigation.
      let gestureStart: { sample: CameraGestureSample; ts: number; source?: InputSource } | null =
        null;

      const readFps = (): number => appView.stats?.frame?.fps ?? 0;

      /** Vertical FOV in radians, converting from PlayCanvas' degrees + optional horizontalFov. */
      const verticalFovRad = (cam: CameraWorldView["camera"]): number | undefined => {
        if (!cam || typeof cam.fov !== "number") return undefined;
        const fovRad = (cam.fov * Math.PI) / 180;
        if (cam.horizontalFov) {
          const aspect =
            typeof cam.aspectRatio === "number" && cam.aspectRatio > 0 ? cam.aspectRatio : 1;
          // Convert horizontal → vertical FOV: vfov = 2*atan(tan(hfov/2) / aspect).
          return 2 * Math.atan(Math.tan(fovRad / 2) / aspect);
        }
        return fovRad;
      };

      // Gaze probe (`camera_sample.hitPoint`/`hitMesh`, ADR 0030): a reused
      // camera-forward raycaster, built once. Created only when gaze is enabled so
      // the common path allocates nothing. A caller may inject `options.gaze.probe`.
      const gazeProbe: GazeProbe | undefined = want.gaze
        ? (options.gaze?.probe ?? createGazeRaycaster(app, camera, options.gaze ?? {}))
        : undefined;

      const sampleCamera = () => {
        const c = camera as unknown as CameraWorldView;
        // PlayCanvas `forward` is the TRUE world-space look direction (no local −Z
        // convention like three), so the plain Z-negation in `toCanonicalDirection`
        // is correct here (ADR 0018).
        const wp = c.getPosition();
        const wd = c.forward;
        const position = toCanonicalPosition([wp.x, wp.y, wp.z], "right") as Vec3T;
        const direction = toCanonicalDirection([wd.x, wd.y, wd.z], "right") as Vec3T;
        const fov = verticalFovRad(c.camera);
        const pose: CameraPose = {
          position,
          direction,
          ...(fov !== undefined ? { fov } : {}),
        };
        if (suppressIdleSamples && lastPose && poseUnchanged(lastPose, pose, cameraEpsilon)) {
          return;
        }
        lastPose = pose;
        // Gaze: one camera-forward raycast per emitted pose (ADR 0030), computed
        // AFTER the idle-dedup check so static frames cost nothing. PlayCanvas
        // picks right-handed → normalize the hit to the canonical frame.
        const gazeHit = gazeProbe?.();
        const hitPoint = gazeHit
          ? (toCanonicalPosition(gazeHit.point, "right") as Vec3T)
          : undefined;
        const hitMesh = gazeHit && gazeHit.name ? gazeHit.name : undefined;
        ctx.emit({
          type: "camera_sample",
          position: pose.position,
          direction: pose.direction,
          ...(pose.fov !== undefined ? { fov: pose.fov } : {}),
          ...(hitPoint ? { hitPoint } : {}),
          ...(hitMesh ? { hitMesh } : {}),
        });
      };

      // Snapshot the camera for navigation-gesture classification (ADR 0025).
      // PlayCanvas `forward`/`up` are true world-space directions; it has no
      // built-in orbit pivot (orbit scripts are external), so none is supplied and
      // the classifier infers a pivot from the two view rays for orbit typing.
      const readGestureSample = (): CameraGestureSample => {
        const c = camera as unknown as CameraWorldView;
        const p = c.getPosition();
        const f = c.forward;
        const u = c.up;
        const sample: CameraGestureSample = {
          position: toCanonicalPosition([p.x, p.y, p.z], "right") as Vec3T,
          forward: toCanonicalDirection([f.x, f.y, f.z], "right") as Vec3T,
          up: toCanonicalDirection([u.x, u.y, u.z], "right") as Vec3T,
        };
        const fov = verticalFovRad(c.camera);
        if (fov !== undefined) sample.fov = fov;
        return sample;
      };

      const samplePerf = () => {
        const fps = readFps();
        if (fps <= 0) return;
        if (
          suppressIdlePerfSamples &&
          lastFps !== undefined &&
          Math.abs(fps - lastFps) <= perfFpsThreshold
        ) {
          return;
        }
        lastFps = fps;
        ctx.emit({ type: "frame_perf", fps });
      };

      // Drive a continuous channel either on a timer (fixed interval) or once per
      // engine frame ("frame"). PlayCanvas owns its render loop, so the connector
      // subscribes to its `frameend` event and fans out to the registered frame
      // callbacks; the subscription is removed on stop.
      const tickFrame = () => {
        if (disposed) return;
        for (const cb of frameCallbacks) cb();
      };
      const ensureFrameendBound = () => {
        if (!frameendBound) {
          appView.on("frameend", tickFrame);
          frameendBound = true;
        }
      };
      const driveChannel = (cadence: ResolvedCadence, sample: () => void) => {
        if (cadence.mode === "interval") {
          timers.push(setInterval(sample, cadence.ms));
        } else if (cadence.mode === "frame") {
          frameCallbacks.push(sample);
          ensureFrameendBound();
        }
      };

      if (want.camera) {
        sampleCamera();
        driveChannel(cameraCadence, sampleCamera);
      }

      if (want.perf) {
        driveChannel(perfCadence, samplePerf);
      }

      if (wantNodes) {
        // Scene-actor capture (`node_transform`, ADR 0027 Tier 1). Each declared
        // actor gets its own cadence-driven sampler: resolve the node (lazily —
        // resolvers handle load order), refuse cameras (the visitor camera is
        // already `camera_sample`; "events live once"), read the WORLD transform,
        // convert it to the canonical frame, and emit. Idle suppression skips
        // samples where the transform is unchanged so a static actor costs nothing.
        const root = appView.root as unknown as ActorLookupRoot;
        const lastNodeSample = new Map<string, NodeSample>();
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
            const node = resolveActorNode(root, actor);
            if (!node) return;
            if (isCameraEntity(node)) {
              if (!refusedCamera.has(id)) {
                refusedCamera.add(id);
                console.warn(
                  `[uptimizr] actor "${id}" resolves to a camera; refusing node_transform ` +
                    "capture. The visitor camera is already captured as camera_sample.",
                );
              }
              return;
            }
            const sample = readNodeTransform(node, cameraEpsilon);
            const prev = lastNodeSample.get(id);
            if (
              !(suppressIdleSamples && prev && nodeSampleUnchanged(prev, sample, cameraEpsilon))
            ) {
              lastNodeSample.set(id, sample);
              ctx.emit({
                type: "node_transform",
                nodeId: id,
                position: sample.position,
                rotation: sample.rotation,
                ...(sample.scale ? { scale: sample.scale } : {}),
              });
            }
            // Subtree descendants (ADR 0033): walk the bounded hierarchy and emit
            // each kept node's WORLD transform with its `childPath`. Idle
            // suppression is keyed per (actor, childPath) so a static part costs
            // nothing on the wire.
            if (subtree) {
              for (const { childPath, node: child } of collectSubtree(
                node as WorldTransformEntity,
                subtree,
              )) {
                const childSample = readNodeTransform(child, cameraEpsilon);
                const key = `${id}\u0000${childPath}`;
                const childPrev = lastNodeSample.get(key);
                if (
                  suppressIdleSamples &&
                  childPrev &&
                  nodeSampleUnchanged(childPrev, childSample, cameraEpsilon)
                ) {
                  continue;
                }
                lastNodeSample.set(key, childSample);
                ctx.emit({
                  type: "node_transform",
                  nodeId: id,
                  childPath,
                  position: childSample.position,
                  rotation: childSample.rotation,
                  ...(childSample.scale ? { scale: childSample.scale } : {}),
                });
              }
            }
          };
          sampleNode();
          driveChannel(cadence, sampleNode);
        }
      }

      if (wantBones) {
        // Skeleton bone capture (`node_transform` + `boneId`, ADR 0027 Tier 2).
        // For each declared skinned actor, resolve its skeleton bones (by the
        // configured allowlist or "*"), then sample each bone's skeleton-LOCAL
        // pose at the actor's cadence. Per-bone idle suppression keeps a still
        // rig free. The local frame is parent-relative, so motion replays onto a
        // differently-placed instance of the same rig (ADR 0027).
        const root = appView.root as unknown as ActorLookupRoot;
        const lastBoneSample = new Map<string, NodeSample>();
        const warnedNoSkeleton = new Set<string>();
        for (const id of boneActorIds) {
          const actor = actorMap[id]!;
          const cfg = sampling.bones![id]!;
          const cadence = resolveCadence(cfg.hz, sampleCameraMs);
          if (cadence.mode === "off") continue;
          const sampleBones = () => {
            const node = resolveActorNode(root, actor);
            if (!node) return;
            const bones = resolvePlayCanvasBones(node as unknown as SkinnedNodeView, cfg.include);
            if (bones.length === 0) {
              if (!warnedNoSkeleton.has(id)) {
                warnedNoSkeleton.add(id);
                console.warn(
                  `[uptimizr] actor "${id}" resolves to no matching skeleton bones; skipping ` +
                    "Tier 2 capture. Declare the skinned entity and check the bone names.",
                );
              }
              return;
            }
            for (const bone of bones) {
              const boneName = bone.name;
              if (typeof boneName !== "string") continue;
              const sample = readPlayCanvasBoneTransform(bone, cameraEpsilon);
              if (!sample) continue;
              const key = `${id}\u0000${boneName}`;
              const prev = lastBoneSample.get(key);
              if (suppressIdleSamples && prev && nodeSampleUnchanged(prev, sample, cameraEpsilon)) {
                continue;
              }
              lastBoneSample.set(key, sample);
              ctx.emit({
                type: "node_transform",
                nodeId: id,
                boneId: boneName,
                position: sample.position,
                rotation: sample.rotation,
                ...(sample.scale ? { scale: sample.scale } : {}),
              });
            }
          };
          sampleBones();
          driveChannel(cadence, sampleBones);
        }
      }

      // --- Per-object dwell (`mesh_visibility`, #37) ---
      // Accumulate on-screen / near-centre time per object every engine frame
      // (frameend pauses when the tab is hidden — like Babylon's onBeforeRender),
      // then flush one bucketed summary per object per window (ADR 0012).
      if (want.meshVisibility) {
        const accum = new Map<string, VisibilityAccumulator>();
        // Last AABB sent per mesh, so a static box is sent once then suppressed.
        const sentBounds = new Map<string, Aabb>();
        const boundsEps = 1e-3;
        let lastVisTime = ctx.now();

        const sampleVisibility = () => {
          const now = ctx.now();
          const stepMs = now - lastVisTime;
          lastVisTime = now;
          if (stepMs <= 0) return;

          const camView = camera as unknown as CameraWorldView;
          const cp = camView.getPosition();
          const cf = camView.forward;
          const camPos: Vec3T = [cp.x, cp.y, cp.z];
          const forward: Vec3T = [cf.x, cf.y, cf.z];
          const fwdLen = len3(forward) || 1;
          // Half vertical FOV in radians; fall back for ortho / missing fov.
          const vfov = verticalFovRad(camView.camera);
          const halfFov = vfov !== undefined ? vfov / 2 : 0.4;

          let tracked = 0;
          appView.root?.forEach?.((raw) => {
            const node = raw as RenderableNodeView;
            if (meshInstancesOf(node).length === 0) return;
            const name = node.name;
            if (!name || name.startsWith("uptimizr-")) return;
            if (visMeshAllowlist) {
              if (!visMeshAllowlist.has(name)) return;
            } else {
              if (node.enabled === false) return;
              if (tracked >= visMaxMeshes) return;
            }
            const bounds = readWorldBounds(node);
            if (!bounds) return;
            tracked++;
            if (!sphereInFront(bounds.center, bounds.radius, camPos, forward)) {
              return;
            }
            const toCenter = sub3(bounds.center, camPos);
            const dist = len3(toCenter) || 1e-6;
            const cosAngle = dot3(toCenter, forward) / (dist * fwdLen);
            const screenFraction = clamp01(Math.atan2(bounds.radius, dist) / (halfFov || 1e-6));

            let entry = accum.get(name);
            if (!entry) {
              entry = { visibleMs: 0, centeredMs: 0, maxScreenFraction: 0 };
              accum.set(name, entry);
            }
            entry.visibleMs += stepMs;
            if (cosAngle >= visCenteredCos) entry.centeredMs += stepMs;
            if (screenFraction > entry.maxScreenFraction) entry.maxScreenFraction = screenFraction;
            if (visBoundingBox) {
              // Canonical frame negates Z (right-handed PlayCanvas → canonical),
              // which swaps the Z min/max — match hitPoint / camera_sample (ADR 0018).
              const [aMinX, aMinY, aMinZ, aMaxX, aMaxY, aMaxZ] = bounds.aabb;
              entry.bounds = [aMinX, aMinY, -aMaxZ, aMaxX, aMaxY, -aMinZ];
            }
          });
        };

        const flushVisibility = () => {
          for (const [mesh, entry] of accum) {
            if (entry.visibleMs <= 0) continue;
            let bounds: Aabb | undefined;
            if (entry.bounds) {
              const rounded = roundAabb(entry.bounds);
              const prev = sentBounds.get(mesh);
              if (!prev || !aabbClose(prev, rounded, boundsEps)) {
                bounds = rounded;
                sentBounds.set(mesh, rounded);
              }
            }
            ctx.emit({
              type: "mesh_visibility",
              mesh,
              visibleMs: Math.round(entry.visibleMs),
              ...(entry.centeredMs > 0 ? { centeredMs: Math.round(entry.centeredMs) } : {}),
              ...(entry.maxScreenFraction > 0
                ? { maxScreenFraction: entry.maxScreenFraction }
                : {}),
              ...(bounds ? { bounds } : {}),
            });
          }
          accum.clear();
        };

        // Sample every frame; flush on the window timer + once on stop (trailing).
        frameCallbacks.push(sampleVisibility);
        ensureFrameendBound();
        timers.push(setInterval(flushVisibility, visWindowMs));
        stopCallbacks.push(flushVisibility);
      }

      // --- Pointer / raycast wiring (DOM listeners on the device canvas) ---
      const wantPointer =
        want.pointerMove || want.clicks || want.buttons || want.meshPicks || want.hoverDwell;
      const canvas = appView.graphicsDevice?.canvas;
      const raycast: RaycastProbe | undefined =
        wantPointer && canvas ? (options.raycast ?? createSceneRaycaster(app, camera)) : undefined;

      const addListener = (type: string, handler: (e: unknown) => void) => {
        if (!canvas) return;
        canvas.addEventListener(type, handler);
        domListeners.push({ target: canvas, type, handler });
      };

      const screenOf = (ev: PointerEventView): [number, number] => {
        const rect =
          canvas && typeof canvas.getBoundingClientRect === "function"
            ? canvas.getBoundingClientRect()
            : { left: 0, top: 0, width: 0, height: 0 };
        const w = rect.width || 1;
        const h = rect.height || 1;
        // Normalized, origin top-left, clamped to [0,1] — engine-independent.
        return [clamp01((ev.clientX - rect.left) / w), clamp01((ev.clientY - rect.top) / h)];
      };

      const pickAt = (screen: [number, number]): RaycastHit | undefined => {
        if (!raycast) return undefined;
        // Screen [0,1] (top-left) → NDC [-1,1] (y-up) for the raycaster.
        const ndcX = screen[0] * 2 - 1;
        const ndcY = 1 - screen[1] * 2;
        return raycast(ndcX, ndcY);
      };

      interface PointerBase {
        screen: [number, number];
        hitPoint?: Vec3;
        hitMesh?: string;
        source?: InputSource;
        hit?: RaycastHit;
      }
      const buildBase = (ev: PointerEventView): PointerBase => {
        const screen = screenOf(ev);
        const hit = pickAt(screen);
        // Hit point is in PlayCanvas' right-handed world frame; normalize to canonical.
        const hitPoint = hit ? (toCanonicalPosition(hit.point, "right") as Vec3) : undefined;
        const hitMesh = hit?.name ? hit.name : undefined;
        const source = pointerSource(ev);
        return {
          screen,
          ...(hitPoint ? { hitPoint } : {}),
          ...(hitMesh ? { hitMesh } : {}),
          ...(source ? { source } : {}),
          ...(hit ? { hit } : {}),
        };
      };

      // --- Hover hesitation (`hover_dwell`, #48) episode state ---
      // An episode runs while the pointer rests on one object. It is reported only
      // if it lasted >= minDwellMs AND the user never acted on the object (a click
      // means deliberate engagement, not hesitation).
      let hoverMesh: string | undefined;
      let hoverStartMs = 0;
      let hoverActed = false;
      let hoverSource: InputSource | undefined;

      const flushHover = (now: number) => {
        if (hoverMesh !== undefined && !hoverActed) {
          const dwellMs = now - hoverStartMs;
          if (dwellMs >= hoverMinDwellMs) {
            ctx.emit({
              type: "hover_dwell",
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
        const ev = raw as PointerEventView;
        // Hover tracking needs a per-move pick and runs before the pointer-move
        // throttle so an episode boundary is never missed.
        if (want.hoverDwell) {
          const base = buildBase(ev);
          trackHover(ctx.now(), base.hitMesh, base.source);
          if (want.pointerMove) {
            const now = ctx.now();
            if (now - lastPointerMove >= pointerThrottleMs) {
              lastPointerMove = now;
              ctx.emit({
                type: "pointer_move",
                screen: base.screen,
                ...(base.hitPoint ? { hitPoint: base.hitPoint } : {}),
                ...(base.hitMesh ? { hitMesh: base.hitMesh } : {}),
                ...(base.source ? { source: base.source } : {}),
              });
            }
          }
          return;
        }
        if (!want.pointerMove) return;
        const now = ctx.now();
        if (now - lastPointerMove < pointerThrottleMs) return;
        lastPointerMove = now;
        const { screen, hitPoint, hitMesh, source } = buildBase(ev);
        ctx.emit({
          type: "pointer_move",
          screen,
          ...(hitPoint ? { hitPoint } : {}),
          ...(hitMesh ? { hitMesh } : {}),
          ...(source ? { source } : {}),
        });
      };

      const emitButton = (type: "pointer_down" | "pointer_up", raw: unknown) => {
        const ev = raw as PointerEventView;
        if (type === "pointer_down" && want.hoverDwell) {
          const { hitMesh } = buildBase(ev);
          if (hitMesh !== undefined && hitMesh === hoverMesh) hoverActed = true;
        }
        if (!want.buttons) return;
        const { screen, hitPoint, hitMesh, source } = buildBase(ev);
        ctx.emit({
          type,
          screen,
          ...(hitPoint ? { hitPoint } : {}),
          ...(hitMesh ? { hitMesh } : {}),
          ...(typeof ev.button === "number" ? { button: ev.button } : {}),
          ...(source ? { source } : {}),
        });
      };

      const onClick = (raw: unknown) => {
        const ev = raw as PointerEventView;
        const { screen, hitPoint, hitMesh, source, hit } = buildBase(ev);
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
            ...(typeof ev.button === "number" ? { button: ev.button } : {}),
            ...(source ? { source } : {}),
          });
        }
        if (want.meshPicks && hit) {
          ctx.emit({
            type: "mesh_interaction",
            mesh: hit.name,
            kind: "pick",
            ...(hitPoint ? { point: hitPoint } : {}),
            ...(source ? { source } : {}),
          });
        }
      };

      if (want.pointerMove || want.hoverDwell) addListener("pointermove", onPointerMove);
      if (want.buttons || want.hoverDwell) {
        addListener("pointerdown", (e) => emitButton("pointer_down", e));
      }
      if (want.buttons) {
        addListener("pointerup", (e) => emitButton("pointer_up", e));
      }
      if (want.clicks || want.meshPicks || want.hoverDwell) addListener("click", onClick);

      // camera_gesture (ADR 0025): bracket the press and classify the viewpoint
      // change between down and up. No raycast and no mesh — a navigation gesture
      // is not an object interaction. PlayCanvas has no built-in orbit pivot, so the
      // classifier infers one from the two view rays for orbit typing.
      if (want.cameraGesture) {
        const onGestureDown = (raw: unknown) => {
          gestureStart = {
            sample: readGestureSample(),
            ts: ctx.now(),
            source: pointerSource(raw as PointerEventView),
          };
        };
        const onGestureUp = () => {
          const opened = gestureStart;
          gestureStart = null;
          if (!opened) return;
          const classified = classifyCameraGesture(opened.sample, readGestureSample(), {
            sensitivity: cameraGestureSensitivity,
          });
          if (!classified) return;
          ctx.emit({
            type: "camera_gesture",
            kind: classified.kind,
            durationMs: Math.max(0, Math.round(ctx.now() - opened.ts)),
            ...(classified.orbitDeg !== undefined ? { orbitDeg: classified.orbitDeg } : {}),
            ...(classified.rollDeg !== undefined ? { rollDeg: classified.rollDeg } : {}),
            ...(classified.zoomRatio !== undefined ? { zoomRatio: classified.zoomRatio } : {}),
            ...(classified.panDist !== undefined ? { panDist: classified.panDist } : {}),
            ...(opened.source ? { source: opened.source } : {}),
          });
        };
        addListener("pointerdown", onGestureDown);
        addListener("pointerup", onGestureUp);
      }

      // Trailing flush: report an in-progress hover episode on stop.
      if (want.hoverDwell) stopCallbacks.push(() => flushHover(ctx.now()));

      // Engine GPU context loss/restore. Babylon exposes engine observables;
      // PlayCanvas surfaces them as DOM events on the WebGL canvas. Each emits a
      // discrete lifecycle event so the timeline records rendering interruptions.
      if (want.contextLoss) {
        addListener("webglcontextlost", () => ctx.emit({ type: "context_lost" }));
        addListener("webglcontextrestored", () => ctx.emit({ type: "context_restored" }));
      }

      // GPU / memory footprint (`resource_sample`, #44). A low-rate timer samples
      // the triangles PlayCanvas submitted last frame (`app.stats.frame.triangles`)
      // and the JS heap. PlayCanvas exposes no per-frame vertex count or resident
      // texture/geometry bytes on its public surface, so those are omitted; only
      // defined metrics are emitted (the aggregate's NULLIF keeps absent metrics
      // out of the averages).
      if (want.resourceSample) {
        const sampleResources = () => {
          const sample: { triangles?: number; jsHeapBytes?: number } = {};

          const tris = appView.stats?.frame?.triangles;
          if (typeof tris === "number" && tris > 0) sample.triangles = Math.round(tris);

          // Chromium-only: performance.memory.usedJSHeapSize. Absent elsewhere.
          const mem = (
            globalThis as unknown as { performance?: { memory?: { usedJSHeapSize?: number } } }
          ).performance?.memory;
          if (mem && typeof mem.usedJSHeapSize === "number" && mem.usedJSHeapSize > 0) {
            sample.jsHeapBytes = mem.usedJSHeapSize;
          }

          // Nothing measurable this tick (e.g. before the first render).
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
          if (frameendBound) {
            appView.off("frameend", tickFrame);
            frameendBound = false;
          }
          frameCallbacks.length = 0;
          for (const l of domListeners) l.target.removeEventListener(l.type, l.handler);
          domListeners.length = 0;
        },
      };
    },
  };
}
