import type { SceneProxy, Vec3 } from "@uptimizr/schema";
import type { CollectorContext } from "@uptimizr/sdk-core";
import type { NativeFrame } from "./types.js";
import { normalizeDirection, normalizePosition } from "./normalize.js";
import type { BridgeSceneNode } from "./sceneProxy.js";
import { buildSceneProxy } from "./sceneProxy.js";

/**
 * Bridge wire-protocol version. The JS-facing API the engine-side shim calls is
 * intentionally **minimal and stable**; bump this only on a breaking shape change
 * so a shim can assert compatibility (`bridge.protocolVersion`).
 */
export const BRIDGE_PROTOCOL_VERSION = 1;

/**
 * The versioned JS API a web-export engine's shim calls to push per-sample
 * telemetry across the WASM↔JS boundary (ADR 0045 §4). It carries **no** analytics
 * logic, IDs, or schema knowledge — the shim reads the engine's own
 * camera/raycast/perf and hands **world-space values in the engine's native frame**
 * to these methods. The connector owns all normalization and schema mapping.
 *
 * Privacy (ADR 0003): only low-cardinality, non-PII telemetry crosses the bridge —
 * poses, FPS, and developer-assigned **named** objects. The shim MUST NOT invent
 * identifiers or forward raw input text.
 */
export interface EngineBridge {
  /** The protocol version this bridge implements (see {@link BRIDGE_PROTOCOL_VERSION}). */
  readonly protocolVersion: number;
  /**
   * Push a camera pose. `position` / `forward` / `up` are world-space in the
   * engine's native frame; `fov` is vertical field of view in radians. Emits a
   * `camera_sample` (the backbone of the view-direction heatmap).
   */
  pushPose(position: Vec3, forward: Vec3, up: Vec3, fov?: number): void;
  /**
   * Push a raycast pick: a developer-named object and the world-space hit point in
   * the engine's native frame. Emits a `mesh_interaction` (`kind: "pick"`).
   */
  pushPick(objectName: string, hitPoint: Vec3): void;
  /**
   * Push an engine-measured performance sample. Emits a `frame_perf`. Use this when
   * the engine's own frame loop is a better FPS source than the JS-only rAF timing
   * (in which case disable the JS-only `perf` channel to avoid double counting).
   */
  pushPerf(fps: number, longFrames?: number): void;
  /**
   * Push the scene's spatial proxy — world-space AABBs of named nodes in the
   * engine's native frame. The connector normalizes and builds a wire-correct
   * {@link SceneProxy}; registering it with the collector is the host's
   * responsibility (see the `onSceneProxy` option).
   */
  setSceneProxy(nodes: BridgeSceneNode[]): void;
  /** Detach the bridge; subsequent pushes become no-ops. */
  dispose(): void;
}

export interface CreateEngineBridgeOptions {
  /** The collector context to emit through. */
  ctx: CollectorContext;
  /** The engine's native coordinate frame (for normalization + the proxy). */
  frame: NativeFrame;
  /** Scene id used when building a {@link SceneProxy} from `setSceneProxy`. */
  sceneId?: string;
  /** Invoked with a wire-correct proxy whenever the engine pushes one. */
  onSceneProxy?: (proxy: SceneProxy) => void;
}

/**
 * Create an {@link EngineBridge} bound to a collector context and an engine's
 * native frame. Every world-space payload is normalized to the canonical wire
 * frame (ADR 0018) at this boundary, keeping "events live once" and the
 * coordinate-frame conversion in **one** place across all three engine connectors.
 */
export function createEngineBridge(options: CreateEngineBridgeOptions): EngineBridge {
  const { ctx, frame, sceneId, onSceneProxy } = options;
  let disposed = false;

  return {
    protocolVersion: BRIDGE_PROTOCOL_VERSION,

    pushPose(position, forward, _up, fov) {
      if (disposed) return;
      ctx.emit({
        type: "camera_sample",
        position: normalizePosition(position, frame),
        direction: normalizeDirection(forward, frame),
        ...(typeof fov === "number" ? { fov } : {}),
      });
    },

    pushPick(objectName, hitPoint) {
      if (disposed || !objectName) return;
      ctx.emit({
        type: "mesh_interaction",
        mesh: objectName,
        kind: "pick",
        point: normalizePosition(hitPoint, frame),
      });
    },

    pushPerf(fps, longFrames) {
      if (disposed) return;
      ctx.emit({
        type: "frame_perf",
        fps,
        ...(typeof longFrames === "number" ? { longFrames } : {}),
      });
    },

    setSceneProxy(nodes) {
      if (disposed || !onSceneProxy) return;
      const proxy = buildSceneProxy(nodes, {
        sceneId: sceneId ?? "default",
        frame,
        now: () => ctx.now(),
      });
      onSceneProxy(proxy);
    },

    dispose() {
      disposed = true;
    },
  };
}
