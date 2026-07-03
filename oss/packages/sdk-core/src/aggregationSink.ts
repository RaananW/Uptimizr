import type { Aggregator, AggregatorConfig } from "./aggregation/aggregator.js";
import { collectSnapshotTransferables, type Snapshot } from "./aggregation/snapshot.js";
import { defaultWorkerFactory, type WorkerFactory, type WorkerLike } from "./processor.js";
import type { EventInput } from "./types.js";
import type {
  WorkerAggInitMessage,
  WorkerFlushUnloadMessage,
  WorkerOutbound,
  WorkerSnapshotMessage,
} from "./offloadProtocol.js";

/**
 * An **AggregationSink** owns the offload-eligible *aggregation* phase of the SDK
 * (ADR 0031 follow-up, #10): turning the raw, plain-number {@link Snapshot} DTOs
 * a connector emits per frame into finalized analytics events. It sits between
 * the connector (via `ctx.snapshot`) and the client's emit/queue/flush loop.
 *
 * Two implementations exist, mirroring the transport {@link Processor} seam:
 * - {@link createMainSink} — the default; runs the aggregator synchronously on
 *   the main thread, emitting finalized events inline. Byte-for-byte identical to
 *   the pre-seam behaviour where each connector aggregated inline.
 * - {@link createWorkerAggregationSink} — opt-in; ships snapshots to a worker
 *   (high-volume channels by transfer, zero-copy) where a worker-resident
 *   aggregator finalizes them and posts the events back to the page.
 *
 * In both cases the finalized events are emitted on the **main thread**, so the
 * envelope, `beforeSend` (a page closure), the queue and the unload guarantee
 * (ADR 0031 §5) are all preserved unchanged.
 */
export interface AggregationSink {
  /**
   * Ingest one raw snapshot. `capturedAt` is the page-stamped capture time
   * (epoch ms); it is carried onto the emitted events' `ts` so worker round-trip
   * latency does not skew timestamps.
   */
  ingest(snapshot: Snapshot, capturedAt: number): void;
  /**
   * Drain any aggregator state that finalizes on demand, then resolve once all
   * resulting events have been emitted on the main thread. Awaited by the
   * client's terminal unload flush so no window is lost (ADR 0031 §5).
   */
  drain(): Promise<void>;
  /** Release resources (e.g. terminate the worker). Idempotent. */
  dispose(): void;
}

/**
 * The default sink: run the given main-thread {@link Aggregator} synchronously.
 * `ingest` finalizes inline (the aggregator's `emit` callback fires during the
 * call), so this is identical to the old inline-connector behaviour.
 */
export function createMainSink(aggregator: Aggregator): AggregationSink {
  return {
    ingest: (snapshot) => aggregator.ingest(snapshot),
    drain: () => Promise.resolve(),
    dispose: () => {
      /* nothing to release */
    },
  };
}

export interface WorkerAggregationSinkOptions {
  /** Serializable per-channel aggregation config (no callbacks/handles). */
  config: AggregatorConfig;
  /** Called on the main thread with finalized events from the worker. */
  onEvents: (events: EventInput[], capturedAt: number) => void;
  /**
   * How to construct the worker. Defaults to the SDK-bundled module worker, the
   * same asset the transport processor uses.
   */
  workerFactory?: WorkerFactory;
}

/**
 * Create a worker-backed aggregation sink (ADR 0031 follow-up, #10). Returns
 * `null` when a worker cannot be constructed (no `Worker` global, the bundler did
 * not emit the asset, a restrictive CSP, SSR, or tests) so the caller can fall
 * back to a main-thread sink — worker mode is never required for correctness.
 *
 * Uses its own dedicated worker instance (separate from the transport
 * processor's) so the existing transport seam stays untouched; each worker only
 * acts on the messages it receives.
 */
export function createWorkerAggregationSink(
  options: WorkerAggregationSinkOptions,
): AggregationSink | null {
  const factory = options.workerFactory ?? defaultWorkerFactory;

  let worker: WorkerLike;
  try {
    worker = factory();
  } catch {
    return null;
  }

  let disposed = false;
  let nextId = 1;
  const pendingDrains = new Map<number, () => void>();

  worker.addEventListener("message", (event) => {
    const data = event.data as WorkerOutbound | undefined;
    if (!data) {
      return;
    }
    if (data.type === "events") {
      options.onEvents(data.events, data.capturedAt);
    } else if (data.type === "unloadDone") {
      const resolve = pendingDrains.get(data.id);
      if (resolve) {
        pendingDrains.delete(data.id);
        resolve();
      }
    }
  });

  // If the worker errors, unblock any pending drain so unload still completes.
  worker.addEventListener("error", () => {
    for (const resolve of pendingDrains.values()) {
      resolve();
    }
    pendingDrains.clear();
  });

  try {
    worker.postMessage({ type: "aggInit", config: options.config } satisfies WorkerAggInitMessage);
  } catch {
    worker.terminate?.();
    return null;
  }

  return {
    ingest(snapshot: Snapshot, capturedAt: number): void {
      if (disposed) {
        return;
      }
      try {
        worker.postMessage(
          { type: "snapshot", capturedAt, snapshot } satisfies WorkerSnapshotMessage,
          collectSnapshotTransferables(snapshot),
        );
      } catch {
        /* drop a single snapshot rather than throw into the render loop */
      }
    },
    drain(): Promise<void> {
      if (disposed) {
        return Promise.resolve();
      }
      const id = nextId++;
      return new Promise<void>((resolve) => {
        pendingDrains.set(id, resolve);
        try {
          worker.postMessage({ type: "flushUnload", id } satisfies WorkerFlushUnloadMessage);
        } catch {
          pendingDrains.delete(id);
          resolve();
        }
      });
    },
    dispose(): void {
      if (disposed) {
        return;
      }
      disposed = true;
      for (const resolve of pendingDrains.values()) {
        resolve();
      }
      pendingDrains.clear();
      worker.terminate?.();
    },
  };
}
