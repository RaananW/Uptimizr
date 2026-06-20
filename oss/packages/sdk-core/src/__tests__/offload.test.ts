import { describe, it, expect, vi, afterEach } from "vitest";
import { anyEventSchema, SCHEMA_VERSION } from "@uptimizr/schema";
import { UptimizrClient } from "../client.js";
import type { WorkerLike } from "../processor.js";

/**
 * In-memory stand-in for a dedicated `Worker`, auto-replying success to each
 * batch so the client's worker path can be exercised without a runtime worker.
 */
function makeFakeWorker() {
  const messageListeners: Array<(event: { data: unknown }) => void> = [];
  const errorListeners: Array<(event: unknown) => void> = [];
  const posted: Array<{ message: unknown; transfer?: Transferable[] }> = [];

  const worker: WorkerLike = {
    postMessage(message, transfer) {
      posted.push({ message, transfer });
      const m = message as { type?: string; id?: number };
      if (m?.type === "batch") {
        queueMicrotask(() => {
          for (const l of messageListeners) {
            l({ data: { type: "result", id: m.id, ok: true } });
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
    batchMessages: () =>
      posted.filter((p) => (p.message as { type?: string }).type === "batch"),
  };
}

const baseConfig = {
  projectId: "proj_demo",
  endpoint: "https://collect.test",
  flushIntervalMs: 0, // no timer; flush manually
  batchSize: 1000, // no size-based auto-flush
} as const;

afterEach(() => {
  vi.restoreAllMocks();
});

describe("offload: worker (ADR 0031)", () => {
  it("routes steady-state flushes to the worker and the unload flush to the main thread", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue({ ok: true } as Response);
    const fake = makeFakeWorker();

    const client = new UptimizrClient({
      ...baseConfig,
      offload: "worker",
      createWorker: () => fake.worker as unknown as Worker,
    });

    client.start(); // queues session_start
    await client.flush(); // steady-state -> worker

    expect(fake.batchMessages()).toHaveLength(1);
    expect(fetchSpy).not.toHaveBeenCalled(); // nothing on the main thread yet

    await client.stop("manual"); // session_end -> unload flush on main thread

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url] = fetchSpy.mock.calls[0]!;
    expect(String(url)).toBe("https://collect.test/api/v1/collect");
    // The terminal batch did NOT go through the worker.
    expect(fake.batchMessages()).toHaveLength(1);
  });

  it("hands the worker a schema-valid CollectRequest (output parity with the wire)", async () => {
    const fake = makeFakeWorker();
    const client = new UptimizrClient({
      ...baseConfig,
      offload: "worker",
      createWorker: () => fake.worker as unknown as Worker,
    });

    client.start();
    client.track("hello");
    await client.flush();

    const [batchMsg] = fake.batchMessages();
    const batch = (batchMsg!.message as { batch: { schemaVersion: unknown; events: unknown[] } })
      .batch;
    expect(batch.schemaVersion).toBe(SCHEMA_VERSION);
    expect(batch.events.length).toBeGreaterThanOrEqual(2); // session_start + custom
    for (const event of batch.events) {
      expect(anyEventSchema.safeParse(event).success).toBe(true);
    }
  });

  it("falls back to the main-thread processor when the worker cannot be constructed", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue({ ok: true } as Response);

    const client = new UptimizrClient({
      ...baseConfig,
      offload: "worker",
      createWorker: () => {
        throw new Error("bundler did not emit the worker asset");
      },
    });

    client.start();
    await client.flush(); // must reach the main-thread transport

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(String(fetchSpy.mock.calls[0]![0])).toBe("https://collect.test/api/v1/collect");
  });

  it("disables worker offload when a custom transport is supplied", async () => {
    const fake = makeFakeWorker();
    const sent: unknown[] = [];

    const client = new UptimizrClient({
      ...baseConfig,
      offload: "worker",
      createWorker: () => fake.worker as unknown as Worker,
      transport: {
        send: async (batch) => {
          sent.push(batch);
          return true;
        },
      },
    });

    client.start();
    await client.flush();

    // The custom transport (main thread) handled it; the worker was bypassed.
    expect(sent).toHaveLength(1);
    expect(fake.batchMessages()).toHaveLength(0);
  });
});
