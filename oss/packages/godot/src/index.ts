/**
 * `@uptimizr/godot` — the Godot 4 (Web export) connector for Uptimizr (ADR 0045).
 *
 * Godot compiles to WebAssembly and renders into a `<canvas>`, so there is no live
 * JS scene to read. This connector is **two-part**:
 *
 * - a **JS-only tier** (this package, no engine code) — pointer heatmaps, rAF FPS,
 *   and error capture straight from the canvas DOM; and
 * - a **bridged tier** — a thin engine-side shim (a GDScript or C# autoload using
 *   `JavaScriptBridge`, see `bridge/`) pushes camera pose / picks / perf over the
 *   versioned {@link EngineBridge} for view-direction heatmaps, world-space gaze,
 *   and replay.
 *
 * Godot's native world frame is **right-handed, y-up, meters**, so world-space
 * payloads are normalized to the canonical frame (left-handed, y-up) by negating Z
 * at the emission boundary (ADR 0018).
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

/** Godot's native world coordinate frame: right-handed, y-up, meters. */
export const GODOT_FRAME: NativeFrame = { handedness: "right", upAxis: "y", unitScale: 1 };

/** The engine id used for connector provenance and the collector name. */
export const GODOT_CONNECTOR_NAME = "godot";

export type GodotCollectorOptions = Omit<WebExportCollectorOptions, "name" | "frame">;
export type TrackGodotOptions = Omit<TrackWebExportOptions, "name" | "frame">;

/**
 * The Godot collector — register it with an sdk-core client via `client.use(...)`.
 * Wires the JS-only tier and exposes the engine bridge (default global
 * `window.__uptimizr_godot__`) for the engine-side shim.
 */
export function godotCollector(options: GodotCollectorOptions = {}): Collector {
  return webExportCollector({ ...options, name: GODOT_CONNECTOR_NAME, frame: GODOT_FRAME });
}

/**
 * One-call Godot integration: create a client, register {@link godotCollector}, and
 * start the session with Godot's connector provenance (ADR 0018). Returns the client
 * and the {@link EngineBridge} the Godot shim pushes through.
 */
export function trackGodot(options: TrackGodotOptions): WebExportSession {
  return trackWebExport({ ...options, name: GODOT_CONNECTOR_NAME, frame: GODOT_FRAME });
}

export type { EngineBridge };
