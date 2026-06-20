import type { WorkerInbound, WorkerResultMessage } from "./offloadProtocol.js";

/**
 * Dedicated-worker entry for the opt-in offload processor (ADR 0031).
 *
 * Runs the offload-eligible *processing* phase off the main thread: it
 * serializes each batch (`JSON.stringify` — the dominant cost) and POSTs it to
 * the collector with `fetch`, then reports success back to the page. It holds no
 * engine or DOM state and receives only plain-data `CollectRequest` DTOs, so it
 * never touches the live 3D scene.
 *
 * It is intentionally dependency-free (only type-only imports, erased at build)
 * so the emitted worker bundle stays tiny. The terminal unload flush is handled
 * on the main thread by the processor, not here.
 */

/** The slice of the dedicated-worker global scope this file uses. */
interface WorkerScope {
  postMessage(message: unknown): void;
  addEventListener(type: "message", listener: (event: { data: unknown }) => void): void;
  fetch: typeof fetch;
}

// The build uses the DOM lib (not WebWorker), so narrow `self` structurally.
const scope = self as unknown as WorkerScope;

/** Resolved collector URL, set by the `init` message before any batch arrives. */
let collectUrl = "";

scope.addEventListener("message", (event) => {
  const message = event.data as WorkerInbound | undefined;
  if (!message) {
    return;
  }
  if (message.type === "init") {
    collectUrl = message.url;
    return;
  }
  if (message.type === "batch") {
    void dispatch(message.id, message.batch);
  }
});

/** Serialize and POST one batch, then report the outcome back to the page. */
async function dispatch(id: number, batch: unknown): Promise<void> {
  let ok = false;
  try {
    if (collectUrl) {
      const body = JSON.stringify(batch);
      const res = await scope.fetch(collectUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
        // `keepalive` has a ~64 KB browser cap; only request it under the limit.
        keepalive: body.length < 64_000,
      });
      ok = res.ok;
    }
  } catch {
    ok = false;
  }
  const result: WorkerResultMessage = { type: "result", id, ok };
  scope.postMessage(result);
}
