// three is a peer dependency; `Raycaster` is the engine's own picking primitive
// and has no WebGL/DOM dependency (it is pure geometry math), so importing it at
// runtime is both necessary and safe. esbuild keeps `three` external — it is
// never bundled. This is the one place the connector touches `three` at runtime:
// the camera-pose path reads world transforms structurally instead (see
// `collector.ts`), because raycasting has no faithful structural substitute.
import { Raycaster } from "three";
import type { Camera, Object3D, Scene, Vector2 } from "three";
import type { Vec3 } from "@uptimizr/schema";

/** A raycast result: the world-space hit point and the hit object's name. */
export interface RaycastHit {
  /** Hit point in the source (three.js, right-handed) world frame. */
  point: Vec3;
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

interface SceneChildrenView {
  children?: Object3D[];
}

interface HitObjectView {
  name?: string;
  visible?: boolean;
}

/**
 * Build a {@link RaycastProbe} backed by a single reused `THREE.Raycaster` against
 * the live scene graph. This is the three.js stand-in for Babylon's
 * `scene.onPointerObservable` pick info: three has no pointer observable or
 * built-in scene pick, so the connector raycasts explicitly per pointer event.
 *
 * Overlay meshes (`uptimizr-` prefix, matching the proxy/heatmap convention) are
 * skipped so analytics overlays never register as hits. Reads only — it never
 * mutates the scene.
 */
export function createSceneRaycaster(scene: Scene, camera: Camera): RaycastProbe {
  const raycaster = new Raycaster();
  return (ndcX, ndcY) => {
    // three's `setFromCamera` reads `coords.x` / `coords.y`; a plain `{x,y}` works
    // structurally, avoiding a `THREE.Vector2` allocation per pointer event.
    raycaster.setFromCamera({ x: ndcX, y: ndcY } as unknown as Vector2, camera);
    const children = (scene as unknown as SceneChildrenView).children ?? [];
    const hits = raycaster.intersectObjects(children, true);
    for (const hit of hits) {
      const obj = hit.object as unknown as HitObjectView;
      const name = typeof obj.name === "string" ? obj.name : "";
      if (name.startsWith(OVERLAY_PREFIX)) continue;
      const p = hit.point;
      return { point: [p.x, p.y, p.z], name };
    }
    return undefined;
  };
}

/** Gaze raycast tuning (`camera_sample.hitPoint`/`hitMesh`, ADR 0030). */
export interface GazeProbeOptions {
  /**
   * Max gaze-ray length in world units (sets `Raycaster.far`). Caps how far the
   * gaze ray reaches before it counts as a miss and lets three's broad phase skip
   * distant geometry. Default 1000.
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
   * Predicate escape hatch: return `false` to exclude an object from gaze picking
   * (e.g. sky, ground, gizmos). Combined with {@link meshes} (an object must pass
   * both the allowlist, if any, and the predicate, if any).
   */
  predicate?: (object: Object3D) => boolean;
}

/** A camera-forward gaze probe: returns the nearest surface hit, or `undefined`. */
export type GazeProbe = () => RaycastHit | undefined;

/**
 * Build a {@link GazeProbe} backed by a single reused `THREE.Raycaster` that casts
 * the camera's forward ray — i.e. NDC centre `(0, 0)` — into the scene (ADR 0030).
 * This is the three.js stand-in for Babylon's `camera.getForwardRay()` +
 * `scene.pickWithRay()`. Performance: one reused raycaster + one shared NDC-centre
 * object (no per-sample allocation), `far` clamps the ray, and the caller rides the
 * throttled, idle-suppressed camera cadence so a pick runs at most once per emitted
 * pose. Overlay objects (`uptimizr-` prefix) are always skipped. Reads only.
 */
export function createGazeRaycaster(
  scene: Scene,
  camera: Camera,
  options: GazeProbeOptions = {},
): GazeProbe {
  const raycaster = new Raycaster();
  if (typeof options.maxDistance === "number") raycaster.far = options.maxDistance;
  const allow = options.meshes && options.meshes.length > 0 ? new Set(options.meshes) : null;
  const predicate = options.predicate;
  // Camera-forward ray = NDC centre. Reuse one structural Vector2 across samples.
  const center = { x: 0, y: 0 } as unknown as Vector2;
  return () => {
    raycaster.setFromCamera(center, camera);
    const children = (scene as unknown as SceneChildrenView).children ?? [];
    const hits = raycaster.intersectObjects(children, true);
    for (const hit of hits) {
      const obj = hit.object as unknown as HitObjectView & { name?: string };
      const name = typeof obj.name === "string" ? obj.name : "";
      if (name.startsWith(OVERLAY_PREFIX)) continue;
      if (allow && !allow.has(name)) continue;
      if (predicate && !predicate(hit.object as unknown as Object3D)) continue;
      const p = hit.point;
      return { point: [p.x, p.y, p.z], name };
    }
    return undefined;
  };
}
