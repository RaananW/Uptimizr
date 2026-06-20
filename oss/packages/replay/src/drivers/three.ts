import {
  fromCanonicalDirection,
  fromCanonicalPosition,
  fromCanonicalQuat,
} from "@uptimizr/sdk-core";
import type { AnyEvent, CustomPropValue } from "@uptimizr/schema";
import type { ReplayDriver } from "../types.js";

/**
 * Structural view of the three.js objects this driver writes to. Kept minimal and
 * structural so `three` stays an **optional peer dependency** — the driver never
 * imports three at runtime; the host page owns the scene and the real objects.
 */
interface ThreeReplayCamera {
  position: { set(x: number, y: number, z: number): void };
  /** `Object3D.lookAt(x, y, z)` — for a camera, orients so it looks at the point. */
  lookAt(x: number, y: number, z: number): void;
  /** Present on `PerspectiveCamera`. */
  isPerspectiveCamera?: boolean;
  /** Vertical FOV in **degrees** (three.js convention). */
  fov?: number;
  updateProjectionMatrix?: () => void;
}
interface ThreeReplayScene {
  /** three exposes the active camera per-render, not on the scene; pass it explicitly. */
  [key: string]: unknown;
}

/** A three.js node a replay can drive (an `Object3D` — mesh, group, etc.). */
export type ThreeReplayNode = object;

/**
 * Structural view of a three `Bone` (an `Object3D`) the skeleton driver writes.
 * Replay sets the bone's parent-relative **local** pose, matching what the
 * collector captured (ADR 0027 Tier 2).
 */
interface DrivableBone3D {
  name?: string;
  position?: { set(x: number, y: number, z: number): void };
  quaternion?: { set(x: number, y: number, z: number, w: number): void };
  scale?: { set(x: number, y: number, z: number): void };
}

/** Structural view of the three `Object3D` members the node driver writes. */
interface DrivableObject3D {
  name?: string;
  position?: { set(x: number, y: number, z: number): void };
  quaternion?: { set(x: number, y: number, z: number, w: number): void };
  scale?: { set(x: number, y: number, z: number): void };
  /** Direct children, walked to resolve a Tier-1 subtree `childPath` (ADR 0033). */
  children?: DrivableObject3D[];
  /** Present on a `SkinnedMesh`; carries the bones for Tier-2 drive-back. */
  skeleton?: { bones?: DrivableBone3D[] | null } | null;
}

/**
 * Walk a `/`-separated {@link NodeTransformEvent.childPath} from a resolved root
 * actor to the descendant node, matching each segment against direct children by
 * `name` (ADR 0033). Returns `null` if any segment is missing.
 */
function resolveChildByPath(root: DrivableObject3D, childPath: string): DrivableObject3D | null {
  let cur: DrivableObject3D | null = root;
  for (const segment of childPath.split("/")) {
    if (!segment) continue;
    const children: DrivableObject3D[] | undefined = cur?.children;
    if (!Array.isArray(children)) return null;
    cur = children.find((c: DrivableObject3D) => c.name === segment) ?? null;
    if (!cur) return null;
  }
  return cur;
}

/** Resolve a node entry (direct ref or `() => node`) to a live node, or `null`. */
function resolveReplayNode(
  entry: ThreeReplayNode | (() => ThreeReplayNode | null | undefined) | undefined,
): DrivableObject3D | null {
  if (!entry) return null;
  if (typeof entry === "function") {
    return (entry() as DrivableObject3D | null | undefined) ?? null;
  }
  return entry as DrivableObject3D;
}

export interface ThreeReplayDriverOptions {
  /** Scene to re-drive (read/write only — never emits analytics events). */
  scene: ThreeReplayScene;
  /** Camera to move. three has no `scene.activeCamera`, so this is required. */
  camera: ThreeReplayCamera;
  /** Called for each replayed pointer event, so the host can render a marker. */
  onPointer?: (
    screen: [number, number] | undefined,
    hitPoint: [number, number, number] | undefined,
    hitMesh: string | undefined,
    type: "pointer_move" | "pointer_click" | "pointer_down" | "pointer_up",
  ) => void;
  /** Called for each replayed mesh interaction, so the host can highlight it. */
  onMeshInteraction?: (
    mesh: string,
    kind: string,
    point: [number, number, number] | undefined,
  ) => void;
  /**
   * Scene-actor resolvers for `node_transform` drive-back (ADR 0027). Maps a
   * recorded `nodeId` to the live three `Object3D` to re-drive — a direct
   * reference or a `() => node` resolver. Tier-1 (world-frame) samples are
   * converted canonical → three and applied to the node's local transform
   * (correct for root actors). Tier-2 bone samples drive the matching named
   * `Bone` of the node's `skeleton` (a `SkinnedMesh`) in its local frame; every
   * sample is also forwarded via {@link onNodeTransform}.
   */
  nodes?: Record<string, ThreeReplayNode | (() => ThreeReplayNode | null | undefined)>;
  /**
   * Called for **every** replayed `node_transform` (Tier 1 and Tier 2), after any
   * node drive-back. The position/rotation are converted into three's
   * right-handed frame; `boneId` is set for Tier-2 samples.
   */
  onNodeTransform?: (
    nodeId: string,
    transform: {
      boneId: string | undefined;
      childPath: string | undefined;
      position: [number, number, number];
      rotation: [number, number, number, number];
      scale: [number, number, number] | undefined;
    },
    ts: number,
  ) => void;
  /**
   * Called for each replayed developer-defined `custom` event. The driver can't
   * know how to render an arbitrary domain event, so it forwards the name, props,
   * and timestamp for the host to visualize (marker, toast, log, ...).
   */
  onCustom?: (name: string, props: Record<string, CustomPropValue> | undefined, ts: number) => void;
  /**
   * Called for each replayed `input_action` (discrete keyboard/gamepad action,
   * ADR 0023). Forwarded with the action, raw `code`/`button`, source, and
   * timestamp so a replay UI can annotate the timeline.
   */
  onInputAction?: (
    input: {
      action: string;
      code: string | undefined;
      button: number | undefined;
      pressed: boolean | undefined;
      source: string | undefined;
    },
    ts: number,
  ) => void;
  /**
   * Called for each replayed browser/engine lifecycle event (viewport resize, tab
   * visibility, window focus, GPU context loss/restore). The driver doesn't
   * re-drive these — it forwards them so a replay UI can annotate the timeline.
   */
  onLifecycle?: (
    event:
      | { type: "viewport_resize"; width: number; height: number; dpr: number | undefined }
      | { type: "visibility_change"; state: "visible" | "hidden" }
      | { type: "focus_change"; focused: boolean }
      | { type: "context_lost" }
      | { type: "context_restored" },
    ts: number,
  ) => void;
  /**
   * Called for each replayed `runtime_error` event (opt-in capture, ADR 0013).
   * Forwarded so a replay UI can mark where a JS error or unhandled rejection
   * interrupted the session.
   */
  onError?: (
    error: {
      kind: "error" | "unhandledrejection";
      message: string;
      source: string | undefined;
      lineno: number | undefined;
      colno: number | undefined;
      stack: string | undefined;
    },
    ts: number,
  ) => void;
}

/**
 * three.js replay driver. Re-drives camera pose (and surfaces pointer/mesh events
 * to host callbacks) in the user's own three.js scene.
 *
 * ## Coordinate frame (canonical → three)
 * Events arrive in the canonical **left-handed, y-up** frame (ADR 0018); three is
 * **right-handed**, so world-space data is converted back with the shared
 * `fromCanonical*` helpers (the Z-negation reflection is its own inverse). Camera
 * orientation is applied via `camera.lookAt(target)` — `lookAt` resolves three's
 * −Z-forward convention internally, so the driver does **not** re-derive a forward
 * axis from the recorded direction (avoiding the orientation trap documented in
 * sdk-core `coordinates.ts`).
 *
 * It only reads/writes the scene — it never emits analytics events (ADR 0006).
 */
export function createThreeReplayDriver(options: ThreeReplayDriverOptions): ReplayDriver {
  return {
    reset() {
      // Camera state is fully determined by the next camera_sample, so there is
      // nothing to restore; host-rendered markers are the host's responsibility.
    },
    apply(event: AnyEvent) {
      switch (event.type) {
        case "camera_sample": {
          const cam = options.camera;
          if (!cam) return;
          // Position: canonical → three (Z-negated).
          const [px, py, pz] = fromCanonicalPosition(event.position, "right");
          cam.position.set(px, py, pz);
          // Look target: an explicit recorded target, else position + direction —
          // both converted to three's frame. lookAt handles the −Z forward axis.
          let tx: number;
          let ty: number;
          let tz: number;
          if (event.target) {
            [tx, ty, tz] = fromCanonicalPosition(event.target, "right");
          } else {
            const [dx, dy, dz] = fromCanonicalDirection(event.direction, "right");
            tx = px + dx;
            ty = py + dy;
            tz = pz + dz;
          }
          cam.lookAt(tx, ty, tz);
          // three's perspective FOV is in degrees; the wire carries radians.
          if (cam.isPerspectiveCamera && typeof event.fov === "number") {
            cam.fov = (event.fov * 180) / Math.PI;
            cam.updateProjectionMatrix?.();
          }
          break;
        }
        case "pointer_move":
        case "pointer_click":
        case "pointer_down":
        case "pointer_up": {
          // Convert the world-space hit point back into three's frame so a host
          // marker lands correctly; screen coords are engine-independent.
          const hitPoint = event.hitPoint
            ? fromCanonicalPosition(event.hitPoint, "right")
            : undefined;
          options.onPointer?.(event.screen, hitPoint, event.hitMesh, event.type);
          break;
        }
        case "mesh_interaction": {
          const point = event.point ? fromCanonicalPosition(event.point, "right") : undefined;
          options.onMeshInteraction?.(event.mesh, event.kind, point);
          break;
        }
        case "custom":
          options.onCustom?.(event.name, event.props, event.ts);
          break;
        case "input_action":
          options.onInputAction?.(
            {
              action: event.action,
              code: event.code,
              button: event.button,
              pressed: event.pressed,
              source: event.source,
            },
            event.ts,
          );
          break;
        case "viewport_resize":
          options.onLifecycle?.(
            { type: "viewport_resize", width: event.width, height: event.height, dpr: event.dpr },
            event.ts,
          );
          break;
        case "visibility_change":
          options.onLifecycle?.({ type: "visibility_change", state: event.state }, event.ts);
          break;
        case "focus_change":
          options.onLifecycle?.({ type: "focus_change", focused: event.focused }, event.ts);
          break;
        case "context_lost":
          options.onLifecycle?.({ type: "context_lost" }, event.ts);
          break;
        case "context_restored":
          options.onLifecycle?.({ type: "context_restored" }, event.ts);
          break;
        case "runtime_error":
          options.onError?.(
            {
              kind: event.kind,
              message: event.message,
              source: event.source,
              lineno: event.lineno,
              colno: event.colno,
              stack: event.stack,
            },
            event.ts,
          );
          break;
        case "camera_gesture":
          // Derived navigation annotation (ADR 0025); the camera trajectory is
          // reconstructed from camera_sample, so replay intentionally ignores it.
          break;
        case "node_transform": {
          const node = resolveReplayNode(options.nodes?.[event.nodeId]);
          if (node) {
            if (event.boneId !== undefined) {
              // Tier 2: drive the named bone's parent-relative LOCAL pose. The
              // canonical reflection conjugates a local transform the same way it
              // does a world one, so the same convert applies (ADR 0027).
              const bone = node.skeleton?.bones?.find((b) => b.name === event.boneId);
              if (bone) {
                const [px, py, pz] = fromCanonicalPosition(event.position, "right");
                bone.position?.set(px, py, pz);
                const [qx, qy, qz, qw] = fromCanonicalQuat(event.rotation, "right");
                bone.quaternion?.set(qx, qy, qz, qw);
                if (event.scale) {
                  bone.scale?.set(event.scale[0], event.scale[1], event.scale[2]);
                }
              }
            } else {
              // Tier 1: the declared root (no childPath) or a subtree child
              // resolved by its relative path (ADR 0033). Both carry a world-frame
              // pose; canonical → three (Z-negated position + reflected quat).
              const target =
                event.childPath === undefined ? node : resolveChildByPath(node, event.childPath);
              if (target) {
                const [px, py, pz] = fromCanonicalPosition(event.position, "right");
                target.position?.set(px, py, pz);
                const [qx, qy, qz, qw] = fromCanonicalQuat(event.rotation, "right");
                target.quaternion?.set(qx, qy, qz, qw);
                if (event.scale) {
                  target.scale?.set(event.scale[0], event.scale[1], event.scale[2]);
                }
              }
            }
          }
          // Forward the (frame-converted) sample so the host can render a proxy
          // marker or annotate the timeline; `boneId` is set for Tier-2 samples,
          // `childPath` for Tier-1 subtree children (ADR 0033).
          const fwdPos = fromCanonicalPosition(event.position, "right") as [number, number, number];
          const fwdRot = fromCanonicalQuat(event.rotation, "right") as [
            number,
            number,
            number,
            number,
          ];
          options.onNodeTransform?.(
            event.nodeId,
            {
              boneId: event.boneId,
              childPath: event.childPath,
              position: fwdPos,
              rotation: fwdRot,
              scale: event.scale,
            },
            event.ts,
          );
          break;
        }
        default:
          break;
      }
    },
  };
}
