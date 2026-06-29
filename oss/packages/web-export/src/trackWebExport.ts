import { UptimizrClient } from "@uptimizr/sdk-core";
import type { StartMeta, Transport } from "@uptimizr/sdk-core";
import type { SceneProxy, SessionUser } from "@uptimizr/schema";
import type { NativeFrame } from "./types.js";
import type { CanvasView, JsOnlyCaptureOptions } from "./jsOnly.js";
import type { EngineBridge } from "./bridge.js";
import { webExportCollector } from "./collector.js";
import { buildConnector } from "./connector.js";

export interface TrackWebExportOptions {
  /** Project identifier (public, non-secret). */
  projectId: string;
  /** Collector endpoint base URL, e.g. `https://collect.example.com`. */
  endpoint: string;
  /** Connector / engine id (e.g. `"unity"`). */
  name: string;
  /** The engine's native coordinate frame. */
  frame: NativeFrame;
  /** Engine version recorded as connector provenance, when known. */
  version?: string;
  /** The render canvas (or a resolver) for the JS-only pointer tier. */
  canvas?: CanvasView | (() => CanvasView | null | undefined);
  /** Toggle the JS-only capture channels. */
  capture?: JsOnlyCaptureOptions;
  /** Minimum gap between `pointer_move` samples, ms. Default `250`. */
  pointerMoveThrottleMs?: number;
  /** rAF performance reporting window, ms. Default `2000`. */
  perfWindowMs?: number;
  /** Frame-time (ms) above which a frame counts as a long frame. Default `50`. */
  jankFrameMs?: number;
  /** Scene id used when the engine pushes a scene proxy over the bridge. */
  sceneId?: string;
  /** `window` global the engine shim finds the bridge on. Default `"__uptimizr_<name>__"`. */
  bridgeGlobal?: string | false;
  /** Invoked with a wire-correct {@link SceneProxy} when the engine pushes one. */
  onSceneProxy?: (proxy: SceneProxy) => void;
  /** Flush at least this often, in ms. Default 5000. Set 0 to disable the timer. */
  flushIntervalMs?: number;
  /** Provide a custom transport (e.g. to observe delivery). Defaults to beacon/fetch. */
  transport?: Transport;
  /** When true, collect nothing (e.g. respect Do-Not-Track). */
  disabled?: boolean;
  /** Emit debug logs to the console. */
  debug?: boolean;
  /** Caller-supplied, anonymized user context. Opt-in; never PII (ADR 0003). */
  user?: SessionUser;
  /** Page metadata / URL overrides for `session_start`. */
  meta?: Omit<StartMeta, "connector" | "user">;
}

/** What {@link trackWebExport} returns: the client plus the engine bridge handle. */
export interface WebExportSession {
  /** The started {@link UptimizrClient} — read `sessionId`, emit custom events, `stop()`. */
  client: UptimizrClient;
  /**
   * The {@link EngineBridge} the engine-side shim pushes through. Also exposed on
   * `window` (see `bridgeGlobal`) for shims that call JS by global name. `undefined`
   * only if the client is `disabled`.
   */
  bridge: EngineBridge | undefined;
}

/**
 * One-call web-export integration: create a client, register the shared web-export
 * collector (JS-only tier + engine bridge), and start the session with the engine's
 * connector provenance (ADR 0018). Per-engine packages wrap this with their native
 * frame baked in (`trackUnity` / `trackGodot` / `trackUnreal`).
 *
 * The JS-only tier captures immediately (pointer heatmaps + perf + errors) with no
 * engine code; wire the engine-side shim to the returned `bridge` (or its `window`
 * global) to add camera pose, world-space picks, and replay.
 */
export function trackWebExport(options: TrackWebExportOptions): WebExportSession {
  const client = new UptimizrClient({
    projectId: options.projectId,
    endpoint: options.endpoint,
    flushIntervalMs: options.flushIntervalMs,
    transport: options.transport,
    disabled: options.disabled,
    debug: options.debug,
  });

  let bridge: EngineBridge | undefined;
  client.use(
    webExportCollector({
      name: options.name,
      frame: options.frame,
      ...(options.canvas ? { canvas: options.canvas } : {}),
      ...(options.capture ? { capture: options.capture } : {}),
      ...(options.pointerMoveThrottleMs !== undefined
        ? { pointerMoveThrottleMs: options.pointerMoveThrottleMs }
        : {}),
      ...(options.perfWindowMs !== undefined ? { perfWindowMs: options.perfWindowMs } : {}),
      ...(options.jankFrameMs !== undefined ? { jankFrameMs: options.jankFrameMs } : {}),
      ...(options.sceneId ? { sceneId: options.sceneId } : {}),
      ...(options.bridgeGlobal !== undefined ? { bridgeGlobal: options.bridgeGlobal } : {}),
      ...(options.onSceneProxy ? { onSceneProxy: options.onSceneProxy } : {}),
      onBridge: (b) => {
        bridge = b;
      },
    }),
  );

  client.start({
    connector: buildConnector(options.name, options.frame, options.version),
    ...(options.user ? { user: options.user } : {}),
    ...options.meta,
  });

  return { client, bridge };
}
