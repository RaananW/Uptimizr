/**
 * Boot harness for the Unity WebGL export e2e spec (`e2e/unity-export.spec.ts`).
 *
 * Unlike `web-export-e2e.ts` (a bare canvas with a synthetic bridge push), this page
 * loads a **real Unity WebGL build** of `examples/unity-web-export/` — served by the
 * Vite dev server at `/unity-build/` — and lets the export's own C#
 * `UptimizrUnityBridge` push camera pose / picks / perf through the real
 * `Uptimizr.jslib` shim. Order matters: `trackUnity(...)` runs **first** so
 * `window.__uptimizr_unity__` exists by the time `createUnityInstance` boots the
 * scene and the C# `Start()` asserts the bridge protocol version.
 *
 * The started session + load status are exposed on `window.__unityExport` for the
 * spec. Without a build (the CI / default case) the page reports `no-build` and the
 * spec skips before ever opening it.
 */
import { trackUnity } from "@uptimizr/unity";
import type { EngineBridge } from "@uptimizr/unity";

const COLLECTOR_URL = (import.meta.env.VITE_COLLECTOR_URL as string) ?? "http://localhost:4318";
const PROJECT_ID = (import.meta.env.VITE_PROJECT_ID as string) ?? "demo";
const MANIFEST_URL = "/unity-build/manifest.json";

type UnityStatus = "loading" | "ready" | "no-build" | "error";

interface UnityBuildManifest {
  buildName: string;
  loaderUrl: string;
  dataUrl: string;
  frameworkUrl: string;
  codeUrl: string;
  streamingAssetsUrl: string;
  compression: "none" | "gzip" | "brotli";
}

/** The subset of Unity's loader config the harness passes to `createUnityInstance`. */
interface UnityInstanceConfig {
  dataUrl: string;
  frameworkUrl: string;
  codeUrl: string;
  streamingAssetsUrl: string;
  companyName: string;
  productName: string;
  productVersion: string;
}

declare global {
  interface Window {
    __unityExport?: {
      sessionId: string;
      bridge: EngineBridge | undefined;
      status: UnityStatus;
      progress: number;
      error?: string;
      buildName?: string;
    };
    /** Defined by Unity's `Build/*.loader.js` once it has been injected. */
    createUnityInstance?: (
      canvas: HTMLCanvasElement,
      config: UnityInstanceConfig,
      onProgress?: (progress: number) => void,
    ) => Promise<unknown>;
  }
}

const canvas = document.getElementById("unity-canvas") as HTMLCanvasElement;
const statusEl = document.getElementById("status")!;

// 1. Connector first — the C# bridge asserts `window.__uptimizr_unity__` on Start().
const { client, bridge } = trackUnity({
  projectId: PROJECT_ID,
  endpoint: COLLECTOR_URL,
  canvas,
  // Flush quickly so the e2e round trip stays well under the spec timeout.
  flushIntervalMs: 500,
});

const state: NonNullable<Window["__unityExport"]> = {
  sessionId: client.sessionId,
  bridge,
  status: "loading",
  progress: 0,
};
window.__unityExport = state;

function setStatus(status: UnityStatus, detail: string) {
  state.status = status;
  statusEl.textContent = `[${status}] ${detail}`;
}

function injectScript(src: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = src;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error(`failed to load ${src}`));
    document.head.appendChild(s);
  });
}

// 2. Then the export: discover the build, inject Unity's loader, boot the instance.
async function boot(): Promise<void> {
  const res = await fetch(MANIFEST_URL, { cache: "no-store" });
  if (res.status === 404) {
    setStatus("no-build", "no Unity WebGL build in examples/unity-web-export/dist");
    return;
  }
  if (!res.ok) throw new Error(`manifest request failed: ${res.status}`);
  const manifest = (await res.json()) as UnityBuildManifest;
  state.buildName = manifest.buildName;
  setStatus("loading", `loading ${manifest.buildName} (${manifest.compression})…`);

  await injectScript(manifest.loaderUrl);
  if (typeof window.createUnityInstance !== "function") {
    throw new Error("Unity loader did not define createUnityInstance");
  }
  await window.createUnityInstance(
    canvas,
    {
      dataUrl: manifest.dataUrl,
      frameworkUrl: manifest.frameworkUrl,
      codeUrl: manifest.codeUrl,
      streamingAssetsUrl: manifest.streamingAssetsUrl,
      companyName: "Uptimizr",
      productName: "UptimizrUnityWebExport",
      productVersion: "e2e",
    },
    (progress) => {
      state.progress = progress;
      setStatus("loading", `loading ${manifest.buildName} ${Math.round(progress * 100)}%`);
    },
  );
  setStatus("ready", `${manifest.buildName} running — session ${client.sessionId}`);
}

boot().catch((err: unknown) => {
  state.error = err instanceof Error ? err.message : String(err);
  setStatus("error", state.error);
});
