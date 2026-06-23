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

/**
 * sessionStorage key guarding the one-time recovery reload in {@link waitForController}.
 * Scoped to the tab so a returning visit (new tab/session) can recover again.
 */
const CONTROLLER_RELOAD_FLAG = "uptimizr-demo-sw-reload";

/**
 * Wait until the service worker actually *controls* this page.
 *
 * On a first visit the page loads uncontrolled: the worker installs, activates,
 * and only then calls `clients.claim()`, which takes control and fires
 * `controllerchange`. Until that moment the collector shim cannot intercept
 * `/api/v1/*`, so the dashboard would receive no data and the welcome screen
 * appears stuck on "Installing the in-browser collector…". A redundant/failed
 * activation can leave the page uncontrolled indefinitely.
 *
 * Resolve as soon as a controller exists. If `claim()` never lands within the
 * timeout, reload once (guarded against loops) so the page starts controlled —
 * after activation a fresh navigation is controlled from the very first request.
 */
async function waitForController(timeoutMs = 8000): Promise<void> {
  if (!("serviceWorker" in navigator)) return;
  if (navigator.serviceWorker.controller) return;

  await new Promise<void>((resolve) => {
    let settled = false;
    const onChange = () => {
      if (navigator.serviceWorker.controller) finish();
    };
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      navigator.serviceWorker.removeEventListener("controllerchange", onChange);
      // Control established — clear the guard so a future stall can recover again.
      if (navigator.serviceWorker.controller) {
        sessionStorage.removeItem(CONTROLLER_RELOAD_FLAG);
      }
      resolve();
    };

    const timer = setTimeout(() => {
      finish();
      // claim() never landed — recover once by reloading so the next navigation
      // is controlled from the start. The flag prevents a reload loop.
      if (!navigator.serviceWorker.controller && !sessionStorage.getItem(CONTROLLER_RELOAD_FLAG)) {
        sessionStorage.setItem(CONTROLLER_RELOAD_FLAG, "1");
        location.reload();
      }
    }, timeoutMs);

    navigator.serviceWorker.addEventListener("controllerchange", onChange);
    // Re-check in case the controller appeared between the guard above and the
    // listener being attached (avoids missing an early controllerchange).
    if (navigator.serviceWorker.controller) finish();
  });
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
  // The SW being active is not enough — it must control this page before its
  // fetch handler can intercept the dashboard's /api/v1/* calls. Wait for that
  // (or recover via a one-time reload) so the dashboard receives data.
  await waitForController();

  onProgress?.("caching");
  await precache(precacheUrls());

  onProgress?.("warming");
  await ensureDb();

  onProgress?.("done");
}
