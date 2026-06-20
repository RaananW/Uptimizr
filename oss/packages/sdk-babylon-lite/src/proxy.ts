import type { Mat4, SceneContext } from "@babylonjs/lite";
import { SDK_VERSION, toCanonicalAabb } from "@uptimizr/sdk-core";
import {
  SCENE_PROXY_VERSION,
  sceneProxySchema,
  type Aabb,
  type SceneProxy,
  type SceneProxyMesh,
  type UpAxis,
} from "@uptimizr/schema";

/**
 * Defensive view of the Babylon Lite mesh fields we read for proxy generation.
 * As with the collector, we read via this minimal structural interface rather
 * than binding to a concrete Lite type so the connector keeps `@babylonjs/lite`
 * as a pure peer dependency (no runtime import).
 *
 * `boundMin` / `boundMax` are Lite's **world-space** bounding box, populated by
 * asset loaders for camera framing. Procedurally-created meshes (`createBox`,
 * `createGround`, …) do not carry them; for those the host must supply a custom
 * {@link ScanSceneProxyOptions.boundsOf}.
 */
interface MeshProxyView {
  name?: string;
  visible?: boolean;
  worldMatrix?: Mat4;
  boundMin?: readonly [number, number, number];
  boundMax?: readonly [number, number, number];
}

/** Options for {@link scanSceneProxy}. */
export interface ScanSceneProxyOptions {
  /** Developer-assigned scene id this proxy describes (low-cardinality, no PII). */
  sceneId: string;
  /** SDK version stamped on the proxy. Defaults to the connector's SDK version. */
  sdkVersion?: string;
  /** World units per meter, if known. Default `1`. */
  unitScale?: number;
  /** Up axis of the scene. Default `"y"` (Lite). */
  upAxis?: UpAxis;
  /** Keep only the `maxMeshes` largest meshes (by box volume). Default: keep all. */
  maxMeshes?: number;
  /** Predicate to include a mesh by name. Default: include all (non-overlay) meshes. */
  includeMesh?: (name: string) => boolean;
  /** Clock for `capturedAt`. Default `Date.now`. */
  now?: () => number;
  /**
   * Compute a mesh's world AABB in Lite's native (left-handed) frame. Defaults to
   * reading the mesh's `boundMin` / `boundMax` world bounding box. Lite exposes
   * those only for loaded meshes, so hosts using procedural geometry should pass
   * a `boundsOf` that derives the box (e.g. from the mesh's `worldMatrix` and the
   * known shape extent). Also makes the scan testable with structural stubs.
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
 * Default world-AABB reader: returns the mesh's `boundMin` / `boundMax`
 * world-space bounding box when both are present, else `undefined` (the mesh is
 * skipped). Lite populates these only for loaded assets — procedural meshes need
 * a caller-supplied {@link ScanSceneProxyOptions.boundsOf}.
 */
function defaultBoundsOf(mesh: unknown): Aabb | undefined {
  const view = mesh as MeshProxyView;
  const lo = view.boundMin;
  const hi = view.boundMax;
  if (!lo || !hi) return undefined;
  return [lo[0], lo[1], lo[2], hi[0], hi[1], hi[2]];
}

/**
 * Traverse a Babylon Lite scene and produce an engine-agnostic {@link SceneProxy}
 * (per-mesh world AABBs — the first Tier 2 technique, ADR 0010). The proxy gives a
 * world-space heatmap a faint spatial backdrop without shipping the host's real
 * assets.
 *
 * Lite's native frame is left-handed, y-up, unit-scale 1 — the same as the
 * canonical wire frame (ADR 0018) — so {@link toCanonicalAabb} with `"left"` is an
 * identity, applied at the read boundary for provenance/symmetry. Overlay meshes
 * created by `@uptimizr/heatmap` (`uptimizr-` prefix), hidden meshes, and meshes
 * without resolvable bounds are skipped. The result is validated against
 * {@link sceneProxySchema} before return.
 */
export function scanSceneProxy(scene: SceneContext, options: ScanSceneProxyOptions): SceneProxy {
  const boundsOf = options.boundsOf ?? defaultBoundsOf;
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
      if (mesh.visible === false) continue;
      if (options.includeMesh && !options.includeMesh(name)) continue;

      const native = boundsOf(mesh);
      if (!native) continue;

      // Normalize the AABB to the canonical frame at the read boundary. Lite is
      // already left-handed, so this is an identity (kept for provenance).
      const canonical = toCanonicalAabb(native, "left");
      considered++;
      const aabb: Aabb = [
        round(canonical[0]),
        round(canonical[1]),
        round(canonical[2]),
        round(canonical[3]),
        round(canonical[4]),
        round(canonical[5]),
      ];
      meshes.push({ name, aabb });

      minX = Math.min(minX, canonical[0]);
      minY = Math.min(minY, canonical[1]);
      minZ = Math.min(minZ, canonical[2]);
      maxX = Math.max(maxX, canonical[3]);
      maxY = Math.max(maxY, canonical[4]);
      maxZ = Math.max(maxZ, canonical[5]);
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
      .map((m) => [m.name, m.aabb]),
  });

  const proxy: SceneProxy = {
    version: SCENE_PROXY_VERSION,
    sceneId: options.sceneId,
    kind: "aabb",
    bounds,
    upAxis: options.upAxis ?? "y",
    // Lite is left-handed; the AABBs above are already canonical.
    handedness: "left",
    unitScale: options.unitScale ?? 1,
    meshes: kept,
    meshCount: considered,
    contentHash: hashString(digestSource),
    capturedAt: (options.now ?? Date.now)(),
    sdkVersion: options.sdkVersion ?? SDK_VERSION,
  };

  return sceneProxySchema.parse(proxy);
}
