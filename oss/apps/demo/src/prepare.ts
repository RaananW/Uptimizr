import { DUCKDB_ASSET_URLS } from "./store/db.js";
import { ensureDb, startHost } from "./store/host.js";

/**
 * The URLs to precache so the demo works offline after a one-time "Prepare demo".
 * The DuckDB-Wasm engine assets are the heavy ones (multi-MB wasm + workers); the
 * embeds and app shell are runtime-cached on first paint by the SW's
 * stale-while-revalidate handler, but we prime their entry points here too.
 */
function precacheUrls(): string[] {
  return [
    "/",
    "/index.html",
    "/playground/index.html",
    "/dashboard/index.html",
    ...DUCKDB_ASSET_URLS,
  ];
}

/** Register the collector-shim service worker (idempotent). */
export async function registerServiceWorker(): Promise<ServiceWorkerRegistration | null> {
  if (!("serviceWorker" in navigator)) return null;
  const registration = await navigator.serviceWorker.register("/sw.js", { scope: "/" });
  await navigator.serviceWorker.ready;
  return registration;
}

/** Ask the active service worker to precache the asset list; resolve when done. */
async function precache(urls: string[]): Promise<void> {
  const worker = navigator.serviceWorker.controller ?? (await navigator.serviceWorker.ready).active;
  if (!worker) return;
  await new Promise<void>((resolve) => {
    const channel = new MessageChannel();
    const timer = setTimeout(resolve, 60000);
    channel.port1.onmessage = () => {
      clearTimeout(timer);
      resolve();
    };
    worker.postMessage({ type: "uptimizr-precache", urls }, [channel.port2]);
  });
}

/** A coarse progress phase for the welcome screen. */
export type PrepareProgress = "registering" | "caching" | "warming" | "done";

/**
 * Run the one-time preparation: register the SW, start the page-side store host,
 * precache the engine assets for offline use, and warm the DuckDB-Wasm database
 * so the first dashboard query is instant. Safe to call again (idempotent).
 */
export async function prepareDemo(onProgress?: (phase: PrepareProgress) => void): Promise<void> {
  onProgress?.("registering");
  await registerServiceWorker();
  startHost();

  onProgress?.("caching");
  await precache(precacheUrls());

  onProgress?.("warming");
  await ensureDb();

  onProgress?.("done");
}
