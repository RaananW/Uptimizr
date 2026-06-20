import { z } from "zod";
import { epochMsSchema, sceneIdSchema, vec3Schema, quatSchema } from "./primitives.js";
import { coordinateHandednessSchema, upAxisSchema } from "./coordinateSystem.js";
import { LIMITS } from "./limits.js";

// Re-export the up-axis primitive from its shared home so existing
// `./sceneProxy.js` importers keep working (see ADR 0018).
export { upAxisSchema, type UpAxis } from "./coordinateSystem.js";

/**
 * Scene **proxy** geometry: a compact, engine-agnostic description of a 3D scene's
 * spatial extent, used to give world-space heatmaps something to read against
 * without shipping (or trusting) the host's full scene assets (ADR 0010, Tier 2).
 *
 * A proxy is produced by a connector (e.g. `@uptimizr/babylon`'s `scanSceneProxy`)
 * from the live scene graph, stored in the scene registry keyed by `sceneId` +
 * `contentHash`, and consumed by the dashboard viewer to render a faint backdrop
 * beneath the heat. It is a wire contract, so — like events — it lives here and is
 * validated at the boundary.
 */

/**
 * Axis-aligned bounding box in world space, encoded as
 * `[minX, minY, minZ, maxX, maxY, maxZ]` (a compact tuple to match the event
 * vector convention).
 */
export const aabbSchema = z.tuple([
  z.number(),
  z.number(),
  z.number(),
  z.number(),
  z.number(),
  z.number(),
]);
export type Aabb = z.infer<typeof aabbSchema>;

/**
 * The representation technique a proxy uses. Only per-mesh AABB boxes are defined
 * today (the first Tier 2 technique); `"hull"` / `"voxel"` are reserved for future
 * proxy kinds and will be added as new literals (never repurpose `"aabb"`).
 */
export const sceneProxyKindSchema = z.literal("aabb");
export type SceneProxyKind = z.infer<typeof sceneProxyKindSchema>;

/**
 * A world-space transform (canonical frame, ADR 0018) recorded for a proxy mesh at
 * scan time: position `[x,y,z]`, rotation quaternion `[x,y,z,w]`, and scale
 * `[x,y,z]`. Enough to compose a 4×4 world matrix for rigid reconstruction.
 */
export const meshTransformSchema = z.object({
  position: vec3Schema,
  rotation: quatSchema,
  scale: vec3Schema,
});
export type MeshTransform = z.infer<typeof meshTransformSchema>;

/** One mesh's contribution to the proxy: a label and its world-space AABB. */
export const sceneProxyMeshSchema = z.object({
  /** Mesh name (or a stable identifier). Best-effort; may be empty. */
  name: z.string().max(LIMITS.maxSceneProxyMeshNameLength),
  /** World-space axis-aligned bounding box of the mesh. */
  aabb: aabbSchema,
  /** Triangle count, when the connector can cheaply determine it. */
  triangles: z.number().int().nonnegative().optional(),
  /**
   * Engine node path of the mesh from the scene root, `/`-joined by node name
   * (e.g. `"Machine_root/Body/Wheel"`). Optional — present only when the connector
   * records hierarchy for ADR 0033 rigid reconstruction. The path's leading
   * segment(s) let replay match a mesh to a declared actor root by name.
   */
  path: z.string().min(1).max(LIMITS.maxSceneProxyMeshPathLength).optional(),
  /**
   * The mesh's **world** transform at scan time, in the canonical frame (ADR 0018).
   * Optional — present only alongside {@link path}. Replay composes it with a
   * recorded root stream to reconstruct a rigid sub-assembly's motion without
   * capturing any per-child transform (ADR 0033 §3):
   * `childWorld(t) = rootWorld(t) · rootWorld(t0)⁻¹ · childWorldAtScan`.
   */
  world: meshTransformSchema.optional(),
});
export type SceneProxyMesh = z.infer<typeof sceneProxyMeshSchema>;

/** Current proxy wire-format version. Bump on a breaking shape change. */
export const SCENE_PROXY_VERSION = 1;

/**
 * A complete scene proxy. `contentHash` is a stable digest of the geometry (mesh
 * names + rounded boxes + overall bounds) so the registry can deduplicate and the
 * viewer can cache; it changes only when the proxied geometry meaningfully changes.
 */
export const sceneProxySchema = z.object({
  /** Proxy wire-format version (see {@link SCENE_PROXY_VERSION}). */
  version: z.literal(SCENE_PROXY_VERSION),
  /** Developer-assigned scene id this proxy describes. */
  sceneId: sceneIdSchema,
  /** Representation technique. */
  kind: sceneProxyKindSchema,
  /** Union of all mesh boxes — the overall world bounds of the scene. */
  bounds: aabbSchema,
  /** Up axis of the source scene. */
  upAxis: upAxisSchema,
  /**
   * Handedness of the source scene's coordinate system (ADR 0018). Optional for
   * backward compatibility; absent proxies predate the field and are Babylon
   * (left-handed). Distinct from XR controller handedness (ADR 0011).
   */
  handedness: coordinateHandednessSchema.optional(),
  /** World units per meter, if known (connector heuristic; defaults to 1). */
  unitScale: z.number().positive(),
  /**
   * Per-mesh world AABBs. Bounded at the boundary; connectors MUST cap huge
   * scenes locally (keep the largest/most-relevant meshes) and report the true
   * total in {@link meshCount} rather than send an unbounded list.
   */
  meshes: z.array(sceneProxyMeshSchema).max(LIMITS.maxSceneProxyMeshes),
  /** Total meshes considered (may exceed `meshes.length` if the list was capped). */
  meshCount: z.number().int().nonnegative(),
  /** Stable content digest for dedupe/versioning/caching. */
  contentHash: z.string().min(1),
  /** When the proxy was captured (epoch ms). */
  capturedAt: epochMsSchema,
  /** SDK version that produced the proxy. */
  sdkVersion: z.string().min(1),
});
export type SceneProxy = z.infer<typeof sceneProxySchema>;
