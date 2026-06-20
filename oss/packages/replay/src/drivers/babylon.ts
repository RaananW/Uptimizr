import { Vector3 } from "@babylonjs/core/Maths/math.vector.js";
import { Quaternion } from "@babylonjs/core/Maths/math.vector.js";
import type { Camera, Scene } from "@babylonjs/core";
import type { AnyEvent, CustomPropValue } from "@uptimizr/schema";
import type { ReplayDriver } from "../types.js";

export interface BabylonReplayDriverOptions {
  /** Scene to re-drive. */
  scene: Scene;
  /** Camera to move. Defaults to `scene.activeCamera`. */
  camera?: Camera;
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
   * recorded `nodeId` to the live Babylon node to re-drive — a direct
   * `TransformNode`/`AbstractMesh` or a `() => node` resolver (robust to load
   * order). Tier-1 samples set the node's world transform; Tier-2 samples
   * (`boneId` present) set the matching skeleton bone's local transform.
   */
  nodes?: Record<string, BabylonReplayNode | (() => BabylonReplayNode | null | undefined)>;
  /**
   * Called for **every** replayed `node_transform` (Tier 1 and Tier 2), after any
   * node/bone drive-back. Lets a host render a proxy marker for an actor it has
   * no live node for, or annotate the timeline. `boneId` is set for Tier-2 bone
   * samples; the transform is in the sample's frame (world for Tier 1,
   * skeleton-local for Tier 2).
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
   * know how to render an arbitrary domain event, so it forwards the name,
   * props, and timestamp for the host to visualize (marker, toast, log, ...).
   */
  onCustom?: (name: string, props: Record<string, CustomPropValue> | undefined, ts: number) => void;
  /**
   * Called for each replayed `input_action` (discrete keyboard/gamepad action,
   * ADR 0023). The driver can't re-drive an app-defined action, so it forwards
   * the action, raw `code`/`button`, source, and timestamp for the host to
   * annotate the timeline.
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
   * Called for each replayed browser/engine lifecycle event (viewport resize,
   * tab visibility, window focus, GPU context loss/restore). The driver doesn't
   * re-drive these — it forwards them so a replay UI can annotate the timeline
   * with what was happening around the scene.
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

interface SettableCamera {
  position: { set(x: number, y: number, z: number): void };
  setTarget?: (target: Vector3) => void;
  /**
   * Present on `ArcRotateCamera`: back-computes alpha/beta/radius from a world
   * position. Required because ArcRotate recomputes `position` from those each
   * frame, so a direct `position.set` is immediately overwritten.
   */
  setPosition?: (position: Vector3) => void;
}

/** A Babylon node a replay can drive (a `TransformNode` or `AbstractMesh`). */
export type BabylonReplayNode = object;

/** Structural view of the Babylon node members the node driver writes. */
interface DrivableNode {
  name?: string;
  position?: { set(x: number, y: number, z: number): void };
  rotationQuaternion?: Quaternion | null;
  scaling?: { set(x: number, y: number, z: number): void };
  setAbsolutePosition?: (position: Vector3) => void;
  /** `Node.getChildren()` — direct children, walked to resolve a `childPath` (ADR 0033). */
  getChildren?: () => DrivableNode[];
  skeleton?: { bones?: DrivableBone[] } | null;
}

/** Structural view of a Babylon `Bone` whose local pose the Tier-2 driver writes. */
interface DrivableBone {
  name?: string;
  position?: { set(x: number, y: number, z: number): void };
  rotationQuaternion?: Quaternion | null;
  scaling?: { set(x: number, y: number, z: number): void };
  markAsDirty?: () => void;
}

/** Resolve a node entry (direct ref or `() => node`) to a live node, or `null`. */
function resolveReplayNode(
  entry: BabylonReplayNode | (() => BabylonReplayNode | null | undefined) | undefined,
): DrivableNode | null {
  if (!entry) return null;
  if (typeof entry === "function") {
    return (entry() as DrivableNode | null | undefined) ?? null;
  }
  return entry as DrivableNode;
}

/**
 * Walk a `/`-separated {@link NodeTransformEvent.childPath} from a resolved root
 * actor to the descendant node, matching each segment against direct children by
 * `name` (ADR 0033). Returns `null` if any segment is missing.
 */
function resolveChildByPath(root: DrivableNode, childPath: string): DrivableNode | null {
  let cur: DrivableNode | null = root;
  for (const segment of childPath.split("/")) {
    if (!segment) continue;
    const children: DrivableNode[] | undefined = cur?.getChildren?.();
    if (!Array.isArray(children)) return null;
    cur = children.find((c: DrivableNode) => c.name === segment) ?? null;
    if (!cur) return null;
  }
  return cur;
}

/**
 * Babylon replay driver. Re-drives camera pose (and surfaces pointer/mesh events
 * to host callbacks) in the user's own scene.
 *
 * It only reads/writes the scene — it never emits analytics events (ADR 0006).
 */
export function createBabylonReplayDriver(options: BabylonReplayDriverOptions): ReplayDriver {
  const target = new Vector3();
  const position = new Vector3();
  const nodePosition = new Vector3();

  return {
    reset() {
      // Camera state is fully determined by the next camera_sample, so there is
      // nothing to restore; host-rendered markers are the host's responsibility.
    },
    apply(event: AnyEvent) {
      switch (event.type) {
        case "camera_sample": {
          const cam = (options.camera ??
            options.scene.activeCamera) as unknown as SettableCamera | null;
          if (!cam) return;
          const [px, py, pz] = event.position;
          if (event.target) {
            target.set(event.target[0], event.target[1], event.target[2]);
          } else {
            const [dx, dy, dz] = event.direction;
            target.set(px + dx, py + dy, pz + dz);
          }
          // Set the target first so ArcRotateCamera derives alpha/beta/radius
          // relative to it, then place the camera.
          cam.setTarget?.(target);
          if (typeof cam.setPosition === "function") {
            position.set(px, py, pz);
            cam.setPosition(position);
          } else {
            cam.position.set(px, py, pz);
          }
          break;
        }
        case "pointer_move":
        case "pointer_click":
        case "pointer_down":
        case "pointer_up":
          options.onPointer?.(event.screen, event.hitPoint, event.hitMesh, event.type);
          break;
        case "mesh_interaction":
          options.onMeshInteraction?.(event.mesh, event.kind, event.point);
          break;
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
              // Tier 2: drive the matching skeleton bone's LOCAL pose.
              const bone = node.skeleton?.bones?.find((b) => b.name === event.boneId);
              if (bone) {
                bone.position?.set(event.position[0], event.position[1], event.position[2]);
                bone.rotationQuaternion = new Quaternion(
                  event.rotation[0],
                  event.rotation[1],
                  event.rotation[2],
                  event.rotation[3],
                );
                if (event.scale) {
                  bone.scaling?.set(event.scale[0], event.scale[1], event.scale[2]);
                }
                bone.markAsDirty?.();
              }
            } else {
              // Tier 1: the declared root (no childPath) or a subtree child resolved
              // by its relative path (ADR 0033). Both carry a world-frame pose;
              // `setAbsolutePosition` honours any parent, a plain root falls back
              // to `position`.
              const target =
                event.childPath === undefined ? node : resolveChildByPath(node, event.childPath);
              if (target) {
                if (typeof target.setAbsolutePosition === "function") {
                  nodePosition.set(event.position[0], event.position[1], event.position[2]);
                  target.setAbsolutePosition(nodePosition);
                } else {
                  target.position?.set(event.position[0], event.position[1], event.position[2]);
                }
                // Babylon ignores `rotation` (Euler) once a quaternion is present;
                // assign a fresh one so the world orientation is applied verbatim.
                target.rotationQuaternion = new Quaternion(
                  event.rotation[0],
                  event.rotation[1],
                  event.rotation[2],
                  event.rotation[3],
                );
                if (event.scale) {
                  target.scaling?.set(event.scale[0], event.scale[1], event.scale[2]);
                }
              }
            }
          }
          options.onNodeTransform?.(
            event.nodeId,
            {
              boneId: event.boneId,
              childPath: event.childPath,
              position: event.position,
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
