/**
 * Boot harness for the web-export e2e spec (`e2e/web-export.spec.ts`).
 *
 * It stands in for a Unity/Godot/Unreal WebAssembly export: a **bare `<canvas>`**
 * with no live JS scene. We start the real `@uptimizr/unity` connector against the
 * e2e collector and expose the started session + engine bridge on
 * `window.__webExport` so the spec can:
 *
 *  - drive the **JS-only tier** with synthesized DOM pointer events (move / click /
 *    down / up) + the rAF perf loop, and
 *  - drive the **bridged tier** by calling `bridge.pushPose` / `pushPick` /
 *    `pushPerf`, exactly as an engine-side shim would across the WASM↔JS boundary.
 *
 * The spec then reads the stored timeline back from the collector to assert the
 * full browser → SDK → collector → DuckDB round trip for every channel.
 */
import { trackUnity } from "@uptimizr/unity";
import type { EngineBridge } from "@uptimizr/unity";

const COLLECTOR_URL = (import.meta.env.VITE_COLLECTOR_URL as string) ?? "http://localhost:4318";
const PROJECT_ID = (import.meta.env.VITE_PROJECT_ID as string) ?? "demo";

declare global {
  interface Window {
    __webExport?: {
      sessionId: string;
      bridge: EngineBridge | undefined;
    };
  }
}

const canvas = document.getElementById("webExportCanvas") as HTMLCanvasElement;

const { client, bridge } = trackUnity({
  projectId: PROJECT_ID,
  endpoint: COLLECTOR_URL,
  canvas,
  // Exercise the down/up channel too (off by default in the JS-only tier).
  capture: { buttons: true },
  // Flush quickly so the e2e round trip stays well under the spec timeout.
  flushIntervalMs: 500,
});

window.__webExport = { sessionId: client.sessionId, bridge };
