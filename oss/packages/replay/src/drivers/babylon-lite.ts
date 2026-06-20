import { fromCanonicalDirection, fromCanonicalPosition } from "@uptimizr/sdk-core";
import type { AnyEvent, CustomPropValue } from "@uptimizr/schema";
import type { ReplayDriver } from "../types.js";

/**
 * Structural view of the Babylon Lite `ArcRotateCamera` this driver re-drives.
 * Kept minimal and structural so `@babylonjs/lite` stays an **optional peer
 * dependency** — the driver never imports Lite at runtime; the host page owns the
 * camera. Lite's `ArcRotateCamera` recomputes its world matrix from
 * `alpha`/`beta`/`radius`/`target` each frame, so those are the source of truth
 * (there is no settable world `position`).
 */
interface LiteReplayArcCamera {
  alpha: number;
  beta: number;
  radius: number;
  target: { x: number; y: number; z: number };
  /** Vertical FOV in **radians** (Lite convention — matches the canonical wire). */
  fov?: number;
}

/** A Babylon Lite node a replay can drive (a `TransformNode`/mesh). */
export type BabylonLiteReplayNode = object;

/** Structural view of the Lite node members the node driver writes. */
interface DrivableLiteNode {
  position?: { set(x: number, y: number, z: number): void };
  rotationQuaternion?: { set(x: number, y: number, z: number, w: number): void } | null;
  scaling?: { set(x: number, y: number, z: number): void };
}

/** Resolve a node entry (direct ref or `() => node`) to a live node, or `null`. */
function resolveReplayNode(
  entry: BabylonLiteReplayNode | (() => BabylonLiteReplayNode | null | undefined) | undefined,
): DrivableLiteNode | null {
  if (!entry) return null;
  if (typeof entry === "function") {
    return (entry() as DrivableLiteNode | null | undefined) ?? null;
  }
  return entry as DrivableLiteNode;
}

export interface BabylonLiteReplayDriverOptions {
  /**
   * Camera to move. Re-driving requires a Lite `ArcRotateCamera` (it exposes
   * settable orbit state); other cameras have no settable world pose, so their
   * `camera_sample` pose is skipped (other events still forward).
   */
  camera: LiteReplayArcCamera | { [key: string]: unknown };
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
   * recorded `nodeId` to the live Lite node (`TransformNode`/mesh) to re-drive — a
   * direct reference or a `() => node` resolver. Lite is left-handed, so the
   * canonical world transform is applied as-is to the node's local
   * `position`/`rotationQuaternion`/`scaling` (correct for root actors). Tier-2
   * bone samples are forwarded via {@link onNodeTransform} only (skeleton
   * drive-back is Babylon-core-specific).
   */
  nodes?: Record<string, BabylonLiteReplayNode | (() => BabylonLiteReplayNode | null | undefined)>;
  /**
   * Called for **every** replayed `node_transform` (Tier 1 and Tier 2), after any
   * node drive-back. Lite shares the canonical frame, so values are forwarded
   * unconverted; `boneId` is set for Tier-2 samples.
   */
  onNodeTransform?: (
    nodeId: string,
    transform: {
      boneId: string | undefined;
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

/** True when the camera exposes Lite's settable orbit state. */
function isArcRotate(cam: unknown): cam is LiteReplayArcCamera {
  const c = cam as { alpha?: unknown; target?: unknown };
  return typeof c.alpha === "number" && c.target != null;
}

/**
 * Babylon Lite replay driver. Re-drives an `ArcRotateCamera` pose (and surfaces
 * pointer/mesh/custom/input/lifecycle/error events to host callbacks) in the
 * user's own Lite scene.
 *
 * ## Coordinate frame (canonical → Lite)
 * Events arrive in the canonical **left-handed, y-up** frame (ADR 0018). Babylon
 * Lite is **left-handed** too — the same frame — so `fromCanonical*` is the
 * identity. It is still called for symmetry with the right-handed drivers (three,
 * PlayCanvas), where it performs the real Z-negation.
 *
 * ## Camera re-drive
 * Lite's `ArcRotateCamera` derives its world matrix from `alpha`/`beta`/`radius`/
 * `target` each frame, so a recorded world position is mapped back to spherical
 * orbit state (Babylon's left-handed convention:
 * `pos = target + radius·(cos α·sin β, cos β, sin α·sin β)`). The recorded
 * `target` is used when present; otherwise it is derived from `position + direction`.
 *
 * It only reads/writes the scene — it never emits analytics events (ADR 0006).
 */
export function createBabylonLiteReplayDriver(
  options: BabylonLiteReplayDriverOptions,
): ReplayDriver {
  return {
    reset() {
      // Camera state is fully determined by the next camera_sample, so there is
      // nothing to restore; host-rendered markers are the host's responsibility.
    },
    apply(event: AnyEvent) {
      switch (event.type) {
        case "camera_sample": {
          if (!isArcRotate(options.camera)) return;
          const cam = options.camera;
          // Lite is left-handed → fromCanonical* is identity (symmetry with RHS drivers).
          const [px, py, pz] = fromCanonicalPosition(event.position, "left");
          let tx: number;
          let ty: number;
          let tz: number;
          if (event.target) {
            [tx, ty, tz] = fromCanonicalPosition(event.target, "left");
          } else {
            const [dx, dy, dz] = fromCanonicalDirection(event.direction, "left");
            tx = px + dx;
            ty = py + dy;
            tz = pz + dz;
          }
          // Invert Babylon's spherical mapping to recover orbit state.
          const ox = px - tx;
          const oy = py - ty;
          const oz = pz - tz;
          const radius = Math.hypot(ox, oy, oz);
          cam.target.x = tx;
          cam.target.y = ty;
          cam.target.z = tz;
          cam.radius = radius;
          if (radius > 1e-6) {
            const cosBeta = Math.min(1, Math.max(-1, oy / radius));
            cam.beta = Math.acos(cosBeta);
            cam.alpha = Math.atan2(oz, ox);
          }
          // Lite FOV is in radians — matches the canonical wire, so no conversion.
          if (typeof event.fov === "number") cam.fov = event.fov;
          break;
        }
        case "pointer_move":
        case "pointer_click":
        case "pointer_down":
        case "pointer_up": {
          const hitPoint = event.hitPoint
            ? fromCanonicalPosition(event.hitPoint, "left")
            : undefined;
          options.onPointer?.(event.screen, hitPoint, event.hitMesh, event.type);
          break;
        }
        case "mesh_interaction": {
          const point = event.point ? fromCanonicalPosition(event.point, "left") : undefined;
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
          if (event.boneId === undefined) {
            const node = resolveReplayNode(options.nodes?.[event.nodeId]);
            if (node) {
              // Lite is left-handed → fromCanonical* is identity (no conversion).
              const [px, py, pz] = fromCanonicalPosition(event.position, "left");
              node.position?.set(px, py, pz);
              const [qx, qy, qz, qw] = event.rotation;
              node.rotationQuaternion?.set(qx, qy, qz, qw);
              if (event.scale) {
                node.scaling?.set(event.scale[0], event.scale[1], event.scale[2]);
              }
            }
          }
          // Forward the sample so the host can render a proxy marker or annotate
          // the timeline (Tier-2 bone driving is Babylon-core-specific).
          options.onNodeTransform?.(
            event.nodeId,
            {
              boneId: event.boneId,
              position: fromCanonicalPosition(event.position, "left") as [number, number, number],
              rotation: event.rotation,
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
