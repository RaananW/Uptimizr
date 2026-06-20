import type { AppBase, BoundingBox } from "playcanvas";
import { SDK_VERSION, toCanonicalAabb, toCanonicalPosition, toCanonicalQuat } from "@uptimizr/sdk-core";
import {
  SCENE_PROXY_VERSION,
  sceneProxySchema,
  type Aabb,
  type MeshTransform,
  type SceneProxy,
  type SceneProxyMesh,
  type UpAxis,
} from "@uptimizr/schema";

/** A minimal `{x,y,z}` / `{x,y,z,w}` view of a PlayCanvas vector/quaternion. */
interface Xyzw {
  x: number;
  y: number;
  z: number;
  w?: number;
}

/** Defensive view of a PlayCanvas mesh instance we read for proxy generation. */
interface MeshInstanceView {
  visible?: boolean;
  aabb?: Pick<BoundingBox, "getMin" | "getMax">;
  mesh?: { primitive?: Array<{ count?: number }> | null } | null;
}

/** Defensive view of a renderable graph node (Entity with mesh instances). */
interface RenderableNodeView {
  name?: string;
  enabled?: boolean;
  render?: { meshInstances?: MeshInstanceView[] | null };
  model?: { meshInstances?: MeshInstanceView[] | null };
  /** Parent graph node — walked to build the node's `/`-joined path (ADR 0033). */
  parent?: RenderableNodeView | null;
  /** World-frame accessors (PlayCanvas is right-handed; converted to canonical). */
  getPosition?: () => Xyzw;
  getRotation?: () => Xyzw;
  getWorldTransform?: () => { getScale?: () => Xyzw };
}

/**
 * Build a node's `/`-joined path from the scene root (e.g. `"Machine_root/Body"`),
 * walking the `parent` chain up to but excluding `root`. Returns `undefined` if any
 * ancestor is unnamed (the path would not be stable enough for ADR 0033 matching).
 */
function buildNodePath(node: RenderableNodeView, root: unknown): string | undefined {
  const names: string[] = [];
  let cur: RenderableNodeView | null | undefined = node;
  while (cur && (cur as unknown) !== root) {
    const n = typeof cur.name === "string" ? cur.name : "";
    if (!n) return undefined;
    names.unshift(n);
    cur = cur.parent;
  }
  return names.length > 0 ? names.join("/") : undefined;
}

/**
 * Read a PlayCanvas node's scan-time world transform into the canonical frame (ADR
 * 0018), mirroring the `node_transform` sampler (world position/rotation + world
 * scale, converted from the native right-handed frame). Returns `undefined` when
 * the accessors are absent (e.g. a structural stub) so reconstruction stays off.
 */
function readWorldTransform(node: RenderableNodeView): MeshTransform | undefined {
  const p = node.getPosition?.();
  const q = node.getRotation?.();
  const s = node.getWorldTransform?.()?.getScale?.();
  if (!p || !q || !s) return undefined;
  return {
    position: toCanonicalPosition([p.x, p.y, p.z], "right"),
    rotation: toCanonicalQuat([q.x, q.y, q.z, q.w ?? 1], "right"),
    scale: [s.x, s.y, s.z],
  };
}

/** Options for {@link scanSceneProxy}. */
export interface ScanSceneProxyOptions {
  /** Developer-assigned scene id this proxy describes (low-cardinality, no PII). */
  sceneId: string;
  /** SDK version stamped on the proxy. Defaults to the connector's SDK version. */
  sdkVersion?: string;
  /** World units per meter, if known. Default `1`. */
  unitScale?: number;
  /** Up axis of the scene. Default `"y"` (PlayCanvas). */
  upAxis?: UpAxis;
  /** Keep only the `maxMeshes` largest meshes (by box volume). Default: keep all. */
  maxMeshes?: number;
  /** Predicate to include a mesh by name. Default: include all (non-overlay) meshes. */
  includeMesh?: (name: string) => boolean;
  /** Clock for `capturedAt`. Default `Date.now`. */
  now?: () => number;
  /**
   * Compute a renderable node's world AABB in the **source** (PlayCanvas,
   * right-handed) frame. Defaults to the union of the node's mesh-instance world
   * AABBs (`meshInstance.aabb`). Overridable so the scan is testable with
   * structural node stubs (no real geometry/WebGL).
   */
  boundsOf?: (node: unknown) => Aabb | undefined;
  /**
   * Compute a renderable node's triangle count. Defaults to summing the index
   * counts of the node's mesh primitives. Overridable for tests.
   */
  trianglesOf?: (node: unknown) => number;
}

const OVERLAY_PREFIX = "uptimizr-";

function round(n: number): number {
  return Math.round(n * 1e4) / 1e4;
}

/** 32-bit FNV-1a hash → 8-char hex. Browser-safe, dependency-free, deterministic. */
function hashString(input: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

function aabbVolume(box: Aabb): number {
  return Math.abs((box[3] - box[0]) * (box[4] - box[1]) * (box[5] - box[2]));
}

function meshInstancesOf(node: RenderableNodeView): MeshInstanceView[] {
  return node.render?.meshInstances ?? node.model?.meshInstances ?? [];
}

/**
 * Default world-AABB reader: the union of the node's mesh-instance world AABBs.
 * PlayCanvas exposes each instance's world `aabb` directly (no manual corner
 * transform, unlike three), so the union is a straight min/max accumulation.
 */
function defaultBoundsOf(raw: unknown): Aabb | undefined {
  const node = raw as RenderableNodeView;
  const instances = meshInstancesOf(node);
  if (instances.length === 0) return undefined;
  let minX = Infinity;
  let minY = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let maxZ = -Infinity;
  let found = false;
  for (const mi of instances) {
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
  if (!found) return undefined;
  return [minX, minY, minZ, maxX, maxY, maxZ];
}

/** Default triangle count: sum of the node's mesh primitive index counts / 3. */
function defaultTrianglesOf(raw: unknown): number {
  const node = raw as RenderableNodeView;
  let count = 0;
  for (const mi of meshInstancesOf(node)) {
    const primitives = mi.mesh?.primitive;
    if (!primitives) continue;
    for (const p of primitives) {
      if (typeof p.count === "number" && p.count > 0) count += Math.floor(p.count / 3);
    }
  }
  return count;
}

/**
 * Traverse a PlayCanvas scene graph and produce an engine-agnostic
 * {@link SceneProxy} (per-object world AABBs — the first Tier 2 technique, ADR
 * 0010). The proxy gives a world-space heatmap a faint spatial backdrop without
 * shipping the host's real assets.
 *
 * Each renderable entity's world AABB (the union of its mesh-instance boxes) is
 * read in PlayCanvas' native right-handed frame, then normalized to the canonical
 * frame (left-handed, y-up) via {@link toCanonicalAabb} — negating Z swaps each
 * box's Z min/max so the result stays well-formed (ADR 0018). Overlay objects
 * (`uptimizr-` prefix) and non-renderable / empty nodes are skipped. The result is
 * validated against {@link sceneProxySchema} before return.
 */
export function scanSceneProxy(app: AppBase, options: ScanSceneProxyOptions): SceneProxy {
  const boundsOf = options.boundsOf ?? defaultBoundsOf;
  const trianglesOf = options.trianglesOf ?? defaultTrianglesOf;
  const meshes: SceneProxyMesh[] = [];

  let minX = Infinity;
  let minY = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let maxZ = -Infinity;
  let considered = 0;

  const root = (app as unknown as { root?: { forEach?: (cb: (n: unknown) => void) => void } }).root;
  if (root && typeof root.forEach === "function") {
    root.forEach((raw: unknown) => {
      const node = raw as RenderableNodeView;
      if (node.enabled === false) return;
      if (meshInstancesOf(node).length === 0) return;
      const name = typeof node.name === "string" ? node.name : "";
      if (name.startsWith(OVERLAY_PREFIX)) return;
      if (options.includeMesh && !options.includeMesh(name)) return;

      const native = boundsOf(node);
      if (!native) return;

      // Normalize the AABB to the canonical frame at the read boundary.
      const canonical = toCanonicalAabb(native, "right");
      considered++;
      const aabb: Aabb = [
        round(canonical[0]),
        round(canonical[1]),
        round(canonical[2]),
        round(canonical[3]),
        round(canonical[4]),
        round(canonical[5]),
      ];
      const entry: SceneProxyMesh = { name, aabb };
      const triangles = trianglesOf(node);
      if (triangles > 0) entry.triangles = triangles;
      // ADR 0033: record hierarchy + scan-time world so replay can rigidly
      // reconstruct a sub-assembly from one root stream. Both or neither.
      const path = buildNodePath(node, root);
      const world = readWorldTransform(node);
      if (path && world) {
        entry.path = path;
        entry.world = world;
      }
      meshes.push(entry);

      minX = Math.min(minX, canonical[0]);
      minY = Math.min(minY, canonical[1]);
      minZ = Math.min(minZ, canonical[2]);
      maxX = Math.max(maxX, canonical[3]);
      maxY = Math.max(maxY, canonical[4]);
      maxZ = Math.max(maxZ, canonical[5]);
    });
  }

  // Optionally keep only the largest meshes (by box volume) but report the full count.
  let kept = meshes;
  if (
    typeof options.maxMeshes === "number" &&
    options.maxMeshes >= 0 &&
    meshes.length > options.maxMeshes
  ) {
    kept = [...meshes]
      .sort((a, b) => aabbVolume(b.aabb) - aabbVolume(a.aabb))
      .slice(0, options.maxMeshes);
  }

  const bounds: Aabb =
    considered === 0
      ? [0, 0, 0, 0, 0, 0]
      : [round(minX), round(minY), round(minZ), round(maxX), round(maxY), round(maxZ)];

  // Deterministic content hash: stable mesh ordering + rounded geometry + bounds.
  const digestSource = JSON.stringify({
    v: SCENE_PROXY_VERSION,
    kind: "aabb",
    bounds,
    meshes: [...kept]
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
      .map((m) =>
        m.path && m.world
          ? [m.name, m.aabb, m.path, m.world.position, m.world.rotation, m.world.scale]
          : [m.name, m.aabb],
      ),
  });

  const proxy: SceneProxy = {
    version: SCENE_PROXY_VERSION,
    sceneId: options.sceneId,
    kind: "aabb",
    bounds,
    upAxis: options.upAxis ?? "y",
    // PlayCanvas is right-handed; the AABBs above are already converted to canonical.
    handedness: "right",
    unitScale: options.unitScale ?? 1,
    meshes: kept,
    meshCount: considered,
    contentHash: hashString(digestSource),
    capturedAt: (options.now ?? Date.now)(),
    sdkVersion: options.sdkVersion ?? SDK_VERSION,
  };

  return sceneProxySchema.parse(proxy);
}
