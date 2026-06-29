/**
 * `@uptimizr/unity` — the Unity (WebGL export) connector for Uptimizr (ADR 0045).
 *
 * Unity compiles to WebAssembly and renders into a `<canvas>`, so there is no live
 * JS scene to read. This connector is **two-part**:
 *
 * - a **JS-only tier** (this package, no engine code) — pointer heatmaps, rAF FPS,
 *   and error capture straight from the canvas DOM; and
 * - a **bridged tier** — a thin engine-side shim (a `.jslib` plugin + a small
 *   `MonoBehaviour`, see `bridge/`) pushes camera pose / picks / perf over the
 *   versioned {@link EngineBridge} for view-direction heatmaps, world-space gaze,
 *   and replay.
 *
 * Unity's native world frame is **left-handed, y-up, meters** — already Uptimizr's
 * canonical wire frame, so world-space payloads need no axis conversion (the
 * normalization is the identity for Unity).
 */
import { trackWebExport, webExportCollector } from "@uptimizr/web-export";
import type {
  EngineBridge,
  NativeFrame,
  TrackWebExportOptions,
  WebExportCollectorOptions,
  WebExportSession,
} from "@uptimizr/web-export";
import type { Collector } from "@uptimizr/sdk-core";

/** Unity's native world coordinate frame: left-handed, y-up, meters (canonical). */
export const UNITY_FRAME: NativeFrame = { handedness: "left", upAxis: "y", unitScale: 1 };

/** The engine id used for connector provenance and the collector name. */
export const UNITY_CONNECTOR_NAME = "unity";

export type UnityCollectorOptions = Omit<WebExportCollectorOptions, "name" | "frame">;
export type TrackUnityOptions = Omit<TrackWebExportOptions, "name" | "frame">;

/**
 * The Unity collector — register it with an sdk-core client via `client.use(...)`.
 * Wires the JS-only tier and exposes the engine bridge (default global
 * `window.__uptimizr_unity__`) for the engine-side shim.
 */
export function unityCollector(options: UnityCollectorOptions = {}): Collector {
  return webExportCollector({ ...options, name: UNITY_CONNECTOR_NAME, frame: UNITY_FRAME });
}

/**
 * One-call Unity integration: create a client, register {@link unityCollector}, and
 * start the session with Unity's connector provenance (ADR 0018). Returns the client
 * and the {@link EngineBridge} the Unity shim pushes through.
 */
export function trackUnity(options: TrackUnityOptions): WebExportSession {
  return trackWebExport({ ...options, name: UNITY_CONNECTOR_NAME, frame: UNITY_FRAME });
}

export type { EngineBridge };
