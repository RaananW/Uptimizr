// playcanvas is a peer dependency; `Ray` / `Vec3` are the engine's own geometry
// primitives and have no WebGL/DOM dependency (pure math), so importing them at
// runtime is both necessary and safe. esbuild keeps `playcanvas` external — it is
// never bundled. This is the one place the connector touches `playcanvas` at
// runtime: the camera-pose path reads world transforms structurally instead (see
// `collector.ts`), because raycasting has no faithful structural substitute.
import { Ray, Vec3 } from "playcanvas";
import type { AppBase, BoundingBox, Entity, GraphNode } from "playcanvas";
import type { Vec3 as SchemaVec3 } from "@uptimizr/schema";

/** A raycast result: the world-space hit point and the hit object's name. */
export interface RaycastHit {
  /** Hit point in the source (PlayCanvas, right-handed) world frame. */
  point: SchemaVec3;
  /** The hit object's `name` (empty string when unnamed). */
  name: string;
}

/**
 * Probe the scene at the given normalized device coordinates (NDC, each in
 * `[-1, 1]`, y-up) and return the nearest visible hit, or `undefined` for a miss.
 *
 * The point is in the **source** world frame; the collector normalizes it to the
 * canonical frame at the emission boundary (it owns the coordinate contract).
 */
export type RaycastProbe = (ndcX: number, ndcY: number) => RaycastHit | undefined;

const OVERLAY_PREFIX = "uptimizr-";

/** Structural view of the camera Entity + component we read for picking. */
interface CameraPickView {
  camera?: {
    nearClip?: number;
    farClip?: number;
    /** Low-level `Camera` with `screenToWorld(x, y, z, cw, ch, out)`. */
    camera?: {
      screenToWorld(x: number, y: number, z: number, cw: number, ch: number, out: Vec3): Vec3;
    };
  };
}

/** Structural view of `app.graphicsDevice` dimensions / canvas. */
interface AppDeviceView {
  graphicsDevice?: {
    width?: number;
    height?: number;
    canvas?: { clientWidth?: number; clientHeight?: number; width?: number; height?: number };
  };
}

/** Structural view of a renderable graph node (Entity with mesh instances). */
interface RenderableNodeView {
  enabled?: boolean;
  render?: { meshInstances?: MeshInstanceView[] | null };
  model?: { meshInstances?: MeshInstanceView[] | null };
}
interface MeshInstanceView {
  visible?: boolean;
  aabb?: BoundingBox;
  node?: { name?: string };
}

/** Structural view of `app.root.forEach`. */
interface AppRootView {
  root?: { forEach?: (cb: (node: unknown) => void) => void };
}

/**
 * Build a {@link RaycastProbe} backed by PlayCanvas' own `Ray` + per-mesh-instance
 * world `BoundingBox.intersectsRay`. This is the PlayCanvas stand-in for Babylon's
 * `scene.onPointerObservable` pick info: the connector raycasts explicitly per
 * pointer event.
 *
 * Picking is **physics-free** — it tests render/model mesh-instance world AABBs and
 * never touches the rigidbody system (so no `ammo` dependency). Overlay meshes
 * (`uptimizr-` prefix) are skipped so analytics overlays never register as hits.
 * Reads only — it never mutates the scene.
 */
export function createSceneRaycaster(app: AppBase, cameraEntity: Entity): RaycastProbe {
  const ray = new Ray();
  const near = new Vec3();
  const far = new Vec3();
  const hitPoint = new Vec3();
  const best = new Vec3();

  return (ndcX, ndcY) => {
    const cam = (cameraEntity as unknown as CameraPickView).camera;
    const lowLevel = cam?.camera;
    if (!cam || !lowLevel) return undefined;
    const device = (app as unknown as AppDeviceView).graphicsDevice;
    const canvas = device?.canvas;
    const cw = canvas?.clientWidth || canvas?.width || device?.width || 1;
    const ch = canvas?.clientHeight || canvas?.height || device?.height || 1;

    // NDC (-1..1, y-up) → PlayCanvas screen pixels (top-left origin).
    const sx = ((ndcX + 1) / 2) * cw;
    const sy = ((1 - ndcY) / 2) * ch;
    const nearClip = cam.nearClip ?? 0.1;
    const farClip = cam.farClip ?? 1000;
    lowLevel.screenToWorld(sx, sy, nearClip, cw, ch, near);
    lowLevel.screenToWorld(sx, sy, farClip, cw, ch, far);

    ray.origin.copy(near);
    ray.direction.copy(far).sub(near).normalize();

    let bestDist = Infinity;
    let bestName: string | undefined;

    const root = (app as unknown as AppRootView).root;
    root?.forEach?.((raw) => {
      const node = raw as RenderableNodeView;
      if (node.enabled === false) return;
      const instances = node.render?.meshInstances ?? node.model?.meshInstances;
      if (!instances) return;
      for (const mi of instances) {
        if (mi.visible === false) continue;
        const name = mi.node?.name ?? "";
        if (name.startsWith(OVERLAY_PREFIX)) continue;
        const box = mi.aabb;
        if (!box || typeof box.intersectsRay !== "function") continue;
        if (!box.intersectsRay(ray, hitPoint)) continue;
        const dx = hitPoint.x - ray.origin.x;
        const dy = hitPoint.y - ray.origin.y;
        const dz = hitPoint.z - ray.origin.z;
        const dist = dx * dx + dy * dy + dz * dz;
        if (dist < bestDist) {
          bestDist = dist;
          bestName = name;
          best.copy(hitPoint);
        }
      }
    });

    if (bestName === undefined) return undefined;
    return { point: [best.x, best.y, best.z], name: bestName };
  };
}

/** Gaze raycast tuning (`camera_sample.hitPoint`/`hitMesh`, ADR 0030). */
export interface GazeProbeOptions {
  /**
   * Max gaze-ray length in world units. Caps how far the camera-forward ray
   * reaches before it counts as a miss (keeps `hitPoint` meaningful and skips
   * sky/backdrop geometry). Default 1000.
   */
  maxDistance?: number;
  /**
   * Allowlist of object names eligible for a gaze hit (low-cardinality,
   * app-defined — ADR 0003). When omitted, any visible object can be hit. Provide
   * this to keep `hitMesh` cardinality meaningful and to exclude ground/sky/helper
   * objects from "what did people look at".
   */
  meshes?: string[];
  /**
   * Predicate escape hatch: return `false` to exclude a node from gaze picking
   * (e.g. sky, ground, gizmos). Combined with {@link meshes} (a node must pass both
   * the allowlist, if any, and the predicate, if any).
   */
  predicate?: (node: GraphNode) => boolean;
}

/** A camera-forward gaze probe: returns the nearest surface hit, or `undefined`. */
export type GazeProbe = () => RaycastHit | undefined;

/**
 * Build a {@link GazeProbe} that casts the camera's forward ray — NDC centre
 * `(0, 0)`, i.e. the screen centre pixel — into the scene (ADR 0030). This is the
 * PlayCanvas stand-in for Babylon's `camera.getForwardRay()` + `scene.pickWithRay()`.
 *
 * Performance: a single reused `Ray` + scratch vectors (no per-sample allocation),
 * `maxDistance` clamps the ray, and the caller rides the throttled, idle-suppressed
 * camera cadence so a pick runs at most once per emitted pose. Picking is
 * physics-free (mesh-instance world AABBs only — no `ammo`), overlay meshes
 * (`uptimizr-` prefix) are skipped, and the allowlist/predicate are applied during
 * traversal so an occluding non-match never hides an eligible hit behind it. Reads
 * only — it never mutates the scene.
 */
export function createGazeRaycaster(
  app: AppBase,
  cameraEntity: Entity,
  options: GazeProbeOptions = {},
): GazeProbe {
  const ray = new Ray();
  const near = new Vec3();
  const far = new Vec3();
  const hitPoint = new Vec3();
  const best = new Vec3();
  const maxDistance = options.maxDistance ?? 1000;
  const maxDistanceSq = maxDistance * maxDistance;
  const allow = options.meshes && options.meshes.length > 0 ? new Set(options.meshes) : null;
  const predicate = options.predicate;

  return () => {
    const cam = (cameraEntity as unknown as CameraPickView).camera;
    const lowLevel = cam?.camera;
    if (!cam || !lowLevel) return undefined;
    const device = (app as unknown as AppDeviceView).graphicsDevice;
    const canvas = device?.canvas;
    const cw = canvas?.clientWidth || canvas?.width || device?.width || 1;
    const ch = canvas?.clientHeight || canvas?.height || device?.height || 1;

    // Camera-forward ray = screen centre (NDC origin).
    const sx = cw / 2;
    const sy = ch / 2;
    const nearClip = cam.nearClip ?? 0.1;
    const farClip = cam.farClip ?? 1000;
    lowLevel.screenToWorld(sx, sy, nearClip, cw, ch, near);
    lowLevel.screenToWorld(sx, sy, farClip, cw, ch, far);

    ray.origin.copy(near);
    ray.direction.copy(far).sub(near).normalize();

    let bestDist = Infinity;
    let bestName: string | undefined;

    const root = (app as unknown as AppRootView).root;
    root?.forEach?.((raw) => {
      const node = raw as RenderableNodeView;
      if (node.enabled === false) return;
      const instances = node.render?.meshInstances ?? node.model?.meshInstances;
      if (!instances) return;
      for (const mi of instances) {
        if (mi.visible === false) continue;
        const name = mi.node?.name ?? "";
        if (name.startsWith(OVERLAY_PREFIX)) continue;
        if (allow && !allow.has(name)) continue;
        if (predicate && mi.node && !predicate(mi.node as unknown as GraphNode)) continue;
        const box = mi.aabb;
        if (!box || typeof box.intersectsRay !== "function") continue;
        if (!box.intersectsRay(ray, hitPoint)) continue;
        const dx = hitPoint.x - ray.origin.x;
        const dy = hitPoint.y - ray.origin.y;
        const dz = hitPoint.z - ray.origin.z;
        const dist = dx * dx + dy * dy + dz * dz;
        if (dist < bestDist) {
          bestDist = dist;
          bestName = name;
          best.copy(hitPoint);
        }
      }
    });

    if (bestName === undefined || bestDist > maxDistanceSq) return undefined;
    return { point: [best.x, best.y, best.z], name: bestName };
  };
}
