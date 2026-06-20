import { describe, it, expect, vi } from "vitest";
import { SCHEMA_VERSION, type AnyEvent, type CollectRequest } from "@uptimizr/schema";
import {
  createMainProcessor,
  createWorkerProcessor,
  collectTransferables,
  type WorkerLike,
} from "../processor.js";
import type { Transport } from "../types.js";

/** A schema-shaped custom event, enough to build a realistic batch. */
function sampleEvent(name: string): AnyEvent {
  return {
    type: "custom",
    name,
    projectId: "proj_demo",
    sessionId: "sess_1",
    ts: 1,
    sdkVersion: "0.0.0-test",
  } as AnyEvent;
}

function batchOf(...events: AnyEvent[]): CollectRequest {
  return { schemaVersion: SCHEMA_VERSION, events };
}

function mockTransport() {
  const sent: CollectRequest[] = [];
  let ok = true;
  const transport: Transport = {
    send: async (batch) => {
      sent.push(batch);
      return ok;
    },
  };
  return {
    transport,
    sent,
    setOk: (v: boolean) => {
      ok = v;
    },
  };
}

/**
 * A controllable in-memory stand-in for a dedicated `Worker`. By default it
 * auto-replies to every `batch` message with a success result on a microtask,
 * mimicking the real worker round-trip without a runtime worker.
 */
function makeFakeWorker() {
  const messageListeners: Array<(event: { data: unknown }) => void> = [];
  const errorListeners: Array<(event: unknown) => void> = [];
  const posted: Array<{ message: unknown; transfer?: Transferable[] }> = [];
  let autoRespond = true;
  let respondOk = true;

  const worker: WorkerLike = {
    postMessage(message, transfer) {
      posted.push({ message, transfer });
      const m = message as { type?: string; id?: number };
      if (m?.type === "batch" && autoRespond) {
        queueMicrotask(() => {
          for (const l of messageListeners) {
            l({ data: { type: "result", id: m.id, ok: respondOk } });
          }
        });
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
    batchMessages: () =>
      posted.filter((p) => (p.message as { type?: string }).type === "batch"),
    initMessages: () =>
      posted.filter((p) => (p.message as { type?: string }).type === "init"),
    emitResult: (id: number, ok: boolean) => {
      for (const l of messageListeners) l({ data: { type: "result", id, ok } });
    },
    emitError: () => {
      for (const l of errorListeners) l({});
    },
    setAutoRespond: (v: boolean) => {
      autoRespond = v;
    },
    setRespondOk: (v: boolean) => {
      respondOk = v;
    },
  };
}

describe("createMainProcessor", () => {
  it("delegates both steady-state and unload sends to the transport", async () => {
    const m = mockTransport();
    const processor = createMainProcessor(m.transport);

    await expect(processor.process(batchOf(sampleEvent("a")))).resolves.toBe(true);
    await expect(processor.processUnload(batchOf(sampleEvent("b")))).resolves.toBe(true);

    expect(m.sent).toHaveLength(2);
    expect((m.sent[0]!.events[0] as { name: string }).name).toBe("a");
    expect((m.sent[1]!.events[0] as { name: string }).name).toBe("b");
  });

  it("propagates transport failure so the caller can re-queue", async () => {
    const m = mockTransport();
    m.setOk(false);
    const processor = createMainProcessor(m.transport);
    await expect(processor.process(batchOf(sampleEvent("a")))).resolves.toBe(false);
  });
});

describe("collectTransferables", () => {
  it("returns an empty list for ordinary plain-object events", () => {
    expect(collectTransferables(batchOf(sampleEvent("a"), sampleEvent("b")))).toEqual([]);
  });

  it("collects ArrayBuffers and typed-array buffers, de-duplicated", () => {
    const buf = new ArrayBuffer(8);
    const view = new Float32Array(4); // distinct buffer
    const eventWithBuffers = {
      ...sampleEvent("packed"),
      raw: buf,
      samples: view,
      rawAgain: buf, // same buffer twice -> must appear once
    } as unknown as AnyEvent;

    const transfer = collectTransferables(batchOf(eventWithBuffers));
    expect(transfer).toContain(buf);
    expect(transfer).toContain(view.buffer);
    expect(transfer.filter((t) => t === buf)).toHaveLength(1);
    expect(transfer).toHaveLength(2);
  });
});

describe("createWorkerProcessor", () => {
  it("returns null when the worker cannot be constructed (graceful fallback)", () => {
    const m = mockTransport();
    const processor = createWorkerProcessor({
      endpoint: "https://collect.test",
      unloadTransport: m.transport,
      workerFactory: () => {
        throw new Error("no Worker in this environment");
      },
    });
    expect(processor).toBeNull();
  });

  it("posts an init message with the resolved collect URL on construction", () => {
    const fake = makeFakeWorker();
    const m = mockTransport();
    createWorkerProcessor({
      endpoint: "https://collect.test/",
      unloadTransport: m.transport,
      workerFactory: () => fake.worker,
    });
    const init = fake.initMessages();
    expect(init).toHaveLength(1);
    expect((init[0]!.message as { url: string }).url).toBe(
      "https://collect.test/api/v1/collect",
    );
  });

  it("routes steady-state batches to the worker and resolves with its result", async () => {
    const fake = makeFakeWorker();
    const m = mockTransport();
    const processor = createWorkerProcessor({
      endpoint: "https://collect.test",
      unloadTransport: m.transport,
      workerFactory: () => fake.worker,
    })!;

    await expect(processor.process(batchOf(sampleEvent("a")))).resolves.toBe(true);
    expect(fake.batchMessages()).toHaveLength(1);
    // Steady-state must NOT touch the main-thread transport.
    expect(m.sent).toHaveLength(0);
  });

  it("resolves false when the worker reports a failed send", async () => {
    const fake = makeFakeWorker();
    fake.setRespondOk(false);
    const m = mockTransport();
    const processor = createWorkerProcessor({
      endpoint: "https://collect.test",
      unloadTransport: m.transport,
      workerFactory: () => fake.worker,
    })!;
    await expect(processor.process(batchOf(sampleEvent("a")))).resolves.toBe(false);
  });

  it("sends the unload flush via the main-thread transport, not the worker", async () => {
    const fake = makeFakeWorker();
    const m = mockTransport();
    const processor = createWorkerProcessor({
      endpoint: "https://collect.test",
      unloadTransport: m.transport,
      workerFactory: () => fake.worker,
    })!;

    await expect(processor.processUnload(batchOf(sampleEvent("bye")))).resolves.toBe(true);
    expect(m.sent).toHaveLength(1);
    expect(fake.batchMessages()).toHaveLength(0);
  });

  it("fails all in-flight sends when the worker errors (so they re-queue)", async () => {
    const fake = makeFakeWorker();
    fake.setAutoRespond(false); // hold the result so the send stays pending
    const m = mockTransport();
    const processor = createWorkerProcessor({
      endpoint: "https://collect.test",
      unloadTransport: m.transport,
      workerFactory: () => fake.worker,
    })!;

    const pending = processor.process(batchOf(sampleEvent("a")));
    fake.emitError();
    await expect(pending).resolves.toBe(false);
  });

  it("passes a transfer list alongside buffer-backed batches", async () => {
    const fake = makeFakeWorker();
    const m = mockTransport();
    const processor = createWorkerProcessor({
      endpoint: "https://collect.test",
      unloadTransport: m.transport,
      workerFactory: () => fake.worker,
    })!;

    const buf = new ArrayBuffer(8);
    const event = { ...sampleEvent("packed"), raw: buf } as unknown as AnyEvent;
    await processor.process(batchOf(event));

    const [batchMsg] = fake.batchMessages();
    expect(batchMsg!.transfer).toContain(buf);
  });

  it("terminates the worker and rejects new sends after dispose", async () => {
    const fake = makeFakeWorker();
    const m = mockTransport();
    const processor = createWorkerProcessor({
      endpoint: "https://collect.test",
      unloadTransport: m.transport,
      workerFactory: () => fake.worker,
    })!;

    processor.dispose();
    expect(fake.worker.terminate).toHaveBeenCalledTimes(1);
    await expect(processor.process(batchOf(sampleEvent("a")))).resolves.toBe(false);
  });
});
