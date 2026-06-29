import type { Camera, Scene, WebGLRenderer } from "three";
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
import {
  poseUnchanged,
  resolveCadence,
  toCanonicalDirection,
  toCanonicalPosition,
  toCanonicalQuat,
  wireGpuDeviceLost,
  wireGpuUncapturedError,
} from "@uptimizr/sdk-core";
import type { GpuDeviceErrorTargetLike, GpuDeviceLostLike } from "@uptimizr/sdk-core";
import type { Aabb, InputSource, Vec3 } from "@uptimizr/schema";
import { isWebGpu } from "./renderer.js";
import { clamp01 } from "./vec.js";
import { createGazeRaycaster, createSceneRaycaster } from "./raycast.js";
import type { GazeProbe, GazeProbeOptions, RaycastHit, RaycastProbe } from "./raycast.js";

/**
 * Minimal mutable `Vector3`-like sink passed to three's `getWorldPosition` /
 * `getWorldDirection`. Implementing the handful of methods three writes through
 * lets the connector reuse the engine's own world-space math **without importing
 * `three` at runtime** (it stays a peer dependency) and without allocating a real
 * `THREE.Vector3`.
 */
interface Matrix4Like {
  elements: ArrayLike<number>;
}
class Vec3Sink {
  x = 0;
  y = 0;
  z = 0;
  set(x: number, y: number, z: number): this {
    this.x = x;
    this.y = y;
    this.z = z;
    return this;
  }
  setFromMatrixPosition(m: Matrix4Like): this {
    const e = m.elements;
    this.x = (e[12] as number) ?? 0;
    this.y = (e[13] as number) ?? 0;
    this.z = (e[14] as number) ?? 0;
    return this;
  }
  normalize(): this {
    const len = Math.hypot(this.x, this.y, this.z) || 1;
    this.x /= len;
    this.y /= len;
    this.z /= len;
    return this;
  }
  // three's `Camera.getWorldDirection` is `super.getWorldDirection(target).negate()`
  // (cameras look down local −Z), so the sink must support `negate` too — without
  // it the camera-pose read throws and the whole connector fails to start.
  negate(): this {
    this.x = -this.x;
    this.y = -this.y;
    this.z = -this.z;
    return this;
  }
}

/** Structural view of the three.js camera world-transform readers we call. */
interface CameraWorldView {
  getWorldPosition(target: Vec3Sink): Vec3Sink;
  getWorldDirection(target: Vec3Sink): Vec3Sink;
  isPerspectiveCamera?: boolean;
  /** Perspective vertical FOV in **degrees** (three.js convention). */
  fov?: number;
  /** World matrix — its 2nd column (elements 4,5,6) is the camera's up vector. */
  matrixWorld?: Matrix4Like;
}

/** Structural view of `renderer.info.render.frame` (a monotonic frame counter). */
interface RendererInfoView {
  info?: { render?: { frame?: number; triangles?: number } };
}

/**
 * Structural view of a three `WebGPURenderer`'s backend and its `GPUDevice`.
 * three keeps the device on `renderer.backend.device`; we read it structurally
 * (it isn't on the public renderer surface and only exists on the WebGPU backend)
 * to keep `three` a peer dependency and stay version-tolerant.
 */
interface RendererBackendDeviceView {
  backend?: { device?: GpuDeviceLostLike };
}

/** Structural view of the renderer's canvas (`renderer.domElement`). */
interface EventTargetView {
  addEventListener(type: string, handler: (e: unknown) => void): void;
  removeEventListener(type: string, handler: (e: unknown) => void): void;
  getBoundingClientRect?: () => { left: number; top: number; width: number; height: number };
}
interface RendererDomView {
  domElement: EventTargetView;
}

/** Structural view of a DOM pointer/mouse event's fields we read. */
interface PointerEventView {
  clientX: number;
  clientY: number;
  button?: number;
  pointerType?: string;
}

/**
 * Map a DOM pointer's `pointerType` to an Uptimizr {@link InputSource} (ADR
 * 0011) — identical mapping to the Babylon connector. The three DOM values
 * (`mouse` / `pen` / `touch`) map straight through; any other non-empty value is
 * `other`; absence (e.g. a `MouseEvent` from `click`) leaves the field unset.
 */
function pointerSource(ev: PointerEventView): InputSource | undefined {
  const t = ev.pointerType;
  if (t === "mouse" || t === "pen" || t === "touch") return t;
  return typeof t === "string" && t.length > 0 ? "other" : undefined;
}

/**
 * True when the rendering canvas currently holds the browser Pointer Lock (ADR
 * 0034). While locked the OS cursor is hidden and `clientX/Y` freeze, so the
 * connector treats the crosshair (viewport centre) as the pointer. The canvas is
 * read lazily and only when a lock is actually held, so headless capture (no
 * `document`) is never touched.
 */
function isPointerLocked(getCanvas: () => unknown): boolean {
  if (typeof document === "undefined") return false;
  const locked = document.pointerLockElement;
  return locked != null && (locked as unknown) === getCanvas();
}

type Vec3T = [number, number, number];

function sub3(a: Vec3T, b: Vec3T): Vec3T {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}
function dot3(a: Vec3T, b: Vec3T): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

type QuatT = [number, number, number, number];

/**
 * Structural view of the three `Object3D` members the node sampler reads. three
 * stays a peer dependency (no runtime import), so we read `matrixWorld.elements`
 * directly and decompose it ourselves rather than calling `getWorldQuaternion`
 * (which needs real `THREE.Quaternion`/`Vector3` scratch objects).
 */
interface ThreeNodeView {
  updateWorldMatrix?: (updateParents: boolean, updateChildren: boolean) => void;
  matrixWorld?: Matrix4Like;
  isCamera?: boolean;
  type?: string;
  name?: string;
  /** `Object3D.children` — direct descendants, walked for Tier-1 subtree capture (ADR 0033). */
  children?: ThreeNodeView[];
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
  node: ThreeNodeView;
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
function collectThreeSubtree(root: ThreeNodeView, cfg: SubtreeConfig): CapturedChild[] {
  const out: CapturedChild[] = [];
  const includeAll = cfg.include === "*";
  const includeSet = includeAll ? null : new Set(cfg.include as string[]);
  const queue: Array<{ node: ThreeNodeView; path: string; depth: number }> = [];
  for (const child of root.children ?? []) {
    queue.push({ node: child, path: child.name ?? "", depth: 1 });
  }
  while (queue.length > 0 && out.length < cfg.maxNodes) {
    const { node, path, depth } = queue.shift()!;
    const name = node.name;
    if (typeof name !== "string" || name.length === 0) continue;
    if (cfg.exclude.has(name)) continue; // prune the whole subtree
    if (isThreeCameraNode(node)) continue; // refuse cameras and don't descend
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

/**
 * Decompose a column-major three world matrix into position / rotation quaternion
 * / scale (the same algorithm as `THREE.Matrix4.decompose`): scale is the length
 * of each basis column (negate `sx` when the determinant is negative to keep a
 * proper rotation), then the scale-normalized 3×3 is converted to a quaternion.
 */
function decomposeMatrixWorld(e: ArrayLike<number>): NodeSample {
  const position: Vec3T = [(e[12] as number) ?? 0, (e[13] as number) ?? 0, (e[14] as number) ?? 0];
  let sx = Math.hypot(e[0] as number, e[1] as number, e[2] as number);
  const sy = Math.hypot(e[4] as number, e[5] as number, e[6] as number);
  const sz = Math.hypot(e[8] as number, e[9] as number, e[10] as number);
  // Determinant of the upper-left 3×3 — a negative sign means a mirrored basis.
  const det =
    (e[0] as number) *
      ((e[5] as number) * (e[10] as number) - (e[6] as number) * (e[9] as number)) -
    (e[4] as number) *
      ((e[1] as number) * (e[10] as number) - (e[2] as number) * (e[9] as number)) +
    (e[8] as number) * ((e[1] as number) * (e[6] as number) - (e[2] as number) * (e[5] as number));
  if (det < 0) sx = -sx;
  const ix = sx !== 0 ? 1 / sx : 0;
  const iy = sy !== 0 ? 1 / sy : 0;
  const iz = sz !== 0 ? 1 / sz : 0;
  // Scale-normalized rotation basis (column-major three layout).
  const m11 = (e[0] as number) * ix,
    m21 = (e[1] as number) * ix,
    m31 = (e[2] as number) * ix;
  const m12 = (e[4] as number) * iy,
    m22 = (e[5] as number) * iy,
    m32 = (e[6] as number) * iy;
  const m13 = (e[8] as number) * iz,
    m23 = (e[9] as number) * iz,
    m33 = (e[10] as number) * iz;
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

/** True when `node` is (or extends) a camera — refused for `node_transform` (ADR 0027 §7). */
function isThreeCameraNode(node: ThreeNodeView): boolean {
  return node.isCamera === true || (typeof node.type === "string" && node.type.includes("Camera"));
}

/**
 * Read a three node's world transform into a canonical-frame `node_transform`
 * sample. Forces a world-matrix refresh, decomposes it, then reflects position +
 * rotation into the canonical left-handed frame (ADR 0018). Scale is invariant
 * under the handedness reflection; it is omitted when identity.
 */
function readThreeNodeTransform(node: ThreeNodeView, scaleEps: number): NodeSample | null {
  node.updateWorldMatrix?.(true, false);
  const e = node.matrixWorld?.elements;
  if (!e) return null;
  const local = decomposeMatrixWorld(e);
  const sample: NodeSample = {
    position: toCanonicalPosition(local.position, "right") as Vec3T,
    rotation: toCanonicalQuat(local.rotation as QuatT, "right") as QuatT,
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

/**
 * Structural view of a three `Bone`. A `Bone` extends `Object3D`, so its
 * **parent-relative local** transform is exposed directly as `position` /
 * `quaternion` / `scale` (the source values three's `AnimationMixer` writes) —
 * no matrix decompose is needed (ADR 0027 Tier 2). The local frame is the only
 * one portable across differing world placements of the same rig.
 */
interface ThreeBoneView {
  name?: string;
  position?: { x: number; y: number; z: number };
  quaternion?: { x: number; y: number; z: number; w: number };
  scale?: { x: number; y: number; z: number };
}

/** Structural view of a three `SkinnedMesh` carrying a skeleton (Tier 2 source). */
interface ThreeSkinnedView {
  skeleton?: { bones?: ThreeBoneView[] | null } | null;
}

/**
 * Read a three bone's **skeleton-local** transform into a canonical-frame
 * `node_transform` sample (ADR 0027 Tier 2). The bone's parent-relative local TRS
 * is read straight off the `Object3D` and reflected into the canonical
 * left-handed frame (ADR 0018) — the reflection conjugates a local transform the
 * same way it does a world one, so the convert is identical to Tier 1. Scale is
 * invariant under the reflection and omitted when identity. Returns `null` when
 * the bone exposes no readable local pose.
 */
function readThreeBoneTransform(bone: ThreeBoneView, scaleEps: number): NodeSample | null {
  const p = bone.position;
  const q = bone.quaternion;
  if (!p || !q) return null;
  const sample: NodeSample = {
    position: toCanonicalPosition([p.x, p.y, p.z], "right") as Vec3T,
    rotation: toCanonicalQuat([q.x, q.y, q.z, q.w], "right") as QuatT,
  };
  const s = bone.scale;
  if (
    s &&
    (Math.abs(s.x - 1) > scaleEps || Math.abs(s.y - 1) > scaleEps || Math.abs(s.z - 1) > scaleEps)
  ) {
    sample.scale = [s.x, s.y, s.z];
  }
  return sample;
}

/**
 * Resolve the bones to capture for one actor: the allowlisted names in order, or
 * — for the explicit `"*"` wildcard — every named bone in the skeleton. Bones
 * without a name are skipped. Returns an empty array when the node carries no
 * skeleton (e.g. a non-skinned actor or a parent `Group`; declare the
 * `SkinnedMesh` itself for bone capture).
 */
function resolveThreeBones(node: ThreeSkinnedView, include: string[] | "*"): ThreeBoneView[] {
  const bones = node.skeleton?.bones;
  if (!bones || bones.length === 0) return [];
  if (include === "*") return bones.filter((b) => typeof b.name === "string");
  const byName = new Map<string, ThreeBoneView>();
  for (const b of bones) if (typeof b.name === "string") byName.set(b.name, b);
  const out: ThreeBoneView[] = [];
  for (const name of include) {
    const bone = byName.get(name);
    if (bone) out.push(bone);
  }
  return out;
}

/** Minimal structural view of the three scene lookup used to resolve a named actor. */
interface ThreeLookupScene {
  getObjectByName?: (name: string) => unknown;
}

/**
 * Resolve a declared {@link ThreeActor} to a live node, or `null` when it is not
 * (yet) in the scene. A function is called each time (robust to load order); a
 * string is looked up by `Object3D.name`; a direct reference is returned as-is.
 */
function resolveThreeActor(scene: ThreeLookupScene, actor: ThreeActor): ThreeNodeView | null {
  if (typeof actor === "function") {
    return (actor() as ThreeNodeView | null | undefined) ?? null;
  }
  if (typeof actor === "string") {
    const node = scene.getObjectByName?.(actor);
    return node ? (node as ThreeNodeView) : null;
  }
  return (actor as ThreeNodeView | null) ?? null;
}

/**
 * Snapshot a three.js camera into an engine-agnostic {@link CameraGestureSample}
 * (ADR 0025) for navigation-gesture classification. Reads world position +
 * forward via three's own world-transform helpers (so orientation is correct
 * even under nested parents) and the up vector from `matrixWorld`'s 2nd column.
 * three is right-handed, so `toCanonical*` reflect into the canonical left-handed
 * frame (ADR 0018). three has no built-in orbit pivot (it lives in external
 * `OrbitControls`), so no pivot/distance is supplied — the classifier infers a
 * pivot from the two view rays when the motion is an orbit.
 */
function readGestureSample(camera: Camera): CameraGestureSample {
  const c = camera as unknown as CameraWorldView;
  const wp = c.getWorldPosition(new Vec3Sink());
  const wd = c.getWorldDirection(new Vec3Sink());
  const sample: CameraGestureSample = {
    position: toCanonicalPosition([wp.x, wp.y, wp.z], "right") as Vec3T,
    forward: toCanonicalDirection([wd.x, wd.y, wd.z], "right") as Vec3T,
  };
  const e = c.matrixWorld?.elements;
  if (e) {
    const ux = (e[4] as number) ?? 0;
    const uy = (e[5] as number) ?? 0;
    const uz = (e[6] as number) ?? 0;
    const ul = Math.hypot(ux, uy, uz);
    if (ul > 0) {
      sample.up = toCanonicalDirection([ux / ul, uy / ul, uz / ul], "right") as Vec3T;
    }
  }
  if (c.isPerspectiveCamera && typeof c.fov === "number") {
    sample.fov = (c.fov * Math.PI) / 180;
  }
  return sample;
}

/** Structural view of a three.js `Mesh` we read for visibility (never mutated except lazy bounds). */
interface MeshVisibilityView {
  isMesh?: boolean;
  name?: string;
  visible?: boolean;
  matrixWorld?: Matrix4Like;
  geometry?: {
    boundingBox?: { min: Vec3Like; max: Vec3Like } | null;
    computeBoundingBox?: () => void;
    attributes?: { position?: { count?: number } };
  };
}
interface Vec3Like {
  x: number;
  y: number;
  z: number;
}
/** Structural view of the camera matrices used for the frustum test. */
interface CameraFrustumView {
  projectionMatrix?: Matrix4Like;
  matrixWorldInverse?: Matrix4Like;
}
/** Structural view of `scene.traverse` (depth-first object-graph walk). */
interface SceneTraverseView {
  traverse(cb: (object: MeshVisibilityView) => void): void;
}

/** World-space bounding sphere + AABB of a mesh, in three's right-handed frame. */
interface WorldBounds {
  center: Vec3T;
  radius: number;
  /** Min/max in three's right-handed world frame. */
  aabb: Aabb;
}

/**
 * Transform a point by a column-major mat4 (affine; the perspective row is
 * ignored — three world matrices have no projection component).
 */
function transformPoint(e: ArrayLike<number>, x: number, y: number, z: number): Vec3T {
  return [
    (e[0] as number) * x + (e[4] as number) * y + (e[8] as number) * z + (e[12] as number),
    (e[1] as number) * x + (e[5] as number) * y + (e[9] as number) * z + (e[13] as number),
    (e[2] as number) * x + (e[6] as number) * y + (e[10] as number) * z + (e[14] as number),
  ];
}

/**
 * Read a mesh's world-space AABB by transforming its local bounding box's 8
 * corners through `matrixWorld`. three has no `getBoundingInfo().boundingBox`
 * with world min/max (Babylon does), so we compute it from `geometry.boundingBox`
 * (computed lazily if absent, mirroring how three itself populates it) + the
 * object's world matrix — **without importing `three`**.
 */
function readWorldBounds(mesh: MeshVisibilityView): WorldBounds | null {
  const geo = mesh.geometry;
  if (!geo) return null;
  let box = geo.boundingBox;
  if (!box && typeof geo.computeBoundingBox === "function") {
    geo.computeBoundingBox();
    box = geo.boundingBox ?? null;
  }
  const mw = mesh.matrixWorld?.elements;
  if (!box || !mw) return null;
  const lo = box.min;
  const hi = box.max;
  let minX = Infinity,
    minY = Infinity,
    minZ = Infinity,
    maxX = -Infinity,
    maxY = -Infinity,
    maxZ = -Infinity;
  for (let i = 0; i < 8; i++) {
    const [wx, wy, wz] = transformPoint(
      mw,
      i & 1 ? hi.x : lo.x,
      i & 2 ? hi.y : lo.y,
      i & 4 ? hi.z : lo.z,
    );
    if (wx < minX) minX = wx;
    if (wy < minY) minY = wy;
    if (wz < minZ) minZ = wz;
    if (wx > maxX) maxX = wx;
    if (wy > maxY) maxY = wy;
    if (wz > maxZ) maxZ = wz;
  }
  return {
    center: [(minX + maxX) / 2, (minY + maxY) / 2, (minZ + maxZ) / 2],
    radius: 0.5 * Math.hypot(maxX - minX, maxY - minY, maxZ - minZ),
    aabb: [minX, minY, minZ, maxX, maxY, maxZ],
  };
}

/** Column-major 4×4 multiply (`a · b`). */
function mat4Mul(a: ArrayLike<number>, b: ArrayLike<number>): number[] {
  const o = new Array<number>(16);
  for (let c = 0; c < 4; c++) {
    for (let r = 0; r < 4; r++) {
      o[c * 4 + r] =
        (a[r] as number) * (b[c * 4] as number) +
        (a[r + 4] as number) * (b[c * 4 + 1] as number) +
        (a[r + 8] as number) * (b[c * 4 + 2] as number) +
        (a[r + 12] as number) * (b[c * 4 + 3] as number);
    }
  }
  return o;
}

/**
 * Whether a world-space bounding sphere is inside the view frustum. three has no
 * per-object `isInFrustum` (Babylon does), so we project the sphere centre through
 * `VP = projectionMatrix · matrixWorldInverse` and test the clip-space cube with a
 * radius margin. When the camera matrices aren't available (e.g. unit tests with a
 * stub camera), fall back to the forward half-space test the Babylon connector
 * also uses as its fallback.
 */
function sphereInFrustum(
  cam: CameraFrustumView,
  center: Vec3T,
  radius: number,
  camPos: Vec3T,
  forward: Vec3T,
): boolean {
  const proj = cam.projectionMatrix?.elements;
  const view = cam.matrixWorldInverse?.elements;
  if (proj && view && proj.length >= 16 && view.length >= 16) {
    const vp = mat4Mul(proj, view);
    const cx = center[0],
      cy = center[1],
      cz = center[2];
    const x = vp[0]! * cx + vp[4]! * cy + vp[8]! * cz + vp[12]!;
    const y = vp[1]! * cx + vp[5]! * cy + vp[9]! * cz + vp[13]!;
    const z = vp[2]! * cx + vp[6]! * cy + vp[10]! * cz + vp[14]!;
    const w = vp[3]! * cx + vp[7]! * cy + vp[11]! * cz + vp[15]!;
    if (w <= 0) return false; // behind the camera
    // Clip-space slack for the sphere radius (vertical focal scale = proj[5]).
    const m = Math.abs(radius * (proj[5] as number));
    return x >= -w - m && x <= w + m && y >= -w - m && y <= w + m && z >= -w - m && z <= w + m;
  }
  // Fallback: anything in front of the camera (matrices unavailable).
  return dot3(sub3(center, camPos), forward) > 0;
}

/** Which signals the collector captures. All default to `true`. */
export interface ThreeCaptureOptions {
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
   * Configure via {@link ThreeCollectorOptions.meshVisibility}.
   */
  meshVisibility?: boolean;
  /**
   * Hover-hesitation capture (`hover_dwell`, #48). **Opt-in, off by default**
   * (privacy, ADR 0003): emits one bucketed summary per hover episode (ADR 0012)
   * when the pointer lingers on an object *without acting on it*. Configure via
   * {@link ThreeCollectorOptions.hoverDwell}.
   */
  hoverDwell?: boolean;
  /**
   * GPU / memory footprint capture (`resource_sample`, #44). **Opt-in, off by
   * default** (privacy + cost, ADR 0003): emits one low-rate summary per window
   * (ADR 0012) of the triangles submitted last frame (`renderer.info.render`) and
   * the JS heap size. Configure cadence via {@link ThreeCollectorOptions.resourceSample}.
   */
  resourceSample?: boolean;
  /**
   * World-space gaze capture (`camera_sample.hitPoint`/`hitMesh`, ADR 0030).
   * **Opt-in, off by default** (privacy + cost, ADR 0003 / ADR 0012). When on, each
   * emitted camera pose casts the camera's forward ray into the scene and records
   * the surface it hits — a world-space "what did people actually look at" heatmap,
   * independent of pointer/click. The pick rides the throttled, idle-suppressed
   * camera cadence (one pick per emitted pose, none while the view is static), so
   * cost is bounded. Configure via {@link ThreeCollectorOptions.gaze}.
   */
  gaze?: boolean;
  /**
   * Scene-actor transform capture (`node_transform`, ADR 0027 Tier 1). **Off
   * unless `actors` + `sampling.nodes` are provided** — captures the world
   * transform of developer-named moving objects (an NPC, a door, a vehicle) so
   * replay can reproduce their motion. Set `false` to disable even when actors exist.
   */
  nodes?: boolean;
  /**
   * Skeleton bone-transform capture (`node_transform` with `boneId`, ADR 0027
   * Tier 2). **Off unless `actors` + `sampling.bones` are provided** — captures
   * each allowlisted bone's skeleton-local pose for a `SkinnedMesh` actor so
   * replay can re-drive an animated character. Set `false` to disable even when
   * bone sampling is configured.
   */
  bones?: boolean;
  /**
   * Keyboard `input_action` capture (ADR 0023). **Off unless `keyBindings` is
   * provided** — only explicitly bound keys are recorded, never arbitrary typing
   * (privacy, ADR 0003). On by default once bindings exist; set `false` to
   * disable even when bindings are present.
   */
  keyboard?: boolean;
}
export interface MeshVisibilityOptions {
  /** Summary window length in ms — one event per object per window. Default 5000. */
  windowMs?: number;
  /**
   * Allowlist of mesh names to track (low-cardinality, app-defined — ADR 0003).
   * When omitted, every visible, vertex-bearing, non-overlay mesh is tracked,
   * capped by {@link maxMeshes}.
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
 * World-space gaze capture tuning (`camera_sample.hitPoint`/`hitMesh`, ADR 0030).
 * Extends the shared {@link GazeProbeOptions} (ray length + object filtering) with
 * a `probe` override so a host can supply a custom forward-ray picker (e.g. limit
 * to a layer) — and tests can stub it without real geometry.
 */
export interface ThreeGazeOptions extends GazeProbeOptions {
  /**
   * Override the gaze probe (camera-forward pick). Defaults to a `THREE.Raycaster`
   * against the scene graph ({@link createGazeRaycaster}). When provided, the
   * `maxDistance`/`meshes`/`predicate` knobs are the probe's responsibility.
   */
  probe?: GazeProbe;
}

export interface ThreeCollectorOptions {
  /** The three.js scene to instrument (read-only). */
  scene: Scene;
  /**
   * Camera to record for the view-direction / pose timeline. three has no
   * `scene.activeCamera`, so the camera the viewer flies must be passed explicitly.
   */
  camera: Camera;
  /** The renderer driving the scene — its canvas (`domElement`) and `info` are read. */
  renderer: WebGLRenderer;
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
  capture?: ThreeCaptureOptions;
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
   * Only consulted when `capture.gaze` is enabled. Tune the ray length, restrict
   * which objects count as a gaze hit, or override the probe entirely (e.g. limit
   * to a layer, or stub it in tests).
   */
  gaze?: ThreeGazeOptions;
  /**
   * Override the raycast probe used to resolve pointer hits (world point + object
   * name). Defaults to a `THREE.Raycaster` against the scene graph
   * ({@link createSceneRaycaster}). Provide one to customize picking (e.g. limit to
   * a layer) — and tests inject a stub so picking is exercised without real geometry.
   */
  raycast?: RaycastProbe;
  /**
   * Scene-actor map for `node_transform` capture (ADR 0027 Tier 1): developer id
   * → three `Object3D`. Accepts a **resolver function** `() => object | null`
   * (preferred — robust to load order), a **name string** looked up via
   * `scene.getObjectByName`, or a **direct object reference**. Only ids that ALSO
   * appear in `sampling.nodes` are sampled (default OFF); the object's world
   * transform is read each tick (matrix decomposed, converted to the canonical
   * frame) and emitted as a `node_transform`. Cameras are refused (the visitor
   * camera is already `camera_sample` — "events live once").
   */
  actors?: Record<string, ThreeActor>;
  /**
   * Keyboard bindings to capture as `input_action` events (ADR 0023): a map from
   * `KeyboardEvent.code` (e.g. `"KeyW"`, `"ArrowLeft"`) to a semantic app action
   * (e.g. `"move-forward"`). **Only bound keys are recorded** — unbound keys are
   * never seen, so arbitrary typing is never captured (privacy, ADR 0003).
   * Auto-repeat (held keys) is suppressed; each press and release emits once.
   * three has no keyboard observable, so the connector listens on `window`.
   */
  keyBindings?: Record<string, string>;
}

/** A three.js node that exposes a world transform (a `node_transform` actor, ADR 0027). */
export type ThreeActorNode = object;

/**
 * How a developer declares a three.js scene actor (ADR 0027 §6): a resolver
 * function (preferred), an `Object3D.name` string the connector looks up via
 * `scene.getObjectByName`, or a direct `Object3D` reference. The value type is
 * engine-specific — exactly like the existing `scene`/`camera` args differ per
 * connector.
 */
export type ThreeActor = (() => ThreeActorNode | null | undefined) | string | ThreeActorNode;

/**
 * Create the three.js connector as an sdk-core {@link Collector}. Register it with
 * `client.use(...)`.
 *
 * It samples camera pose (view-direction heatmap), pointer movement and clicks
 * (screen heatmaps), mesh picks (object engagement), and FPS (perf). It only reads
 * from the scene — it never mutates it — and tears every listener, timer, and
 * animation-frame callback down on stop (ADR 0003: no cookies, no persistent ids).
 *
 * Device/GPU capabilities are captured separately via {@link "./device".readDeviceCaps}.
 *
 * ## three.js adaptations (vs. the Babylon connector)
 * - **Pointer/raycast:** three has no pointer observable, so DOM listeners are
 *   attached to `renderer.domElement` and hits are resolved with a `THREE.Raycaster`.
 * - **FPS:** three has no `getFps()`, so FPS is derived from the
 *   `renderer.info.render.frame` delta over the sample interval.
 * - **"frame" cadence:** three has no per-frame observable the connector owns, so a
 *   `requestAnimationFrame` loop drives `"frame"`-cadence channels (rAF ≈ render cadence).
 */
export function threeCollector(options: ThreeCollectorOptions): Collector {
  const {
    scene,
    camera,
    renderer,
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

  // Keyboard `input_action` allowlist (ADR 0023): only bound keys are recorded.
  const keyBindings = options.keyBindings ?? {};
  const hasKeyBindings = Object.keys(keyBindings).length > 0;

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
    // Scene-actor capture is opt-in (ADR 0027): off unless actors are declared.
    nodes: capture.nodes ?? true,
    bones: capture.bones ?? true,
    // Keyboard is opt-in: it requires an explicit binding allowlist (ADR 0023).
    keyboard: (capture.keyboard ?? true) && hasKeyBindings,
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
    name: "three",
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
      const domListeners: Array<{
        target: EventTargetView;
        type: string;
        handler: (e: unknown) => void;
      }> = [];
      const frameCallbacks: Array<() => void> = [];
      // Run-once-on-stop hooks (trailing flushes for windowed/episodic captures).
      const stopCallbacks: Array<() => void> = [];
      let rafId: number | undefined;
      let disposed = false;

      let lastPointerMove = 0;
      let lastPose: CameraPose | undefined;
      // camera_gesture (ADR 0025) bracket state: the camera snapshot at
      // pointer-down, diffed against pointer-up to classify the navigation.
      let gestureStart: { sample: CameraGestureSample; ts: number; source?: InputSource } | null =
        null;
      // FPS baseline: capture the frame counter and clock now so the first perf
      // tick computes a real delta (three has no instantaneous getFps()).
      let lastFrame = readFrameCount();
      let lastFrameTime = ctx.now();

      function readFrameCount(): number {
        return (renderer as unknown as RendererInfoView).info?.render?.frame ?? 0;
      }

      // Gaze probe (ADR 0030): a single reused camera-forward raycaster, created
      // only when gaze capture is on. It runs inside `sampleCamera` *after* the
      // idle-dedup check, so a pick happens at most once per emitted pose and never
      // while the view is static.
      const gazeProbe: GazeProbe | undefined = want.gaze
        ? (options.gaze?.probe ?? createGazeRaycaster(scene, camera, options.gaze ?? {}))
        : undefined;

      const sampleCamera = () => {
        const c = camera as unknown as CameraWorldView;
        // ⚠️ three cameras look along local **−Z**; the canonical (Babylon-style)
        // camera looks along local **+Z**. `getWorldDirection` returns the TRUE
        // world-space forward vector, so the plain Z-negation in
        // `toCanonicalDirection` is correct here. Do NOT reconstruct orientation
        // from the local quaternion/Euler and reflect components — that path needs
        // an extra forward-axis rotation (see sdk-core `toCanonicalDirection` and
        // ADR 0018).
        const wp = c.getWorldPosition(new Vec3Sink());
        const wd = c.getWorldDirection(new Vec3Sink());
        const position = toCanonicalPosition([wp.x, wp.y, wp.z], "right") as Vec3T;
        const direction = toCanonicalDirection([wd.x, wd.y, wd.z], "right") as Vec3T;
        // three's perspective FOV is in degrees; emit radians to match the
        // canonical (Babylon) camera_sample convention.
        const fov =
          c.isPerspectiveCamera && typeof c.fov === "number" ? (c.fov * Math.PI) / 180 : undefined;
        const pose: CameraPose = {
          position,
          direction,
          ...(fov !== undefined ? { fov } : {}),
        };
        if (suppressIdleSamples && lastPose && poseUnchanged(lastPose, pose, cameraEpsilon)) {
          return;
        }
        lastPose = pose;
        // Gaze raycast (ADR 0030): only after the idle-dedup check passes. The hit
        // point is in three's right-handed frame; normalize it like pointer hits.
        const gazeHit = gazeProbe?.();
        const hitPoint = gazeHit
          ? (toCanonicalPosition(gazeHit.point, "right") as Vec3T)
          : undefined;
        const hitMesh = gazeHit && gazeHit.name ? gazeHit.name : undefined;
        snapshot({
          channel: "camera",
          position: pose.position,
          direction: pose.direction,
          ...(pose.fov !== undefined ? { fov: pose.fov } : {}),
          ...(hitPoint ? { hitPoint } : {}),
          ...(hitMesh ? { hitMesh } : {}),
        });
      };

      const samplePerf = () => {
        const frame = readFrameCount();
        const now = ctx.now();
        const framesDelta = frame - lastFrame;
        const secondsDelta = (now - lastFrameTime) / 1000;
        lastFrame = frame;
        lastFrameTime = now;
        if (secondsDelta <= 0) return;
        const fps = framesDelta / secondsDelta;
        // three has no per-frame delta window (no engine render observable the
        // connector owns), so the perf snapshot carries an empty frame-time window;
        // the aggregator owns the FPS idle-diff (#10).
        snapshot({ channel: "perf", frameTimes: new Float32Array(0), fps, jankFrameMs: 0 });
      };

      // Drive a continuous channel either on a timer (fixed interval) or once per
      // animation frame ("frame"). three has no render observable the connector
      // owns, so a shared rAF loop fans out to the registered frame callbacks; it
      // is cancelled on stop. rAF ≈ render cadence.
      const tickFrame = () => {
        if (disposed) return;
        for (const cb of frameCallbacks) cb();
        if (typeof requestAnimationFrame === "function") {
          rafId = requestAnimationFrame(tickFrame);
        }
      };
      const driveChannel = (cadence: ResolvedCadence, sample: () => void) => {
        if (cadence.mode === "interval") {
          timers.push(setInterval(sample, cadence.ms));
        } else if (cadence.mode === "frame") {
          frameCallbacks.push(sample);
          if (rafId === undefined && typeof requestAnimationFrame === "function") {
            rafId = requestAnimationFrame(tickFrame);
          }
        }
      };

      if (want.camera) {
        sampleCamera();
        driveChannel(cameraCadence, sampleCamera);
      }

      if (wantNodes) {
        // Scene-actor capture (`node_transform`, ADR 0027 Tier 1). Each declared
        // actor gets its own cadence-driven sampler: resolve the node (lazily),
        // refuse cameras (the visitor camera is already `camera_sample`), read +
        // canonicalize the WORLD transform, and hand it to the aggregator. three
        // nodes are engine-decomposed + handedness-converted in the connector, so
        // we pass the decomposed sample; the aggregator owns the idle-diff so a
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
            const node = resolveThreeActor(scene as unknown as ThreeLookupScene, actor);
            if (!node) return;
            if (isThreeCameraNode(node)) {
              if (!refusedCamera.has(id)) {
                refusedCamera.add(id);
                console.warn(
                  `[uptimizr] actor "${id}" resolves to a camera; refusing node_transform ` +
                    "capture. The visitor camera is already captured as camera_sample.",
                );
              }
              return;
            }
            const sample = readThreeNodeTransform(node, cameraEpsilon);
            if (sample) {
              snapshot({
                channel: "node",
                nodeId: id,
                decomposed: sample,
                scaleEps: cameraEpsilon,
              });
            }
            // Subtree descendants (ADR 0033): walk the bounded hierarchy and emit
            // each kept node's WORLD transform with its `childPath`. The aggregator
            // idle-diffs per (actor, childPath) so a static part costs nothing on
            // the wire.
            if (subtree) {
              for (const { childPath, node: child } of collectThreeSubtree(
                node as ThreeNodeView,
                subtree,
              )) {
                const childSample = readThreeNodeTransform(child, cameraEpsilon);
                if (!childSample) continue;
                snapshot({
                  channel: "node",
                  nodeId: id,
                  childPath,
                  decomposed: childSample,
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
        // Skeleton bone capture (`node_transform` + `boneId`, ADR 0027 Tier 2).
        // For each declared SkinnedMesh actor, resolve its skeleton bones (by the
        // configured allowlist or "*"), then sample each bone's skeleton-LOCAL
        // pose at the actor's cadence. three bones expose their parent-relative TRS
        // directly, so we decompose + handedness-convert in the connector and pass
        // the decomposed sample; the aggregator idle-diffs per (actor, bone) so a
        // still rig stays free (#10). The local frame is parent-relative, so motion
        // replays onto a differently-placed instance of the same rig (ADR 0027).
        const warnedNoSkeleton = new Set<string>();
        for (const id of boneActorIds) {
          const actor = actorMap[id]!;
          const cfg = sampling.bones![id]!;
          const cadence = resolveCadence(cfg.hz, sampleCameraMs);
          if (cadence.mode === "off") continue;
          const sampleBones = () => {
            const node = resolveThreeActor(scene as unknown as ThreeLookupScene, actor);
            if (!node) return;
            const bones = resolveThreeBones(node as unknown as ThreeSkinnedView, cfg.include);
            if (bones.length === 0) {
              if (!warnedNoSkeleton.has(id)) {
                warnedNoSkeleton.add(id);
                console.warn(
                  `[uptimizr] actor "${id}" resolves to no matching skeleton bones; skipping ` +
                    "Tier 2 capture. Declare the SkinnedMesh and check the bone names.",
                );
              }
              return;
            }
            for (const bone of bones) {
              const boneName = bone.name;
              if (typeof boneName !== "string") continue;
              const sample = readThreeBoneTransform(bone, cameraEpsilon);
              if (!sample) continue;
              snapshot({
                channel: "node",
                nodeId: id,
                boneId: boneName,
                decomposed: sample,
                scaleEps: cameraEpsilon,
              });
            }
          };
          sampleBones();
          driveChannel(cadence, sampleBones);
        }
      }

      if (want.perf) {
        driveChannel(perfCadence, samplePerf);
      }

      // --- Per-object dwell (`mesh_visibility`, #37) ---
      // Each animation frame (rAF ≈ render cadence, so dwell pauses when the tab is
      // hidden — like Babylon's onBeforeRender) we read which tracked objects are
      // on-screen (the frustum/world-AABB reads must stay main-thread; three has no
      // native readers, so the geometry is computed import-free above) and hand the
      // raw per-tick observations to the aggregator. It owns the dwell/centred/
      // screen-fraction bucketing, the AABB dedupe and the per-window flush
      // (ADR 0012, #10). Only the coarse aggregate leaves the device (ADR 0003).
      if (want.meshVisibility) {
        let lastVisTime = ctx.now();

        const sampleVisibility = () => {
          const now = ctx.now();
          const stepMs = now - lastVisTime;
          lastVisTime = now;
          if (stepMs <= 0) return;

          const camView = camera as unknown as CameraWorldView;
          const fp = camView.getWorldPosition(new Vec3Sink());
          const fd = camView.getWorldDirection(new Vec3Sink());
          const camPos: Vec3T = [fp.x, fp.y, fp.z];
          const forward: Vec3T = [fd.x, fd.y, fd.z];
          // Camera vertical FOV in radians (three FOV is degrees); ortho falls back
          // to 0.8 (the aggregator's default), matching the prior 0.4 half-FOV.
          const fov =
            camView.isPerspectiveCamera && typeof camView.fov === "number"
              ? (camView.fov * Math.PI) / 180
              : 0.8;

          let tracked = 0;
          const observations: VisibilityMeshObservation[] = [];
          (scene as unknown as SceneTraverseView).traverse((obj) => {
            if (!obj.isMesh) return;
            const name = obj.name;
            if (!name || name.startsWith("uptimizr-")) return;
            if (visMeshAllowlist) {
              if (!visMeshAllowlist.has(name)) return;
            } else {
              if (obj.visible === false) return;
              if (!(obj.geometry?.attributes?.position?.count ?? 0)) return;
              if (tracked >= visMaxMeshes) return;
            }
            const bounds = readWorldBounds(obj);
            if (!bounds) return;
            tracked++;
            if (
              !sphereInFrustum(
                camera as unknown as CameraFrustumView,
                bounds.center,
                bounds.radius,
                camPos,
                forward,
              )
            ) {
              return;
            }
            let aabb: Aabb | undefined;
            if (visBoundingBox) {
              // Canonical frame negates Z (right-handed three → canonical), which
              // swaps the Z min/max — match hitPoint / camera_sample (ADR 0018).
              const [aMinX, aMinY, aMinZ, aMaxX, aMaxY, aMaxZ] = bounds.aabb;
              aabb = [aMinX, aMinY, -aMaxZ, aMaxX, aMaxY, -aMinZ];
            }
            observations.push({
              mesh: name,
              center: bounds.center,
              radius: bounds.radius,
              // Ride the world AABB along only when bounds capture is on (#53); the
              // aggregator dedupes/rounds it across the window.
              ...(aabb ? { aabb } : {}),
            });
          });
          if (observations.length === 0) return;
          snapshot({
            channel: "visibilityTick",
            stepMs,
            camPos,
            // Pass the raw (un-normalized) forward; the aggregator normalizes.
            forward,
            fov,
            meshes: observations,
          });
        };

        const flushVisibility = () => snapshot({ channel: "visibilityFlush" });

        // Sample every frame; flush on the window timer + once on stop (trailing).
        frameCallbacks.push(sampleVisibility);
        if (rafId === undefined && typeof requestAnimationFrame === "function") {
          rafId = requestAnimationFrame(tickFrame);
        }
        timers.push(setInterval(flushVisibility, visWindowMs));
        stopCallbacks.push(flushVisibility);
      }

      // --- Pointer / raycast wiring (DOM listeners on the renderer canvas) ---
      const wantPointer =
        want.pointerMove || want.clicks || want.buttons || want.meshPicks || want.hoverDwell;
      const canvas = (renderer as unknown as RendererDomView).domElement;
      const raycast: RaycastProbe | undefined = wantPointer
        ? (options.raycast ?? createSceneRaycaster(scene, camera))
        : undefined;

      const addListener = (type: string, handler: (e: unknown) => void) => {
        canvas.addEventListener(type, handler);
        domListeners.push({ target: canvas, type, handler });
      };

      const screenOf = (ev: PointerEventView): [number, number] => {
        // Pointer Lock (ADR 0034): the OS cursor is frozen and the crosshair is the
        // viewport centre, so report centre; `pickAt` then raycasts from centre.
        if (isPointerLocked(() => canvas)) return [0.5, 0.5];
        const rect =
          typeof canvas.getBoundingClientRect === "function"
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
        // Hit point is in three's right-handed world frame; normalize to canonical.
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
        const { screen, hitPoint, hitMesh, source } = buildBase(raw as PointerEventView);
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
      // is not an object interaction. three has no built-in orbit pivot, so the
      // classifier infers one from the two view rays for orbit typing.
      if (want.cameraGesture) {
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
          // Hand the start→end bracket to the aggregator; the (pure)
          // classification math runs there, main-thread or in the worker (#10).
          snapshot({
            channel: "gesture",
            start: opened.sample,
            end: readGestureSample(camera),
            durationMs: Math.max(0, Math.round(ctx.now() - opened.ts)),
            options: { sensitivity: cameraGestureSensitivity },
            ...(opened.source ? { source: opened.source } : {}),
          });
        };
        addListener("pointerdown", onGestureDown);
        addListener("pointerup", onGestureUp);
      }

      // Trailing flush: report an in-progress hover episode on stop.
      if (want.hoverDwell) stopCallbacks.push(() => flushHover(ctx.now()));

      // Engine GPU context loss/restore. Babylon exposes engine observables; three
      // surfaces them as DOM events on the WebGL canvas. Each emits a discrete
      // lifecycle event so the timeline records rendering interruptions.
      if (want.contextLoss) {
        addListener("webglcontextlost", () => ctx.emit({ type: "context_lost" }));
        addListener("webglcontextrestored", () => ctx.emit({ type: "context_restored" }));
      }

      // WebGPU device loss → `graphics_diagnostic` (`category: device-lost`, ADR
      // 0021 part 2). Opt-in: only wired when `captureGraphicsDiagnostics` is on
      // (the helper enforces the gate). We read the device structurally and only
      // on a `WebGPURenderer` — a `WebGLRenderer` has no device-lost concept (its
      // context loss is the `webglcontextlost` event above), so it stays a no-op.
      //
      // three builds the WebGPU backend's device asynchronously (`renderer.init()` /
      // first `renderAsync`), so `renderer.backend.device` is often undefined at
      // `start()`. We pass a getter (optional-chained, never throws) and let the
      // helper poll until the device appears. `backend.device` is the documented
      // location across the WebGPURenderer line; a missing field is a clean no-op.
      if (isWebGpu(renderer)) {
        const getDevice = () => (renderer as unknown as RendererBackendDeviceView).backend?.device;
        wireGpuDeviceLost(ctx, getDevice, () => !disposed);
        // WebGPU `uncapturederror` → rate-limited rollup (#19). The backend device
        // is also a `GPUDevice` (an `EventTarget`); the shared helper coalesces a
        // burst into one `graphics_diagnostic` with `count` so a storm can't flood
        // ingestion. Flushed on teardown via stopCallbacks.
        const flushUncaptured = wireGpuUncapturedError(
          ctx,
          () => getDevice() as unknown as GpuDeviceErrorTargetLike,
          () => !disposed,
        );
        stopCallbacks.push(flushUncaptured);
      }

      // GPU / memory footprint (`resource_sample`, #44). A low-rate timer samples
      // the triangles three submitted last frame (`renderer.info.render.triangles`)
      // and the JS heap. three exposes no vertex count or resident texture/geometry
      // bytes on its public surface, so those are omitted; only defined metrics are
      // emitted (the aggregate's NULLIF keeps absent metrics out of the averages).
      if (want.resourceSample) {
        const sampleResources = () => {
          const sample: { triangles?: number; jsHeapBytes?: number } = {};

          const tris = (renderer as unknown as RendererInfoView).info?.render?.triangles;
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

      // Keyboard `input_action` capture (ADR 0023). three has no keyboard
      // observable, so listen on `window` (the canvas rarely holds focus in
      // pointer-lock / FPS scenes). Only allowlisted keys are recorded: the
      // physical `code` is looked up and the mapped semantic action emitted.
      // Auto-repeat keydowns are dropped so a held key fires once; unbound keys
      // are ignored, so arbitrary typing is never seen.
      if (want.keyboard && typeof window !== "undefined") {
        const target = window as unknown as EventTargetView;
        const onKey = (pressed: boolean) => (raw: unknown) => {
          const ev = raw as { code?: string; repeat?: boolean };
          const code = ev.code;
          if (!code || (pressed && ev.repeat)) return;
          const action = keyBindings[code];
          if (!action) return;
          ctx.trackInput(action, { source: "keyboard", code, pressed });
        };
        const downHandler = onKey(true);
        const upHandler = onKey(false);
        target.addEventListener("keydown", downHandler);
        target.addEventListener("keyup", upHandler);
        domListeners.push({ target, type: "keydown", handler: downHandler });
        domListeners.push({ target, type: "keyup", handler: upHandler });
      }

      return {
        stop() {
          // Run trailing flushes (windowed/episodic captures) before teardown.
          for (const cb of stopCallbacks) cb();
          stopCallbacks.length = 0;
          disposed = true;
          for (const t of timers) clearInterval(t);
          timers.length = 0;
          if (rafId !== undefined && typeof cancelAnimationFrame === "function") {
            cancelAnimationFrame(rafId);
          }
          rafId = undefined;
          frameCallbacks.length = 0;
          for (const l of domListeners) l.target.removeEventListener(l.type, l.handler);
          domListeners.length = 0;
        },
      };
    },
  };
}
