import type { CollectRequest } from "@uptimizr/schema";

import type { Transport } from "./types.js";
import type {
  WorkerBatchMessage,
  WorkerInitMessage,
  WorkerOutbound,
} from "./offloadProtocol.js";

/**
 * A **Processor** owns the offload-eligible *processing* phase of the SDK
 * (ADR 0031): turning a drained batch into a delivered one — serialization plus
 * network dispatch. It sits between the client's flush loop and the wire.
 *
 * The boundary that makes this work is the plain-data {@link CollectRequest}
 * DTO. By the time a batch reaches a processor it is already an array of
 * Zod-shaped plain objects with no engine or DOM handles, so it can either be
 * serialized in place (main-thread processor) or shipped to a worker
 * (worker processor) without touching the live 3D scene.
 *
 * Two implementations exist:
 * - {@link createMainProcessor} — the default; runs everything on the main
 *   thread via the configured {@link Transport}. Behaviour is unchanged from
 *   before this seam existed, byte-for-byte.
 * - {@link createWorkerProcessor} — opt-in; moves steady-state serialization +
 *   dispatch to a Web Worker, keeping the terminal unload flush on the main
 *   thread.
 */
export interface Processor {
  /**
   * Serialize and deliver a steady-state batch. Resolves `true` on success;
   * `false` re-queues the batch for the next attempt.
   */
  process(batch: CollectRequest): Promise<boolean>;
  /**
   * Deliver the **final** batch on page unload. This MUST run on the main/page
   * thread: `navigator.sendBeacon` is only reliable from the page context during
   * `visibilitychange: hidden` / `pagehide` (ADR 0031 §5, ADR 0006), and a
   * worker may be torn down with the page before an async post completes.
   */
  processUnload(batch: CollectRequest): Promise<boolean>;
  /** Release resources (e.g. terminate the worker). Idempotent. */
  dispose(): void;
}

/**
 * The default processor: serialize + dispatch on the main thread via the given
 * transport. This is the no-op-fallback baseline — identical to the behaviour
 * before the seam was introduced. Both the steady-state and unload paths use the
 * same transport (the beacon transport already prefers `sendBeacon`).
 */
export function createMainProcessor(transport: Transport): Processor {
  return {
    process: (batch) => transport.send(batch),
    processUnload: (batch) => transport.send(batch),
    dispose: () => {
      /* nothing to release */
    },
  };
}

/**
 * Minimal structural type for a dedicated worker — the subset of the DOM
 * `Worker` interface the processor uses. A real `Worker` satisfies it; tests
 * inject a lightweight stub so the protocol can be exercised without a runtime
 * worker (jsdom/Node have no usable `Worker`).
 */
export interface WorkerLike {
  postMessage(message: unknown, transfer?: Transferable[]): void;
  addEventListener(type: "message", listener: (event: { data: unknown }) => void): void;
  addEventListener(type: "error", listener: (event: unknown) => void): void;
  terminate?(): void;
}

/** Constructs the offload worker. Injectable so bundlers/tests can override it. */
export type WorkerFactory = () => WorkerLike;

export interface WorkerProcessorOptions {
  /** Collector base URL (the same value as the client `endpoint`). */
  endpoint: string;
  /**
   * Transport used for the **unload** flush, which stays on the main thread
   * (ADR 0031 §5). Normally the client's default beacon transport.
   */
  unloadTransport: Transport;
  /**
   * How to construct the worker. Defaults to a module worker bundled with the
   * SDK via the `new Worker(new URL("./offloadWorker.js", import.meta.url))`
   * pattern recognized by Vite/webpack5/Rollup/esbuild.
   */
  workerFactory?: WorkerFactory;
}

const COLLECT_PATH = "/api/v1/collect";

/** Build the collector POST URL the worker dispatches to. */
function collectUrl(endpoint: string): string {
  return endpoint.replace(/\/$/, "") + COLLECT_PATH;
}

/**
 * Collect the transferable buffers carried by a batch so they move to the worker
 * **zero-copy** instead of being structured-cloned (ADR 0031 §6, #98).
 *
 * Today's events are plain JSON objects, so this returns an empty list — the
 * mechanism is in place for the buffer-backed continuous-channel DTOs that the
 * connector-side offload follow-up will introduce. The scan is shallow (one pass
 * over each event's own values) to keep the per-flush cost negligible, and it
 * de-duplicates so a buffer shared across fields is only transferred once
 * (a duplicate in the transfer list would throw).
 *
 * Caveat: transferring a buffer **neuters** it on the main thread. Continuous
 * channels that opt in must own a fresh buffer per batch.
 */
export function collectTransferables(batch: CollectRequest): Transferable[] {
  const seen = new Set<ArrayBufferLike>();
  const out: Transferable[] = [];
  for (const event of batch.events) {
    for (const value of Object.values(event as Record<string, unknown>)) {
      let buffer: ArrayBufferLike | undefined;
      if (value instanceof ArrayBuffer) {
        buffer = value;
      } else if (ArrayBuffer.isView(value)) {
        buffer = (value as ArrayBufferView).buffer;
      }
      if (buffer && !seen.has(buffer)) {
        seen.add(buffer);
        out.push(buffer as Transferable);
      }
    }
  }
  return out;
}

/** Default factory: a module worker shipped alongside the SDK in `dist/`. */
function defaultWorkerFactory(): WorkerLike {
  // `new URL(..., import.meta.url)` + `new Worker` is the pattern bundlers
  // recognize to emit and resolve a library-owned worker asset.
  return new Worker(new URL("./offloadWorker.js", import.meta.url), {
    type: "module",
  }) as unknown as WorkerLike;
}

/**
 * Create a worker-backed processor that runs steady-state serialization +
 * dispatch off the main thread (ADR 0031). Returns `null` when a worker cannot
 * be constructed (no `Worker` global, the bundler did not emit the asset, a
 * restrictive CSP, SSR, or tests) so the caller can fall back to the
 * main-thread processor — worker mode is never required for correctness.
 *
 * The unload flush deliberately does **not** use the worker; it goes through
 * {@link WorkerProcessorOptions.unloadTransport} on the main thread.
 */
export function createWorkerProcessor(options: WorkerProcessorOptions): Processor | null {
  const factory = options.workerFactory ?? defaultWorkerFactory;

  let worker: WorkerLike;
  try {
    worker = factory();
  } catch {
    return null;
  }

  let nextId = 1;
  let disposed = false;
  const pending = new Map<number, (ok: boolean) => void>();

  const settleAll = (ok: boolean): void => {
    for (const resolve of pending.values()) {
      resolve(ok);
    }
    pending.clear();
  };

  worker.addEventListener("message", (event) => {
    const data = event.data as WorkerOutbound | undefined;
    if (!data || data.type !== "result") {
      return;
    }
    const resolve = pending.get(data.id);
    if (resolve) {
      pending.delete(data.id);
      resolve(data.ok);
    }
  });

  // If the worker errors, fail every in-flight send so the batches re-queue and
  // are retried on the main thread — no events are lost.
  worker.addEventListener("error", () => {
    settleAll(false);
  });

  try {
    worker.postMessage({
      type: "init",
      url: collectUrl(options.endpoint),
    } satisfies WorkerInitMessage);
  } catch {
    worker.terminate?.();
    return null;
  }

  return {
    process(batch: CollectRequest): Promise<boolean> {
      if (disposed) {
        return Promise.resolve(false);
      }
      const id = nextId++;
      return new Promise<boolean>((resolve) => {
        pending.set(id, resolve);
        try {
          worker.postMessage(
            { type: "batch", id, batch } satisfies WorkerBatchMessage,
            collectTransferables(batch),
          );
        } catch {
          pending.delete(id);
          resolve(false);
        }
      });
    },
    processUnload: (batch) => options.unloadTransport.send(batch),
    dispose: () => {
      if (disposed) {
        return;
      }
      disposed = true;
      settleAll(false);
      worker.terminate?.();
    },
  };
}
