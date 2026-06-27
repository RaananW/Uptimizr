import { createAggregator, type Aggregator } from "./aggregation/aggregator.js";
import type { EventInput } from "./types.js";
import type {
  WorkerEventsMessage,
  WorkerInbound,
  WorkerResultMessage,
  WorkerUnloadDoneMessage,
} from "./offloadProtocol.js";

/**
 * Dedicated-worker entry for the opt-in offload worker (ADR 0031 + follow-up #10).
 *
 * It runs the offload-eligible *processing* phase off the main thread in two
 * roles:
 *
 * 1. **Transport** (#93-99): serialize each finalized batch (`JSON.stringify` -
 *    the dominant cost) and POST it to the collector with `fetch`, reporting the
 *    outcome back to the page.
 * 2. **Aggregation** (#10): host the engine-agnostic {@link Aggregator}, ingest
 *    raw plain-number snapshot DTOs, and post the finalized events back to the
 *    page (where the envelope, `beforeSend`, queue and the unload guarantee live).
 *
 * It holds no engine or DOM state and receives only plain data, so it never
 * touches the live 3D scene. The terminal unload flush is handled on the main
 * thread by the client, not here (ADR 0031 section 5).
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

/** Worker-resident aggregator, created on `aggInit`. Buffers events per ingest. */
let aggregator: Aggregator | undefined;
let eventBuffer: EventInput[] = [];

scope.addEventListener("message", (event) => {
  const message = event.data as WorkerInbound | undefined;
  if (!message) {
    return;
  }
  switch (message.type) {
    case "init":
      collectUrl = message.url;
      return;
    case "batch":
      void dispatch(message.id, message.batch);
      return;
    case "aggInit":
      aggregator = createAggregator({
        ...message.config,
        emit: (e) => eventBuffer.push(e),
      });
      return;
    case "snapshot": {
      if (!aggregator) return;
      eventBuffer = [];
      aggregator.ingest(message.snapshot);
      if (eventBuffer.length > 0) {
        const out: WorkerEventsMessage = {
          type: "events",
          capturedAt: message.capturedAt,
          events: eventBuffer,
        };
        eventBuffer = [];
        scope.postMessage(out);
      }
      return;
    }
    case "flushUnload": {
      const done: WorkerUnloadDoneMessage = { type: "unloadDone", id: message.id };
      scope.postMessage(done);
      return;
    }
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
