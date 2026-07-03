import { describe, it, expect, vi, afterEach } from "vitest";
import { anyEventSchema } from "@uptimizr/schema";

import { UptimizrClient } from "../client.js";
import { createAggregator, type Aggregator } from "../aggregation/aggregator.js";
import type { Snapshot } from "../aggregation/snapshot.js";
import type { WorkerLike } from "../processor.js";
import type { Collector, CollectorContext, EventInput } from "../types.js";

/**
 * In-memory stand-in for the offload worker that hosts a **real** aggregator,
 * mirroring `offloadWorker.ts`. This drives the full client → sink → worker →
 * aggregator → back → queue → transport-worker round trip so the connector-side
 * offload path (ADR 0031 follow-up, #10) can be exercised without a runtime
 * worker.
 */
function makeFakeWorker() {
  const messageListeners: Array<(event: { data: unknown }) => void> = [];
  const posted: Array<{ message: unknown; transfer?: Transferable[] }> = [];
  let aggregator: Aggregator | undefined;
  let buffer: EventInput[] = [];

  const emit = (data: unknown) => {
    for (const l of messageListeners) l({ data });
  };

  const worker: WorkerLike = {
    postMessage(message, transfer) {
      posted.push({ message, transfer });
      const m = message as {
        type?: string;
        id?: number;
        capturedAt?: number;
        config?: Record<string, unknown>;
        snapshot?: Snapshot;
      };
      switch (m?.type) {
        case "aggInit":
          aggregator = createAggregator({ ...m.config, emit: (e) => buffer.push(e) });
          return;
        case "snapshot": {
          if (!aggregator) return;
          buffer = [];
          aggregator.ingest(m.snapshot as Snapshot);
          if (buffer.length > 0) {
            const events = buffer;
            buffer = [];
            queueMicrotask(() => emit({ type: "events", capturedAt: m.capturedAt, events }));
          }
          return;
        }
        case "flushUnload":
          queueMicrotask(() => emit({ type: "unloadDone", id: m.id }));
          return;
        case "batch":
          queueMicrotask(() => emit({ type: "result", id: m.id, ok: true }));
          return;
      }
    },
    addEventListener(type: "message" | "error", listener: (event: never) => void) {
      if (type === "message") {
        messageListeners.push(listener as (event: { data: unknown }) => void);
      }
    },
    terminate: vi.fn(),
  };

  return {
    worker,
    posted,
    msgs: (type: string) => posted.filter((p) => (p.message as { type?: string }).type === type),
  };
}

const baseConfig = {
  projectId: "proj_demo",
  endpoint: "https://collect.test",
  flushIntervalMs: 0,
  batchSize: 1000,
} as const;

/** Deterministic clock so `capturedAt` threading is assertable. */
class TestClient extends UptimizrClient {
  t = 1000;
  override now(): number {
    return this.t;
  }
}

/** A collector that captures `ctx.snapshot` so the test can drive frames. */
function snapshotCollector(): { collector: Collector; snap: () => (s: Snapshot) => void } {
  let emit: (s: Snapshot) => void = () => {};
  const collector: Collector = {
    name: "test-snapshots",
    start(ctx: CollectorContext) {
      emit = ctx.createAggregation({});
      return { stop: () => emit({ channel: "visibilityFlush" }) };
    },
  };
  return { collector, snap: () => emit };
}

const perfSnapshot = (): Snapshot => ({
  channel: "perf",
  frameTimes: new Float32Array([16, 17, 16]),
  fps: 60,
  jankFrameMs: 50,
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("connector-side aggregation offload (ADR 0031 follow-up)", () => {
  it("routes snapshots to the worker and queues the worker-finalized events", async () => {
    const fake = makeFakeWorker();
    const { collector, snap } = snapshotCollector();

    const client = new TestClient({
      ...baseConfig,
      offload: "worker",
      createWorker: () => fake.worker as unknown as Worker,
    });
    client.use(collector);
    client.start();

    client.t = 4242;
    snap()(perfSnapshot());
    await Promise.resolve(); // let the worker echo events back

    // The snapshot was posted to the worker (not aggregated on the main thread).
    expect(fake.msgs("snapshot")).toHaveLength(1);

    await client.flush();
    const batches = fake.msgs("batch");
    const events = batches.flatMap(
      (b) => (b.message as { batch: { events: EventInput[] } }).batch.events,
    );
    const perf = events.find((e) => (e as { type: string }).type === "frame_perf");
    expect(perf).toBeDefined();
    // The page-stamped capturedAt is carried onto the event ts (no round-trip skew).
    expect((perf as { ts: number }).ts).toBe(4242);
    expect(anyEventSchema.safeParse(perf).success).toBe(true);
  });

  it("falls back to a main-thread aggregator when the worker cannot be constructed", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue({ ok: true } as Response);
    const { collector, snap } = snapshotCollector();

    const client = new TestClient({
      ...baseConfig,
      offload: "worker",
      createWorker: () => {
        throw new Error("no worker asset");
      },
    });
    client.use(collector);
    client.start();
    snap()(perfSnapshot()); // aggregated synchronously on the main thread
    await client.flush();

    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("drains the final window on stop before the terminal flush", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue({ ok: true } as Response);
    const fake = makeFakeWorker();
    const { collector, snap } = snapshotCollector();

    const client = new TestClient({
      ...baseConfig,
      offload: "worker",
      createWorker: () => fake.worker as unknown as Worker,
    });
    client.use(collector);
    client.start();

    // Accumulate a visibility window worker-side, but do not flush it yet.
    snap()({
      channel: "visibilityTick",
      stepMs: 16,
      camPos: [0, 0, 0],
      forward: [0, 0, 1],
      fov: 0.8,
      meshes: [{ mesh: "hero", center: [0, 0, 5], radius: 1 }],
    });
    await Promise.resolve();

    await client.stop("manual");

    // stop() emitted the final visibilityFlush (collector handle.stop), drained
    // it (the worker echoed the mesh_visibility back), and only then ran the
    // terminal main-thread flush — so the event reaches the wire, not lost.
    expect(fake.msgs("flushUnload")).toHaveLength(1);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const body = JSON.parse(String(fetchSpy.mock.calls[0]![1]!.body)) as {
      events: EventInput[];
    };
    expect(body.events.some((e) => (e as { type: string }).type === "mesh_visibility")).toBe(true);
  });
});
