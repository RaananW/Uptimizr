/**
 * `@uptimizr/unreal` — the Unreal Engine (web export) connector for Uptimizr
 * (ADR 0045). **Best-effort, pending a viable WASM/HTML5 target.**
 *
 * Epic deprecated the official HTML5/Emscripten target after UE 4.24, and Pixel
 * Streaming renders server-side (no client WASM scene to read), so the bridged tier
 * does not fit a stock modern Unreal build today. The package and bridge contract
 * are defined now so they drop in cleanly if a community HTML5 fork or a future
 * official web target appears. The **JS-only tier works on any web export** that
 * renders into a `<canvas>`.
 *
 * This connector is **two-part**:
 *
 * - a **JS-only tier** (this package, no engine code) — pointer heatmaps, rAF FPS,
 *   and error capture straight from the canvas DOM; and
 * - a **bridged tier** — a thin engine-side shim (an Emscripten `EM_JS` / `cwrap`
 *   shim from the C++ web target, see `bridge/`) pushes camera pose / picks / perf
 *   over the versioned {@link EngineBridge}.
 *
 * Unreal's native world frame is **left-handed, z-up, centimeters**. It is the only
 * engine that exercises the non-`y` up-axis and non-1 unit-scale paths: world-space
 * payloads are rebased z-up → y-up **and** scaled cm → m before reaching the
 * canonical wire frame (ADR 0018 / ADR 0045 §5).
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

/**
 * Unreal's native world coordinate frame: left-handed, **z-up**, **centimeters**
 * (`unitScale: 100` = 100 world units per meter).
 */
export const UNREAL_FRAME: NativeFrame = { handedness: "left", upAxis: "z", unitScale: 100 };

/** The engine id used for connector provenance and the collector name. */
export const UNREAL_CONNECTOR_NAME = "unreal";

export type UnrealCollectorOptions = Omit<WebExportCollectorOptions, "name" | "frame">;
export type TrackUnrealOptions = Omit<TrackWebExportOptions, "name" | "frame">;

/**
 * The Unreal collector — register it with an sdk-core client via `client.use(...)`.
 * Wires the JS-only tier and exposes the engine bridge (default global
 * `window.__uptimizr_unreal__`) for the engine-side shim. See the package docs for
 * the web-target feasibility caveat.
 */
export function unrealCollector(options: UnrealCollectorOptions = {}): Collector {
  return webExportCollector({ ...options, name: UNREAL_CONNECTOR_NAME, frame: UNREAL_FRAME });
}

/**
 * One-call Unreal integration: create a client, register {@link unrealCollector},
 * and start the session with Unreal's connector provenance (ADR 0018). Returns the
 * client and the {@link EngineBridge} the Unreal shim pushes through.
 */
export function trackUnreal(options: TrackUnrealOptions): WebExportSession {
  return trackWebExport({ ...options, name: UNREAL_CONNECTOR_NAME, frame: UNREAL_FRAME });
}

export type { EngineBridge };
