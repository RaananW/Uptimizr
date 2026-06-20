// `Box3` is three's own world-AABB primitive (pure geometry math, no WebGL/DOM),
// so importing it at runtime is the faithful way to compute per-mesh world bounds.
// esbuild keeps `three` external — it is never bundled.
import { Box3 } from "three";
import type { Object3D, Scene } from "three";
import {
  SDK_VERSION,
  decomposeWorldMatrix,
  toCanonicalAabb,
  toCanonicalPosition,
  toCanonicalQuat,
} from "@uptimizr/sdk-core";
import {
  SCENE_PROXY_VERSION,
  sceneProxySchema,
  type Aabb,
  type MeshTransform,
  type SceneProxy,
  type SceneProxyMesh,
  type UpAxis,
} from "@uptimizr/schema";

/** Defensive view of the three.js mesh fields we read for proxy generation. */
interface MeshProxyView {
  isMesh?: boolean;
  name?: string;
  visible?: boolean;
  /** Parent node — walked to build the mesh's `/`-joined path (ADR 0033). */
  parent?: MeshProxyView | null;
  /** `Object3D.matrixWorld` — column-major world transform, decomposed for `world`. */
  matrixWorld?: { elements?: ArrayLike<number> };
  geometry?: {
    index?: { count?: number } | null;
    attributes?: { position?: { count?: number } };
  };
}

/**
 * Build a node's `/`-joined path from the scene root (e.g. `"Machine_root/Body"`),
 * walking the `parent` chain up to but excluding `root`. Returns `undefined` if any
 * ancestor is unnamed (the path would not be stable enough for ADR 0033 matching).
 */
function buildNodePath(node: MeshProxyView, root: unknown): string | undefined {
  const names: string[] = [];
  let cur: MeshProxyView | null | undefined = node;
  while (cur && (cur as unknown) !== root) {
    const n = typeof cur.name === "string" ? cur.name : "";
    if (!n) return undefined;
    names.unshift(n);
    cur = cur.parent;
  }
  return names.length > 0 ? names.join("/") : undefined;
}

/**
 * Read a three node's scan-time world transform into the canonical frame (ADR
 * 0018), decomposing its column-major `matrixWorld`. Returns `undefined` when the
 * world matrix is unavailable (e.g. a structural stub) so reconstruction simply
 * stays off for that mesh.
 */
function readWorldTransform(node: MeshProxyView): MeshTransform | undefined {
  const e = node.matrixWorld?.elements;
  if (!e) return undefined;
  const d = decomposeWorldMatrix(e);
  return {
    position: toCanonicalPosition(d.position, "right"),
    rotation: toCanonicalQuat(d.rotation, "right"),
    scale: d.scale,
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
  /** Up axis of the scene. Default `"y"` (three.js). */
  upAxis?: UpAxis;
  /** Keep only the `maxMeshes` largest meshes (by box volume). Default: keep all. */
  maxMeshes?: number;
  /** Predicate to include a mesh by name. Default: include all (non-overlay) meshes. */
  includeMesh?: (name: string) => boolean;
  /** Clock for `capturedAt`. Default `Date.now`. */
  now?: () => number;
  /**
   * Compute a mesh's world AABB in the **source** (three.js, right-handed) frame.
   * Defaults to `new THREE.Box3().setFromObject(mesh)`. Overridable so the scan is
   * testable with structural mesh stubs (no real geometry/WebGL).
   */
  boundsOf?: (mesh: unknown) => Aabb | undefined;
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
 * Default world-AABB reader: three's `Box3.setFromObject` walks the mesh's
 * geometry under its world matrix. A single box instance is reused across calls.
 */
const sharedBox = new Box3();
function defaultBoundsOf(mesh: unknown): Aabb | undefined {
  sharedBox.makeEmpty();
  sharedBox.setFromObject(mesh as Object3D);
  if (sharedBox.isEmpty()) return undefined;
  const { min, max } = sharedBox;
  return [min.x, min.y, min.z, max.x, max.y, max.z];
}

function triangleCount(mesh: MeshProxyView): number {
  const geo = mesh.geometry;
  const indexCount = geo?.index?.count;
  if (typeof indexCount === "number" && indexCount > 0) return Math.floor(indexCount / 3);
  const posCount = geo?.attributes?.position?.count;
  if (typeof posCount === "number" && posCount > 0) return Math.floor(posCount / 3);
  return 0;
}

/**
 * Traverse a three.js scene graph and produce an engine-agnostic {@link SceneProxy}
 * (per-mesh world AABBs — the first Tier 2 technique, ADR 0010). The proxy gives a
 * world-space heatmap a faint spatial backdrop without shipping the host's real
 * assets.
 *
 * Each mesh AABB is computed in three's native right-handed frame, then normalized
 * to the canonical frame (left-handed, y-up) via {@link toCanonicalAabb} — negating
 * Z swaps each box's Z min/max so the result stays well-formed (ADR 0018). The
 * overall bounds accumulate over the already-converted boxes. Overlay meshes
 * (`uptimizr-` prefix) and non-mesh / empty nodes are skipped. The result is
 * validated against {@link sceneProxySchema} before return.
 */
export function scanSceneProxy(scene: Scene, options: ScanSceneProxyOptions): SceneProxy {
  const boundsOf = options.boundsOf ?? defaultBoundsOf;
  const meshes: SceneProxyMesh[] = [];

  let minX = Infinity;
  let minY = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let maxZ = -Infinity;
  let considered = 0;

  const traverse = (scene as unknown as { traverse?: (cb: (o: unknown) => void) => void }).traverse;
  if (typeof traverse === "function") {
    traverse.call(scene, (raw: unknown) => {
      const mesh = raw as MeshProxyView;
      if (!mesh.isMesh) return;
      const name = typeof mesh.name === "string" ? mesh.name : "";
      if (name.startsWith(OVERLAY_PREFIX)) return;
      if (mesh.visible === false) return;
      if (options.includeMesh && !options.includeMesh(name)) return;

      const native = boundsOf(mesh);
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
      const triangles = triangleCount(mesh);
      if (triangles > 0) entry.triangles = triangles;
      // ADR 0033: record hierarchy + scan-time world so replay can rigidly
      // reconstruct a sub-assembly from one root stream. Both or neither.
      const path = buildNodePath(mesh, scene);
      const world = readWorldTransform(mesh);
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
    // three.js is right-handed; the AABBs above are already converted to canonical.
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
