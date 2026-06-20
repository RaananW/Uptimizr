import { afterEach, describe, expect, it } from "vitest";
import type { AnyEvent } from "@uptimizr/schema";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../app.js";
import type { CollectorConfig } from "../config.js";
import type { CollectorStore } from "../store.js";
import { mintLiveToken } from "../liveToken.js";

const baseConfig: CollectorConfig = {
  host: "127.0.0.1",
  port: 0,
  corsOrigins: [],
  visitorHashSecret: "test-secret",
  enableRawSessionRetention: false,
  liveWindowMs: 30_000,
  liveTokenSecret: "test-live-secret",
  liveTokenSecretIsDedicated: true,
  liveTokenTtlMs: 900_000,
  liveMaxConnections: 200,
  livePresenceIntervalMs: 50,
  rateLimitMax: 1000,
  rateLimitWindowMs: 60_000,
  ingestRateLimitMax: 1000,
  ingestRateLimitWindowMs: 60_000,
  trustProxy: false,
  bodyLimit: 1_048_576,
  cspMode: "strict",
};

function makeStore(): CollectorStore {
  return {
    resolveApiKey: async (key) => (key === "valid-key" ? "p1" : null),
    projectExists: async (id) => id === "p1",
    insertEvents: async () => {},
  } as unknown as CollectorStore;
}

function sessionStart(sessionId = "s1"): AnyEvent {
  return {
    type: "session_start",
    projectId: "p1",
    sessionId,
    ts: Date.now(),
    sdkVersion: "0.1.0",
  } as AnyEvent;
}

const servers: FastifyInstance[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.close()));
});

async function listen(config: CollectorConfig = baseConfig): Promise<{ app: FastifyInstance; base: string }> {
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
  timeoutMs = 2_000,
): Promise<{ frames: SseFrame[]; abort: () => void }> {
  const controller = new AbortController();
  const res = await fetch(url, {
    headers: { accept: "text/event-stream" },
    signal: controller.signal,
  });
  if (!res.ok || !res.body) {
    controller.abort();
    throw new Error(`sse open failed: ${res.status}`);
  }
  const frames: SseFrame[] = [];
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const deadline = Date.now() + timeoutMs;

  while (frames.length < count) {
    if (Date.now() > deadline) {
      controller.abort();
      throw new Error(`sse timed out after ${frames.length}/${count} frames`);
    }
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let sep: number;
    while ((sep = buffer.indexOf("\n\n")) !== -1) {
      const block = buffer.slice(0, sep);
      buffer = buffer.slice(sep + 2);
      if (block.startsWith(":")) continue; // comment / heartbeat
      let event: string | undefined;
      const dataLines: string[] = [];
      for (const line of block.split("\n")) {
        if (line.startsWith("event:")) event = line.slice(6).trim();
        else if (line.startsWith("data:")) dataLines.push(line.slice(5).trim());
      }
      if (dataLines.length > 0) frames.push({ event, data: dataLines.join("\n") });
    }
  }
  controller.abort();
  return { frames, abort: () => controller.abort() };
}

describe("live token endpoint", () => {
  it("rejects a missing or invalid api key", async () => {
    const app = await buildApp({ store: makeStore(), config: baseConfig });
    const missing = await app.inject({ method: "POST", url: "/api/v1/live/token" });
    expect(missing.statusCode).toBe(401);
    const bad = await app.inject({
      method: "POST",
      url: "/api/v1/live/token",
      headers: { "x-api-key": "nope" },
    });
    expect(bad.statusCode).toBe(401);
    await app.close();
  });

  it("mints a project-scoped token for a valid api key", async () => {
    const app = await buildApp({ store: makeStore(), config: baseConfig });
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/live/token",
      headers: { "x-api-key": "valid-key" },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { token: string; expiresAt: number };
    expect(typeof body.token).toBe("string");
    expect(body.expiresAt).toBeGreaterThan(Date.now());
    await app.close();
  });
});

describe("live SSE auth gates", () => {
  it("rejects presence without a token", async () => {
    const app = await buildApp({ store: makeStore(), config: baseConfig });
    const res = await app.inject({ method: "GET", url: "/api/v1/live/presence" });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it("rejects an invalid token", async () => {
    const app = await buildApp({ store: makeStore(), config: baseConfig });
    const res = await app.inject({ method: "GET", url: "/api/v1/live/presence?token=garbage" });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it("blocks live-follow when raw retention is disabled", async () => {
    const app = await buildApp({ store: makeStore(), config: baseConfig });
    const { token } = mintLiveToken("p1", baseConfig.liveTokenSecret, 60_000);
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/live/sessions/s1?token=${token}`,
    });
    expect(res.statusCode).toBe(403);
    await app.close();
  });
});

describe("live SSE streams", () => {
  it("pushes an initial presence snapshot", async () => {
    const { base } = await listen();
    const { token } = mintLiveToken("p1", baseConfig.liveTokenSecret, 60_000);
    const { frames } = await readSse(`${base}/api/v1/live/presence?token=${token}`, 1);
    expect(frames[0].event).toBe("presence");
    const snap = JSON.parse(frames[0].data) as { activeSessions: number };
    expect(snap).toHaveProperty("activeSessions");
    expect(snap).toHaveProperty("activeVisitors");
  });

  it("streams ingested events on the project firehose", async () => {
    const { base } = await listen();
    const { token } = mintLiveToken("p1", baseConfig.liveTokenSecret, 60_000);

    const streamPromise = readSse(`${base}/api/v1/live/stream?token=${token}`, 1);
    // Give the stream a tick to subscribe before ingesting.
    await new Promise((r) => setTimeout(r, 100));
    await fetch(`${base}/api/v1/collect`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ schemaVersion: "1.0", events: [sessionStart("s9")] }),
    });

    const { frames } = await streamPromise;
    expect(frames[0].event).toBe("event");
    const ev = JSON.parse(frames[0].data) as AnyEvent;
    expect(ev.sessionId).toBe("s9");
  });

  it("backfills and tails a session when retention is enabled", async () => {
    const { base } = await listen({ ...baseConfig, enableRawSessionRetention: true });
    const { token } = mintLiveToken("p1", baseConfig.liveTokenSecret, 60_000);

    // Ingest one event first so the backfill ring has content.
    await fetch(`${base}/api/v1/collect`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ schemaVersion: "1.0", events: [sessionStart("follow-me")] }),
    });

    const { frames } = await readSse(`${base}/api/v1/live/sessions/follow-me?token=${token}`, 1);
    const ev = JSON.parse(frames[0].data) as AnyEvent;
    expect(ev.sessionId).toBe("follow-me");
  });
});

describe("live SSE CORS", () => {
  // SSE responses are written on the raw socket (hijacked), bypassing the CORS
  // plugin's `reply.header` path. The route must reflect an allowed Origin itself
  // or a cross-origin EventSource (e.g. the dashboard on a different origin than
  // the collector) is blocked by the browser.
  it("reflects an allowed Origin on the SSE response", async () => {
    const origin = "http://dashboard.example";
    const { base } = await listen({ ...baseConfig, corsOrigins: [origin] });
    const { token } = mintLiveToken("p1", baseConfig.liveTokenSecret, 60_000);
    const controller = new AbortController();
    const res = await fetch(`${base}/api/v1/live/presence?token=${token}`, {
      headers: { accept: "text/event-stream", origin },
      signal: controller.signal,
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("access-control-allow-origin")).toBe(origin);
    expect(res.headers.get("vary")).toContain("Origin");
    controller.abort();
  });

  it("omits the CORS header for a disallowed Origin", async () => {
    const { base } = await listen({ ...baseConfig, corsOrigins: ["http://allowed.example"] });
    const { token } = mintLiveToken("p1", baseConfig.liveTokenSecret, 60_000);
    const controller = new AbortController();
    const res = await fetch(`${base}/api/v1/live/presence?token=${token}`, {
      headers: { accept: "text/event-stream", origin: "http://evil.example" },
      signal: controller.signal,
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
    controller.abort();
  });
});
