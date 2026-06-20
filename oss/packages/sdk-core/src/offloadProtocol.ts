import type { CollectRequest } from "@uptimizr/schema";

/**
 * Wire protocol for the opt-in offload worker (ADR 0031).
 *
 * These are **type-only** definitions shared by the main-thread processor
 * ([`processor.ts`](./processor.ts)) and the worker entry
 * ([`offloadWorker.ts`](./offloadWorker.ts)). Keeping the protocol in its own
 * module (with no runtime exports) means the worker bundle pulls in none of the
 * processor's runtime code — it stays tiny.
 *
 * The only thing that crosses the boundary is the plain-data `CollectRequest`
 * DTO: by the time a batch reaches the worker it is an array of Zod-shaped plain
 * objects with no engine/DOM handles, so it travels by structured clone (or, for
 * buffer-backed fields, by transfer).
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

/** Messages the main thread sends to the worker. */
export type WorkerInbound = WorkerInitMessage | WorkerBatchMessage;

/** The delivery result for one batch, reported back to the main thread. */
export interface WorkerResultMessage {
  type: "result";
  id: number;
  ok: boolean;
}

/** Messages the worker sends back to the main thread. */
export type WorkerOutbound = WorkerResultMessage;
