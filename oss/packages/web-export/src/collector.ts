import type { SceneProxy } from "@uptimizr/schema";
import type { Collector, CollectorContext, CollectorHandle } from "@uptimizr/sdk-core";
import type { NativeFrame } from "./types.js";
import type { CanvasView, JsOnlyCaptureOptions } from "./jsOnly.js";
import { startJsOnlyCapture } from "./jsOnly.js";
import type { EngineBridge } from "./bridge.js";
import { createEngineBridge } from "./bridge.js";

export interface WebExportCollectorOptions {
  /** Connector / engine id used as the collector name and provenance (e.g. `"unity"`). */
  name: string;
  /** The engine's native coordinate frame (for normalization + provenance). */
  frame: NativeFrame;
  /** The render canvas (or a resolver) for the JS-only pointer tier. */
  canvas?: CanvasView | (() => CanvasView | null | undefined);
  /** Toggle the JS-only (zero-engine-code) capture channels. */
  capture?: JsOnlyCaptureOptions;
  /** Minimum gap between `pointer_move` samples, ms. Default `250`. */
  pointerMoveThrottleMs?: number;
  /** rAF performance reporting window, ms. Default `2000`. */
  perfWindowMs?: number;
  /** Frame-time (ms) above which a frame counts as a long frame. Default `50`. */
  jankFrameMs?: number;
  /** Scene id used when the engine pushes a scene proxy over the bridge. */
  sceneId?: string;
  /**
   * Where to expose the {@link EngineBridge} for the engine-side WASM shim to find,
   * as a `window` property name. The shim calls the bridge by this global (e.g. a
   * Unity `.jslib` plugin or a Godot `JavaScriptBridge`). Default
   * `"__uptimizr_<name>__"`. Pass `false` to not attach a global (use `onBridge`).
   */
  bridgeGlobal?: string | false;
  /** Invoked with the {@link EngineBridge} when the collector starts. */
  onBridge?: (bridge: EngineBridge) => void;
  /** Invoked with a wire-correct {@link SceneProxy} when the engine pushes one. */
  onSceneProxy?: (proxy: SceneProxy) => void;
}

interface WindowWithBridges {
  [key: string]: unknown;
}

/**
 * The shared web-export collector (ADR 0045). Registered with an sdk-core client via
 * `client.use(...)`, it:
 *
 * 1. starts the **JS-only tier** (canvas pointer + rAF perf + error capture) — the
 *    zero-engine-code result every web export gets for free; and
 * 2. creates an {@link EngineBridge} bound to the engine's native frame and exposes
 *    it (as a `window` global and/or via `onBridge`) so the engine-side shim can
 *    push pose / picks / perf / scene-proxy, which the connector normalizes to the
 *    canonical wire frame and emits as schema events.
 *
 * The per-engine packages (`@uptimizr/unity` / `@uptimizr/godot` / `@uptimizr/unreal`)
 * wrap this with their native frame baked in.
 */
export function webExportCollector(options: WebExportCollectorOptions): Collector {
  return {
    name: options.name,
    start(ctx: CollectorContext): CollectorHandle {
      const stopJsOnly = startJsOnlyCapture({
        ctx,
        ...(options.canvas ? { canvas: options.canvas } : {}),
        ...(options.capture ? { capture: options.capture } : {}),
        ...(options.pointerMoveThrottleMs !== undefined
          ? { pointerMoveThrottleMs: options.pointerMoveThrottleMs }
          : {}),
        ...(options.perfWindowMs !== undefined ? { perfWindowMs: options.perfWindowMs } : {}),
        ...(options.jankFrameMs !== undefined ? { jankFrameMs: options.jankFrameMs } : {}),
      });

      const bridge = createEngineBridge({
        ctx,
        frame: options.frame,
        ...(options.sceneId ? { sceneId: options.sceneId } : {}),
        ...(options.onSceneProxy ? { onSceneProxy: options.onSceneProxy } : {}),
      });

      const globalKey =
        options.bridgeGlobal === false
          ? undefined
          : (options.bridgeGlobal ?? `__uptimizr_${options.name}__`);
      if (globalKey && typeof globalThis !== "undefined") {
        (globalThis as unknown as WindowWithBridges)[globalKey] = bridge;
      }

      options.onBridge?.(bridge);

      return {
        stop() {
          stopJsOnly();
          bridge.dispose();
          if (globalKey && typeof globalThis !== "undefined") {
            delete (globalThis as unknown as WindowWithBridges)[globalKey];
          }
        },
      };
    },
  };
}
