import { describe, it, expect, vi } from "vitest";

import { createAggregator } from "../aggregation/aggregator.js";
import type { Snapshot } from "../aggregation/snapshot.js";
import { createMainSink, createWorkerAggregationSink } from "../aggregationSink.js";
import type { WorkerLike } from "../processor.js";
import type { EventInput } from "../types.js";

/**
 * A controllable in-memory stand-in for the offload worker, exercising the
 * **aggregation** protocol (`aggInit` / `snapshot` / `flushUnload` →
 * `events` / `unloadDone`) without a runtime worker.
 *
 * By default each `snapshot` echoes back a single `events` message so routing
 * and the `capturedAt` threading can be asserted; `flushUnload` always echoes
 * `unloadDone` to release the drain barrier.
 */
function makeFakeAggWorker() {
  const messageListeners: Array<(event: { data: unknown }) => void> = [];
  const errorListeners: Array<(event: unknown) => void> = [];
  const posted: Array<{ message: unknown; transfer?: Transferable[] }> = [];
  let autoEvents = true;

  const emit = (data: unknown) => {
    for (const l of messageListeners) l({ data });
  };

  const worker: WorkerLike = {
    postMessage(message, transfer) {
      posted.push({ message, transfer });
      const m = message as { type?: string; id?: number; capturedAt?: number };
      if (m?.type === "snapshot" && autoEvents) {
        queueMicrotask(() => {
          emit({
            type: "events",
            capturedAt: m.capturedAt,
            events: [{ type: "frame_perf", fps: 60 } as EventInput],
          });
        });
      } else if (m?.type === "flushUnload") {
        queueMicrotask(() => emit({ type: "unloadDone", id: m.id }));
      }
    },
    addEventListener(type: "message" | "error", listener: (event: never) => void) {
      if (type === "message") {
        messageListeners.push(listener as (event: { data: unknown }) => void);
      } else {
        errorListeners.push(listener as (event: unknown) => void);
      }
    },
    terminate: vi.fn(),
  };

  return {
    worker,
    posted,
    msgs: (type: string) => posted.filter((p) => (p.message as { type?: string }).type === type),
    emit,
    emitError: () => {
      for (const l of errorListeners) l({});
    },
    setAutoEvents: (v: boolean) => {
      autoEvents = v;
    },
  };
}

const perfSnapshot = (): Snapshot => ({
  channel: "perf",
  frameTimes: new Float32Array([16, 17, 16]),
  fps: 60,
  jankFrameMs: 50,
});

const nodeSnapshot = (): Snapshot => ({
  channel: "node",
  nodeId: "n1",
  matrix: new Float32Array(16),
  scaleEps: 1e-3,
});

describe("createMainSink", () => {
  it("runs the aggregator synchronously on ingest and emits inline", () => {
    const events: EventInput[] = [];
    const aggregator = createAggregator({ emit: (e) => events.push(e) });
    const sink = createMainSink(aggregator);

    sink.ingest(perfSnapshot(), 123);

    expect(events).toHaveLength(1);
    expect((events[0] as { type: string }).type).toBe("frame_perf");
  });

  it("resolves drain immediately and dispose is a no-op", async () => {
    const aggregator = createAggregator({ emit: () => {} });
    const sink = createMainSink(aggregator);
    await expect(sink.drain()).resolves.toBeUndefined();
    expect(() => sink.dispose()).not.toThrow();
  });
});

describe("createWorkerAggregationSink", () => {
  it("returns null when the worker cannot be constructed (graceful fallback)", () => {
    const sink = createWorkerAggregationSink({
      config: {},
      onEvents: () => {},
      workerFactory: () => {
        throw new Error("no Worker here");
      },
    });
    expect(sink).toBeNull();
  });

  it("posts an aggInit with the config on construction", () => {
    const fake = makeFakeAggWorker();
    createWorkerAggregationSink({
      config: { perf: { suppressIdle: true, fpsThreshold: 2 } },
      onEvents: () => {},
      workerFactory: () => fake.worker,
    });
    const init = fake.msgs("aggInit");
    expect(init).toHaveLength(1);
    expect((init[0]!.message as { config: unknown }).config).toEqual({
      perf: { suppressIdle: true, fpsThreshold: 2 },
    });
  });

  it("routes a snapshot to the worker and stamps capturedAt", () => {
    const fake = makeFakeAggWorker();
    const sink = createWorkerAggregationSink({
      config: {},
      onEvents: () => {},
      workerFactory: () => fake.worker,
    })!;

    sink.ingest(perfSnapshot(), 999);

    const snaps = fake.msgs("snapshot");
    expect(snaps).toHaveLength(1);
    expect((snaps[0]!.message as { capturedAt: number }).capturedAt).toBe(999);
  });

  it("transfers buffer-backed snapshot channels zero-copy", () => {
    const fake = makeFakeAggWorker();
    const sink = createWorkerAggregationSink({
      config: {},
      onEvents: () => {},
      workerFactory: () => fake.worker,
    })!;

    const snap = nodeSnapshot() as Extract<Snapshot, { channel: "node" }>;
    sink.ingest(snap, 1);

    const [posted] = fake.msgs("snapshot");
    expect(posted!.transfer).toContain(snap.matrix!.buffer);
  });

  it("delivers worker-finalized events back via onEvents with their capturedAt", async () => {
    const fake = makeFakeAggWorker();
    const received: Array<{ events: EventInput[]; capturedAt: number }> = [];
    const sink = createWorkerAggregationSink({
      config: {},
      onEvents: (events, capturedAt) => received.push({ events, capturedAt }),
      workerFactory: () => fake.worker,
    })!;

    sink.ingest(perfSnapshot(), 555);
    await Promise.resolve();

    expect(received).toHaveLength(1);
    expect(received[0]!.capturedAt).toBe(555);
    expect((received[0]!.events[0] as { type: string }).type).toBe("frame_perf");
  });

  it("drain posts a flushUnload barrier and resolves on unloadDone", async () => {
    const fake = makeFakeAggWorker();
    const sink = createWorkerAggregationSink({
      config: {},
      onEvents: () => {},
      workerFactory: () => fake.worker,
    })!;

    await expect(sink.drain()).resolves.toBeUndefined();
    expect(fake.msgs("flushUnload")).toHaveLength(1);
  });

  it("drains every prior snapshot's events before the barrier resolves", async () => {
    const fake = makeFakeAggWorker();
    const order: string[] = [];
    const sink = createWorkerAggregationSink({
      config: {},
      onEvents: () => order.push("events"),
      workerFactory: () => fake.worker,
    })!;

    sink.ingest(perfSnapshot(), 1);
    sink.ingest(perfSnapshot(), 2);
    await sink.drain();
    order.push("drained");

    // Both event echoes (queued before the flushUnload echo) ran first.
    expect(order).toEqual(["events", "events", "drained"]);
  });

  it("unblocks a pending drain if the worker errors", async () => {
    const fake = makeFakeAggWorker();
    fake.setAutoEvents(false);
    const sink = createWorkerAggregationSink({
      config: {},
      onEvents: () => {},
      workerFactory: () => fake.worker,
    })!;

    // Hold the drain by not echoing unloadDone, then error.
    const origPost = fake.worker.postMessage;
    fake.worker.postMessage = (message, transfer) => {
      if ((message as { type?: string }).type === "flushUnload") return; // swallow
      origPost.call(fake.worker, message, transfer);
    };
    const pending = sink.drain();
    fake.emitError();
    await expect(pending).resolves.toBeUndefined();
  });

  it("terminates the worker and ignores ingest after dispose", () => {
    const fake = makeFakeAggWorker();
    const sink = createWorkerAggregationSink({
      config: {},
      onEvents: () => {},
      workerFactory: () => fake.worker,
    })!;

    sink.dispose();
    expect(fake.worker.terminate).toHaveBeenCalledTimes(1);
    sink.ingest(perfSnapshot(), 1);
    expect(fake.msgs("snapshot")).toHaveLength(0);
  });
});
