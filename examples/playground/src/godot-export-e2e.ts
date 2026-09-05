/**
 * Boot harness for the Godot export e2e spec (`e2e/godot-export.spec.ts`).
 *
 * Unlike `web-export-e2e.ts` (a bare canvas + synthetic bridge pushes), this page
 * boots a **real Godot 4 Web export** — `examples/godot-web-export`, exported
 * headlessly by `pnpm godot:export` and served by the Vite dev server under
 * `/godot-export/` — and starts the real `@uptimizr/godot` connector against the e2e
 * collector **before** the engine boots. That ordering matters: the exported
 * project's `UptimizrGodot` autoload looks up `window.__uptimizr_godot__` in its
 * `_ready`, so the bridge must already exist when the WASM engine starts. From then
 * on the shim pushes camera pose / FPS / left-click picks / the scene proxy on its
 * own; the spec only clicks the canvas and reads the collector back.
 *
 * Everything the spec needs is exposed on `window.__godotExport`.
 */
import { trackGodot } from "@uptimizr/godot";
import type { EngineBridge } from "@uptimizr/godot";

const COLLECTOR_URL = (import.meta.env.VITE_COLLECTOR_URL as string) ?? "http://localhost:4318";
const PROJECT_ID = (import.meta.env.VITE_PROJECT_ID as string) ?? "demo";

/** URL prefix the playground's Vite plugin serves the export from (see `vite.config.ts`). */
const EXPORT_BASE = "/godot-export";

/** The subset of Godot's `EngineConfig` this harness sets (see the exported `index.js`). */
interface GodotEngineConfig {
  canvas: HTMLCanvasElement;
  /** Base URL of the export: `<executable>.wasm`, `.pck`, and the audio worklets. */
  executable: string;
  canvasResizePolicy?: 0 | 1 | 2;
  focusCanvas?: boolean;
  /** Keep `false`: the nothreads export needs no SharedArrayBuffer, so no COOP/COEP reload. */
  ensureCrossOriginIsolationHeaders?: boolean;
  onPrint?: (...args: unknown[]) => void;
  onPrintError?: (...args: unknown[]) => void;
  onProgress?: (current: number, total: number) => void;
  onExit?: (code: number) => void;
}

interface GodotEngine {
  startGame(override?: Partial<GodotEngineConfig>): Promise<void>;
}

interface GodotEngineCtor {
  new (config: GodotEngineConfig): GodotEngine;
  isWebGLAvailable(majorVersion?: number): boolean;
}

/** Structural view of the scene proxy the bridge builds from `push_scene_proxy()`. */
interface SceneProxyView {
  sceneId: string;
  meshes: { name: string; aabb: readonly number[] }[];
}

export type GodotExportStatus =
  "loading" | "missing-export" | "no-webgl" | "starting" | "running" | "exited" | "failed";

export interface GodotExportHarness {
  status: GodotExportStatus;
  sessionId: string;
  bridge: EngineBridge | undefined;
  /** The wire-correct proxy the connector built from the shim's `setSceneProxy` push. */
  sceneProxy?: SceneProxyView;
  /** Engine stdout/stderr (`print`, `push_warning`, …) — e.g. the shim's bridge warnings. */
  log: string[];
  error?: string;
}

declare global {
  interface Window {
    __godotExport?: GodotExportHarness;
  }
  /** Defined by the export's loader (`index.js`) as a script-scope `const`. */
  const Engine: GodotEngineCtor;
}

const canvas = document.getElementById("godotCanvas") as HTMLCanvasElement;
const statusEl = document.getElementById("status") as HTMLDivElement;

const harness: GodotExportHarness = {
  status: "loading",
  sessionId: "",
  bridge: undefined,
  log: [],
};
window.__godotExport = harness;

function setStatus(status: GodotExportStatus, error?: string): void {
  harness.status = status;
  if (error) harness.error = error;
  statusEl.textContent = error ? `${status}: ${error}` : status;
}

function loadScript(src: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const el = document.createElement("script");
    el.src = src;
    el.onload = () => resolve();
    el.onerror = () => reject(new Error(`failed to load ${src}`));
    document.head.appendChild(el);
  });
}

async function main(): Promise<void> {
  // 1) Start the connector first so `window.__uptimizr_godot__` exists when the
  //    autoload's `_ready` runs. The JS-only tier starts capturing off the canvas
  //    immediately; the bridged tier lights up once the engine boots.
  const { client, bridge } = trackGodot({
    projectId: PROJECT_ID,
    endpoint: COLLECTOR_URL,
    canvas,
    capture: { buttons: true },
    sceneId: "godot-sample",
    onSceneProxy: (proxy) => {
      harness.sceneProxy = proxy;
    },
    // Flush quickly so the e2e round trip stays well under the spec timeout.
    flushIntervalMs: 500,
  });
  harness.sessionId = client.sessionId;
  harness.bridge = bridge;

  // 2) Load the export's loader script (defines the `Engine` global).
  try {
    await loadScript(`${EXPORT_BASE}/index.js`);
  } catch (err) {
    setStatus("missing-export", (err as Error).message);
    return;
  }
  if (typeof Engine === "undefined") {
    setStatus("missing-export", "loader did not define Engine");
    return;
  }
  if (!Engine.isWebGLAvailable(2)) {
    setStatus("no-webgl", "WebGL 2 unavailable");
    return;
  }

  // 3) Boot the engine into our canvas. Godot fetches `<executable>.wasm` / `.pck`
  //    relative to the page, so the prefix routes through the Vite plugin.
  const engine = new Engine({
    canvas,
    executable: `${EXPORT_BASE}/index`,
    canvasResizePolicy: 2,
    focusCanvas: true,
    ensureCrossOriginIsolationHeaders: false,
    onPrint: (...args) => harness.log.push(args.map(String).join(" ")),
    onPrintError: (...args) => harness.log.push(`[stderr] ${args.map(String).join(" ")}`),
    onExit: () => setStatus("exited"),
  });
  setStatus("starting");
  try {
    await engine.startGame();
    setStatus("running");
  } catch (err) {
    setStatus("failed", err instanceof Error ? err.message : String(err));
  }
}

void main();
