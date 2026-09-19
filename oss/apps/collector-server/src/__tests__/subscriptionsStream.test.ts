import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import type { ResolvedApiKey } from "@uptimizr/db";
import { buildApp } from "../app.js";
import { createMemoryStore } from "../memoryStore.js";
import type { CollectorStore } from "../store.js";
import { mintLiveToken } from "../liveToken.js";
import { TEST_CONFIG } from "./support/registryRequests.js";

/**
 * The subscription SSE stream (#311, sketch §F.3), over a real socket.
 *
 * `app.inject()` cannot exercise a hijacked response, so this suite listens on a
 * loopback port and reads the stream with `fetch`, the same way `live.test.ts`
 * does for the live endpoints. What it proves is the thing a connected agent
 * depends on: a firing recorded by `POST …/test?deliver=true` arrives on the
 * stream as a `subscription` event, and the `?id=` filter is honoured.
 */

const KEY: ResolvedApiKey = {
  projectId: "p1",
  keyId: "k",
  capabilities: ["query", "annotate"],
  label: null,
  rateLimit: null,
};

function makeStore(): CollectorStore {
  const store = createMemoryStore({ projectId: "p1", apiKey: "agent-key" });
  return {
    ...store,
    resolveApiKey: async (key: string) => (key === "agent-key" ? KEY : null),
    // A series that satisfies `p50_fps < 40`, so the subscription always fires.
    metricBuckets: async () => [{ bucket: 0, value: 12, sample_size: 500 }],
  } as CollectorStore;
}

const declaration = {
  name: "FPS drop",
  metric: "perf_summary",
  evaluate: { every: "5m", window: "1h" },
  predicate: { kind: "threshold", column: "p50_fps", op: "<", value: 40, minSample: 1 },
  cooldown: "0s",
  delivery: [{ kind: "sse" }],
};

const servers: FastifyInstance[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((app) => app.close()));
});

async function listen(
  config: typeof TEST_CONFIG = TEST_CONFIG,
): Promise<{ app: FastifyInstance; base: string }> {
  const app = await buildApp({ store: makeStore(), config });
  servers.push(app);
  await app.listen({ host: "127.0.0.1", port: 0 });
  const addr = app.server.address();
  if (!addr || typeof addr === "string") throw new Error("no address");
  return { app, base: `http://127.0.0.1:${addr.port}` };
}

interface SseFrame {
  event?: string;
  data: string;
}

/** Open an SSE request and resolve once `count` data frames have arrived. */
async function readSse(
  url: string,
  count: number,
  onOpen: () => void,
  timeoutMs = 5_000,
): Promise<SseFrame[]> {
  const controller = new AbortController();
  const res = await fetch(url, {
    headers: { accept: "text/event-stream" },
    signal: controller.signal,
  });
  if (!res.ok || !res.body) {
    controller.abort();
    throw new Error(`sse open failed: ${res.status}`);
  }
  onOpen();

  const frames: SseFrame[] = [];
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const deadline = Date.now() + timeoutMs;

  try {
    while (frames.length < count) {
      if (Date.now() > deadline) throw new Error(`sse timed out at ${frames.length}/${count}`);
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let sep: number;
      while ((sep = buffer.indexOf("\n\n")) !== -1) {
        const block = buffer.slice(0, sep);
        buffer = buffer.slice(sep + 2);
        if (block.startsWith(":")) continue; // heartbeat / open comment
        let event: string | undefined;
        const data: string[] = [];
        for (const line of block.split("\n")) {
          if (line.startsWith("event:")) event = line.slice(6).trim();
          else if (line.startsWith("data:")) data.push(line.slice(5).trim());
        }
        if (data.length > 0) frames.push({ event, data: data.join("\n") });
      }
    }
  } finally {
    controller.abort();
  }
  return frames;
}

describe("the SSE connection budget", () => {
  it("is shared with the live endpoints, not doubled", async () => {
    // `LIVE_MAX_CONNECTIONS` is meant to bound held-open sockets. If each SSE
    // plugin counted its own, the setting would quietly mean "up to 2 × max" —
    // and would grow every time another stream was added.
    const { base } = await listen({ ...TEST_CONFIG, liveMaxConnections: 1 });
    const { token } = mintLiveToken("p1", ["query"], TEST_CONFIG.liveTokenSecret, 60_000);

    const abort = new AbortController();
    const live = await fetch(`${base}/api/v1/live/stream?token=${token}`, {
      headers: { accept: "text/event-stream" },
      signal: abort.signal,
    });
    expect(live.status).toBe(200);

    try {
      const refused = await fetch(`${base}/api/v1/subscriptions/stream?token=${token}`, {
        headers: { accept: "text/event-stream" },
      });
      expect(refused.status).toBe(503);
      expect((await refused.json()).error).toContain("connection limit");
    } finally {
      abort.abort();
    }
  });
});

describe("GET /api/v1/subscriptions/stream", () => {
  it("delivers a firing to a connected listener", async () => {
    const { base } = await listen();
    const created = await (
      await fetch(`${base}/api/v1/subscriptions`, {
        method: "POST",
        headers: { "x-api-key": "agent-key", "content-type": "application/json" },
        body: JSON.stringify(declaration),
      })
    ).json();

    const { token } = mintLiveToken("p1", ["query"], TEST_CONFIG.liveTokenSecret, 60_000);
    const frames = await readSse(`${base}/api/v1/subscriptions/stream?token=${token}`, 1, () => {
      // Trigger only once the stream is open, so the firing cannot precede it.
      void fetch(`${base}/api/v1/subscriptions/${created.id}/test?deliver=true`, {
        method: "POST",
        headers: { "x-api-key": "agent-key" },
      });
    });

    expect(frames).toHaveLength(1);
    expect(frames[0]?.event).toBe("subscription");
    const message = JSON.parse(frames[0]!.data);
    expect(message.firing).toMatchObject({
      subscriptionId: created.id,
      metric: "perf_summary",
      predicate: "threshold",
      value: 12,
      expected: 40,
    });
    // The bounded `format=summary` block rides along, so a receiver needs no
    // second call.
    expect(message.summary).toHaveProperty("metric", "insight_baseline");
  });

  it("honours the `?id=` filter", async () => {
    const { base } = await listen();
    const headers = { "x-api-key": "agent-key", "content-type": "application/json" };
    const a = await (
      await fetch(`${base}/api/v1/subscriptions`, {
        method: "POST",
        headers,
        body: JSON.stringify({ ...declaration, name: "a" }),
      })
    ).json();
    const b = await (
      await fetch(`${base}/api/v1/subscriptions`, {
        method: "POST",
        headers,
        body: JSON.stringify({ ...declaration, name: "b" }),
      })
    ).json();

    const { token } = mintLiveToken("p1", ["query"], TEST_CONFIG.liveTokenSecret, 60_000);
    const frames = await readSse(
      `${base}/api/v1/subscriptions/stream?token=${token}&id=${b.id}`,
      1,
      () => {
        void (async () => {
          // `a` fires first and must be filtered out; `b` is the one that arrives.
          await fetch(`${base}/api/v1/subscriptions/${a.id}/test?deliver=true`, {
            method: "POST",
            headers: { "x-api-key": "agent-key" },
          });
          await fetch(`${base}/api/v1/subscriptions/${b.id}/test?deliver=true`, {
            method: "POST",
            headers: { "x-api-key": "agent-key" },
          });
        })();
      },
    );

    expect(frames).toHaveLength(1);
    expect(JSON.parse(frames[0]!.data).firing.subscriptionId).toBe(b.id);
  });

  it("records the firing in the bounded log a dashboard reads", async () => {
    const { base } = await listen();
    const created = await (
      await fetch(`${base}/api/v1/subscriptions`, {
        method: "POST",
        headers: { "x-api-key": "agent-key", "content-type": "application/json" },
        body: JSON.stringify(declaration),
      })
    ).json();

    await fetch(`${base}/api/v1/subscriptions/${created.id}/test?deliver=true`, {
      method: "POST",
      headers: { "x-api-key": "agent-key" },
    });

    const events = await (
      await fetch(`${base}/api/v1/subscriptions/${created.id}/events`, {
        headers: { "x-api-key": "agent-key" },
      })
    ).json();

    expect(events).toHaveLength(1);
    expect(events[0].payload).toMatchObject({ metric: "perf_summary", value: 12 });
    expect(events[0].at).toMatch(/^\d{4}-/);

    // And the subscription itself now reports when it last fired.
    const sub = await (
      await fetch(`${base}/api/v1/subscriptions/${created.id}`, {
        headers: { "x-api-key": "agent-key" },
      })
    ).json();
    expect(sub.lastFiredAt).toMatch(/^\d{4}-/);
    expect(sub.failures).toBe(0);
    expect(sub.lastError).toBeNull();
  });
});
