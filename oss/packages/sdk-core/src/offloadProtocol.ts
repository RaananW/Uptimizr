import type { CollectRequest } from "@uptimizr/schema";

import type { AggregatorConfig } from "./aggregation/aggregator.js";
import type { Snapshot } from "./aggregation/snapshot.js";
import type { EventInput } from "./types.js";

/**
 * Wire protocol for the opt-in offload worker (ADR 0031).
 *
 * These are **type-only** definitions shared by the main-thread processor
 * ([`processor.ts`](./processor.ts)), the aggregation sink
 * ([`aggregationSink.ts`](./aggregationSink.ts)) and the worker entry
 * ([`offloadWorker.ts`](./offloadWorker.ts)). Keeping the protocol in its own
 * module (with no runtime exports) means the worker bundle pulls in none of the
 * main-thread runtime code — it stays tiny.
 *
 * Two roles cross the boundary:
 * - **Transport** (#93–99): a finalized plain-data `CollectRequest` batch travels
 *   to the worker to be serialized + dispatched; only an ack comes back.
 * - **Aggregation** (#10): raw plain-number {@link Snapshot} DTOs travel to the
 *   worker (high-volume channels by transfer), are aggregated worker-side into
 *   finalized {@link EventInput}s, and those come back to the page for the
 *   envelope/`beforeSend`/queue/transport machinery — so the unload guarantee
 *   (ADR 0031 §5) and `beforeSend` (a main-thread closure) are preserved.
 */

/** Sets the collector URL the worker dispatches to. Sent once at construction. */
export interface WorkerInitMessage {
  type: "init";
  /** Fully-resolved collect endpoint (e.g. `https://host/api/v1/collect`). */
  url: string;
}

/** A batch to serialize and dispatch off the main thread. */
export interface WorkerBatchMessage {
  type: "batch";
  /** Correlates the result back to the awaiting `process()` call. */
  id: number;
  /** The plain-data batch to serialize and send. */
  batch: CollectRequest;
}

/** Configures the worker-resident aggregator. Sent once at construction. */
export interface WorkerAggInitMessage {
  type: "aggInit";
  /** Serializable per-channel aggregation config (no callbacks/handles). */
  config: AggregatorConfig;
}

/** A raw snapshot DTO to aggregate worker-side (ADR 0031 follow-up, #10). */
export interface WorkerSnapshotMessage {
  type: "snapshot";
  /** Capture timestamp (epoch ms) stamped on the page; carried onto emitted events. */
  capturedAt: number;
  /** The plain-number snapshot to ingest. */
  snapshot: Snapshot;
}

/**
 * Drain barrier for the terminal unload flush (ADR 0031 §5). Because
 * `postMessage` is ordered, by the time the worker echoes this back every prior
 * snapshot's finalized events have already been posted to the page.
 */
export interface WorkerFlushUnloadMessage {
  type: "flushUnload";
  id: number;
}

/** Messages the main thread sends to the worker. */
export type WorkerInbound =
  | WorkerInitMessage
  | WorkerBatchMessage
  | WorkerAggInitMessage
  | WorkerSnapshotMessage
  | WorkerFlushUnloadMessage;

/** The delivery result for one batch, reported back to the main thread. */
export interface WorkerResultMessage {
  type: "result";
  id: number;
  ok: boolean;
}

/** Finalized events produced by the worker-resident aggregator (#10). */
export interface WorkerEventsMessage {
  type: "events";
  /** The `capturedAt` of the snapshot that produced these events (for `ts`). */
  capturedAt: number;
  /** Finalized, envelope-less events to emit on the page. */
  events: EventInput[];
}

/** Ack that the unload drain barrier has been reached (#10). */
export interface WorkerUnloadDoneMessage {
  type: "unloadDone";
  id: number;
}

/** Messages the worker sends back to the main thread. */
export type WorkerOutbound =
  | WorkerResultMessage
  | WorkerEventsMessage
  | WorkerUnloadDoneMessage;
