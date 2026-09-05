import { afterEach, describe, expect, it, vi } from "vitest";

import { createBeaconTransport } from "../transport.js";
import type { CollectRequest } from "@uptimizr/schema";

// The default transport's contract: `true` when the batch needs no further
// attempt (delivered, or definitively rejected), `false` for transient failures
// the client should re-queue. A 400 re-sent forever would sit at the head of
// every later batch and block delivery until the queue evicts it.
const batch = { schemaVersion: 1, events: [] } as unknown as CollectRequest;

function stubFetch(status: number | Error): void {
  vi.stubGlobal("navigator", {}); // no sendBeacon → fetch path
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      if (status instanceof Error) throw status;
      return { ok: status >= 200 && status < 300, status } as Response;
    }),
  );
}

describe("createBeaconTransport", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("resolves true on 2xx", async () => {
    stubFetch(202);
    await expect(createBeaconTransport("https://c.test").send(batch)).resolves.toBe(true);
  });

  it("treats a definitive 4xx as handled (not re-queued)", async () => {
    for (const status of [400, 401, 403, 413]) {
      stubFetch(status);
      await expect(createBeaconTransport("https://c.test").send(batch)).resolves.toBe(true);
    }
  });

  it("keeps transient failures retryable", async () => {
    for (const status of [408, 429, 500, 503]) {
      stubFetch(status);
      await expect(createBeaconTransport("https://c.test").send(batch)).resolves.toBe(false);
    }
    stubFetch(new Error("network down"));
    await expect(createBeaconTransport("https://c.test").send(batch)).resolves.toBe(false);
  });
});
