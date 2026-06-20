import type { Scene } from "@babylonjs/core";
import { SDK_VERSION } from "@uptimizr/sdk-core";
import {
  SCENE_PROXY_VERSION,
  sceneProxySchema,
  type Aabb,
  type MeshTransform,
  type SceneProxy,
  type SceneProxyMesh,
  type UpAxis,
} from "@uptimizr/schema";

/** A minimal `{x,y,z}` / `{x,y,z,w}` view of a Babylon vector/quaternion. */
interface Xyzw {
  x: number;
  y: number;
  z: number;
  w?: number;
}

/**
 * Defensive view of the Babylon mesh fields we read for proxy generation. As with
 * {@link "./scene".readSceneMeta}, we read via this minimal interface rather than
 * binding to `AbstractMesh` so the connector keeps `@babylonjs/core` as a pure
 * peer dependency (no runtime import).
 */
interface MeshProxyView {
  name?: string;
  isEnabled?: (checkAncestors?: boolean) => boolean;
  getTotalVertices?: () => number;
  getTotalIndices?: () => number;
  computeWorldMatrix?: (force?: boolean) => unknown;
  /** Parent `Node` — walked to build the mesh's `/`-joined path (ADR 0033). */
  parent?: MeshProxyView | null;
  /** World-frame accessors (Babylon is the canonical frame, ADR 0018). */
  absolutePosition?: Xyzw;
  absoluteRotationQuaternion?: Xyzw;
  absoluteScaling?: Xyzw;
  getBoundingInfo?: () => {
    boundingBox?: {
      minimumWorld?: { x: number; y: number; z: number };
      maximumWorld?: { x: number; y: number; z: number };
    };
  } | null;
}

/**
 * Build a node's `/`-joined path from its ancestry (e.g. `"Machine_root/Body"`),
 * walking the `parent` chain. Returns `undefined` if any ancestor is unnamed (the
 * path would not be stable enough for ADR 0033 matching).
 */
function buildNodePath(node: MeshProxyView): string | undefined {
  const names: string[] = [];
  let cur: MeshProxyView | null | undefined = node;
  while (cur) {
    const n = typeof cur.name === "string" ? cur.name : "";
    if (!n) return undefined;
    names.unshift(n);
    cur = cur.parent;
  }
  return names.length > 0 ? names.join("/") : undefined;
}

/**
 * Read a Babylon mesh's scan-time world transform. Babylon is the canonical frame
 * (left-handed, y-up, ADR 0018), so the absolute accessors are used directly —
 * mirroring the `node_transform` sampler. Returns `undefined` when the accessors
 * are absent (e.g. a structural stub) so reconstruction stays off for that mesh.
 */
function readWorldTransform(node: MeshProxyView): MeshTransform | undefined {
  const p = node.absolutePosition;
  const q = node.absoluteRotationQuaternion;
  const s = node.absoluteScaling;
  if (!p || !q || !s) return undefined;
  return {
    position: [p.x, p.y, p.z],
    rotation: [q.x, q.y, q.z, q.w ?? 1],
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
  /** Up axis of the scene. Default `"y"` (Babylon). */
  upAxis?: UpAxis;
  /** Keep only the `maxMeshes` largest meshes (by box volume). Default: keep all. */
  maxMeshes?: number;
  /** Predicate to include a mesh by name. Default: include all (non-overlay) meshes. */
  includeMesh?: (name: string) => boolean;
  /** Clock for `capturedAt`. Default `Date.now`. */
  now?: () => number;
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

/**
 * Traverse a Babylon scene graph and produce an engine-agnostic {@link SceneProxy}
 * (per-mesh world AABBs — the first Tier 2 technique, ADR 0010). The proxy gives a
 * world-space heatmap a faint spatial backdrop without shipping the host's real
 * assets.
 *
 * Only reads the scene (computes world matrices and reads world bounding boxes);
 * it never mutates geometry. Overlay meshes created by `@uptimizr/heatmap`
 * (`uptimizr-` prefix) and vertex-less nodes are skipped. The result is validated
 * against {@link sceneProxySchema} before return, so callers get a wire-correct
 * proxy or a thrown error.
 */
export function scanSceneProxy(scene: Scene, options: ScanSceneProxyOptions): SceneProxy {
  const meshesRaw = (scene as unknown as { meshes?: unknown[] }).meshes;
  const meshes: SceneProxyMesh[] = [];

  let minX = Infinity;
  let minY = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let maxZ = -Infinity;
  let considered = 0;

  if (Array.isArray(meshesRaw)) {
    for (const raw of meshesRaw) {
      const mesh = raw as MeshProxyView;
      const name = typeof mesh.name === "string" ? mesh.name : "";
      if (name.startsWith(OVERLAY_PREFIX)) continue;
      if (typeof mesh.isEnabled === "function" && !mesh.isEnabled(false)) continue;
      const vertices = typeof mesh.getTotalVertices === "function" ? mesh.getTotalVertices() : 0;
      if (vertices <= 0) continue;
      if (options.includeMesh && !options.includeMesh(name)) continue;

      mesh.computeWorldMatrix?.(true);
      const box = mesh.getBoundingInfo?.()?.boundingBox;
      const lo = box?.minimumWorld;
      const hi = box?.maximumWorld;
      if (!lo || !hi) continue;

      considered++;
      const aabb: Aabb = [
        round(lo.x),
        round(lo.y),
        round(lo.z),
        round(hi.x),
        round(hi.y),
        round(hi.z),
      ];
      const indices = typeof mesh.getTotalIndices === "function" ? mesh.getTotalIndices() : 0;
      const entry: SceneProxyMesh = { name, aabb };
      if (indices > 0) entry.triangles = Math.floor(indices / 3);
      // ADR 0033: record hierarchy + scan-time world so replay can rigidly
      // reconstruct a sub-assembly from one root stream. Both or neither.
      const path = buildNodePath(mesh);
      const world = readWorldTransform(mesh);
      if (path && world) {
        entry.path = path;
        entry.world = world;
      }
      meshes.push(entry);

      minX = Math.min(minX, lo.x);
      minY = Math.min(minY, lo.y);
      minZ = Math.min(minZ, lo.z);
      maxX = Math.max(maxX, hi.x);
      maxY = Math.max(maxY, hi.y);
      maxZ = Math.max(maxZ, hi.z);
    }
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
    handedness:
      (scene as unknown as { useRightHandedSystem?: boolean }).useRightHandedSystem === true
        ? "right"
        : "left",
    unitScale: options.unitScale ?? 1,
    meshes: kept,
    meshCount: considered,
    contentHash: hashString(digestSource),
    capturedAt: (options.now ?? Date.now)(),
    sdkVersion: options.sdkVersion ?? SDK_VERSION,
  };

  return sceneProxySchema.parse(proxy);
}
