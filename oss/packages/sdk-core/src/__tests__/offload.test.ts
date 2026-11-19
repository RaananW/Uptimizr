import { describe, it, expect, vi, afterEach } from "vitest";
import { anyEventSchema, LIMITS, SCHEMA_VERSION, type CollectRequest } from "@uptimizr/schema";
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
    batchMessages: () => posted.filter((p) => (p.message as { type?: string }).type === "batch"),
  };
}

/**
 * Boot the **real** `offloadWorker.ts` module behind a {@link WorkerLike}: the
 * module's `self` is a stub whose `postMessage` feeds the page-side listeners
 * and whose `fetch` answers each POST with the next scripted status (or throws
 * for a network error), so the worker's own response handling is under test.
 */
async function bootRealWorker(responses: Array<number | Error>) {
  const pageListeners: Array<(event: { data: unknown }) => void> = [];
  const workerListeners: Array<(event: { data: unknown }) => void> = [];
  const posted: Array<{ events: Array<{ type: string; name?: string }> }> = [];
  let call = 0;

  const fetch = vi.fn(async (_url: string, init: RequestInit) => {
    posted.push(JSON.parse(String(init.body)) as (typeof posted)[number]);
    const next = responses[Math.min(call++, responses.length - 1)]!;
    if (next instanceof Error) throw next;
    return { ok: next >= 200 && next < 300, status: next } as Response;
  });

  vi.stubGlobal("self", {
    postMessage(message: unknown) {
      queueMicrotask(() => {
        for (const l of pageListeners) l({ data: message });
      });
    },
    addEventListener(_type: "message", listener: (event: { data: unknown }) => void) {
      workerListeners.push(listener);
    },
    fetch,
  });
  vi.resetModules(); // a fresh module scope (and listener) per worker
  await import("../offloadWorker.js");

  const worker: WorkerLike = {
    postMessage(message) {
      for (const l of workerListeners) l({ data: message });
    },
    addEventListener(type: "message" | "error", listener: (event: never) => void) {
      if (type === "message") pageListeners.push(listener as (event: { data: unknown }) => void);
    },
    terminate: vi.fn(),
  };
  return { worker, fetch, posted };
}

const baseConfig = {
  projectId: "proj_demo",
  endpoint: "https://collect.test",
  flushIntervalMs: 0, // no timer; flush manually
  batchSize: 1000, // no size-based auto-flush
} as const;

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("offload: worker (ADR 0031)", () => {
  it("routes steady-state flushes to the worker and the unload flush to the main thread", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue({ ok: true } as Response);
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

  it("never hands the worker a batch above LIMITS.maxBatchEvents (#402)", async () => {
    const fake = makeFakeWorker();
    const client = new UptimizrClient({
      ...baseConfig,
      maxQueueSize: 2500,
      batchSize: 5000, // no size-based auto-flush: one explicit drain of the backlog
      offload: "worker",
      createWorker: () => fake.worker as unknown as Worker,
    });

    client.start();
    for (let i = 0; i < 2400; i++) client.track(`e${i}`);
    await client.flush();

    const batches = fake.batchMessages().map((p) => (p.message as { batch: CollectRequest }).batch);
    // Count-bounded only: the worker posts with `fetch` (no beacon quota), so the
    // steady-state path is not split by bytes and stays off the main thread.
    expect(batches.map((b) => b.events.length)).toEqual([
      LIMITS.maxBatchEvents,
      LIMITS.maxBatchEvents,
      401,
    ]);
    const names = batches
      .flatMap((b) => b.events)
      .map((e) => (e.type === "custom" ? e.name : e.type));
    expect(names).toEqual(["session_start", ...Array.from({ length: 2400 }, (_, i) => `e${i}`)]);
  });

  it("falls back to the main-thread processor when the worker cannot be constructed", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue({ ok: true } as Response);

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

// The worker must classify a collector response exactly like the main-thread
// transport (#274, #403): a definitive 4xx is handled and dropped, while network
// errors, 5xx, 408 and 429 re-queue. Otherwise a rejected batch sits at the head
// of every later batch and blocks delivery until the queue evicts it.
describe("offload: worker response handling", () => {
  async function flushTwice(first: number | Error) {
    const real = await bootRealWorker([first, 202]);
    const client = new UptimizrClient({
      ...baseConfig,
      offload: "worker",
      createWorker: () => real.worker as unknown as Worker,
    });
    client.start();
    client.track("first");
    await client.flush(); // answered with `first`
    client.track("second");
    await client.flush(); // answered 202
    const names = (i: number) =>
      real.posted[i]!.events.filter((e) => e.type === "custom").map((e) => e.name);
    return { real, names };
  }

  it("treats a definitive 4xx as handled (not re-queued)", async () => {
    for (const status of [400, 401, 403, 413]) {
      const { real, names } = await flushTwice(status);
      expect(real.fetch).toHaveBeenCalledTimes(2);
      expect(names(0)).toEqual(["first"]);
      expect(names(1)).toEqual(["second"]); // the rejected batch was dropped
    }
  });

  it("keeps transient failures retryable", async () => {
    for (const failure of [408, 429, 500, 503, new Error("network down")]) {
      const { real, names } = await flushTwice(failure);
      expect(real.fetch).toHaveBeenCalledTimes(2);
      expect(names(0)).toEqual(["first"]);
      expect(names(1)).toEqual(["first", "second"]); // re-queued at the head
    }
  });
});
