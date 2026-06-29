import type { Aabb, SceneProxy } from "@uptimizr/schema";
import { SCENE_PROXY_VERSION, sceneProxySchema } from "@uptimizr/schema";
import { SDK_VERSION } from "@uptimizr/sdk-core";
import type { NativeFrame } from "./types.js";
import { normalizeAabb } from "./normalize.js";

/** One world-space node pushed over the bridge for the scene proxy (ADR 0010). */
export interface BridgeSceneNode {
  /** Mesh / node name (best-effort; may be empty). */
  name: string;
  /** World-space axis-aligned bounding box in the engine's **native** frame. */
  aabb: Aabb;
}

/** Round to 4 decimals — matches the JS-engine connectors' proxy precision. */
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

export interface BuildSceneProxyOptions {
  sceneId: string;
  frame: NativeFrame;
  now?: () => number;
  sdkVersion?: string;
  /** Keep only the largest N meshes (by box volume) but report the true total. */
  maxMeshes?: number;
}

function aabbVolume(b: Aabb): number {
  return Math.abs((b[3] - b[0]) * (b[4] - b[1]) * (b[5] - b[2]));
}

/**
 * Build a wire-correct {@link SceneProxy} from the world-space nodes a web-export
 * engine pushed over the bridge (`setSceneProxy`). Every box is normalized from the
 * engine's native frame to the canonical frame (left-handed, y-up, unit scale 1)
 * before hashing or bounds computation, so the proxy is already canonical — `upAxis`
 * is `"y"`, `handedness` is `"left"`, and `unitScale` is `1`.
 *
 * Publishing the proxy to the collector's representation endpoint is the host's
 * responsibility (it is registered out-of-band, not on the event batch), mirroring
 * the JS-engine connectors' `scanSceneProxy`.
 */
export function buildSceneProxy(
  nodes: BridgeSceneNode[],
  options: BuildSceneProxyOptions,
): SceneProxy {
  const normalized = nodes.map((n) => {
    const aabb = normalizeAabb(n.aabb, options.frame).map(round) as Aabb;
    return { name: n.name, aabb };
  });

  const considered = normalized.length;
  let kept = normalized;
  if (typeof options.maxMeshes === "number" && options.maxMeshes >= 0 && kept.length > options.maxMeshes) {
    kept = [...normalized].sort((a, b) => aabbVolume(b.aabb) - aabbVolume(a.aabb)).slice(0, options.maxMeshes);
  }

  let minX = Infinity;
  let minY = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let maxZ = -Infinity;
  for (const m of normalized) {
    minX = Math.min(minX, m.aabb[0]);
    minY = Math.min(minY, m.aabb[1]);
    minZ = Math.min(minZ, m.aabb[2]);
    maxX = Math.max(maxX, m.aabb[3]);
    maxY = Math.max(maxY, m.aabb[4]);
    maxZ = Math.max(maxZ, m.aabb[5]);
  }
  const bounds: Aabb =
    considered === 0
      ? [0, 0, 0, 0, 0, 0]
      : [round(minX), round(minY), round(minZ), round(maxX), round(maxY), round(maxZ)];

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
    // Boxes were normalized above, so the proxy frame is canonical.
    upAxis: "y",
    handedness: "left",
    unitScale: 1,
    meshes: kept,
    meshCount: considered,
    contentHash: hashString(digestSource),
    capturedAt: (options.now ?? Date.now)(),
    sdkVersion: options.sdkVersion ?? SDK_VERSION,
  };

  return sceneProxySchema.parse(proxy);
}
