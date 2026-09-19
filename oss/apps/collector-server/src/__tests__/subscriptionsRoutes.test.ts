import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import type { ResolvedApiKey } from "@uptimizr/db";
import { LIMITS, MASKED_SECRET_PLACEHOLDER } from "./support/subscriptionFixtures.js";
import { buildApp } from "../app.js";
import { createMemoryStore } from "../memoryStore.js";
import type { CollectorStore } from "../store.js";
import { mintLiveToken } from "../liveToken.js";
import { TEST_CONFIG } from "./support/registryRequests.js";

/**
 * The subscriptions API (#311): the capability split, the registry-aware
 * rejections, the per-project bound, and the firing log.
 *
 * Driven through `app.inject()` against the in-memory store, so the assertions
 * are about the route contract rather than about SQL.
 */

const KEYS: Record<string, ResolvedApiKey> = {
  "reader-key": {
    projectId: "p1",
    keyId: "k-query",
    capabilities: ["query"],
    label: null,
    rateLimit: null,
  },
  "agent-key": {
    projectId: "p1",
    keyId: "k-annotate",
    capabilities: ["query", "annotate"],
    label: null,
    rateLimit: null,
  },
};

function makeStore(): CollectorStore {
  const store = createMemoryStore({ projectId: "p1", apiKey: "agent-key" });
  return {
    ...store,
    resolveApiKey: async (key: string) => KEYS[key] ?? null,
  } as CollectorStore;
}

const declaration = {
  name: "FPS drop in lobby",
  metric: "perf_summary",
  filters: { scene: "lobby" },
  evaluate: { every: "5m", window: "1h" },
  predicate: { kind: "threshold", column: "p50_fps", op: "<", value: 30, minSample: 1 },
  cooldown: "1h",
  delivery: [{ kind: "sse" }],
};

let app: FastifyInstance | null = null;
afterEach(async () => {
  await app?.close();
  app = null;
});

async function boot(configOverrides: Record<string, unknown> = {}): Promise<FastifyInstance> {
  app = await buildApp({
    store: makeStore(),
    config: { ...TEST_CONFIG, ...configOverrides } as typeof TEST_CONFIG,
  });
  await app.ready();
  return app;
}

async function create(
  instance: FastifyInstance,
  payload: Record<string, unknown> = declaration,
): Promise<Record<string, unknown>> {
  const res = await instance.inject({
    method: "POST",
    url: "/api/v1/subscriptions",
    headers: { "x-api-key": "agent-key" },
    payload,
  });
  expect(res.statusCode, res.body).toBe(201);
  return res.json();
}

describe("subscriptions CRUD", () => {
  it("creates, lists, reads and deletes", async () => {
    const instance = await boot();
    const created = await create(instance);

    expect(created.id).toMatch(/^sub_/);
    expect(created.metric).toBe("perf_summary");
    expect(created.enabled).toBe(true);
    expect(created.createdAt).toMatch(/^\d{4}-/);

    const list = await instance.inject({
      url: "/api/v1/subscriptions",
      headers: { "x-api-key": "reader-key" },
    });
    expect(list.statusCode).toBe(200);
    expect(list.json()).toHaveLength(1);

    const one = await instance.inject({
      url: `/api/v1/subscriptions/${created.id as string}`,
      headers: { "x-api-key": "reader-key" },
    });
    expect(one.json().id).toBe(created.id);

    const gone = await instance.inject({
      method: "DELETE",
      url: `/api/v1/subscriptions/${created.id as string}`,
      headers: { "x-api-key": "agent-key" },
    });
    expect(gone.statusCode).toBe(204);

    const after = await instance.inject({
      url: `/api/v1/subscriptions/${created.id as string}`,
      headers: { "x-api-key": "reader-key" },
    });
    expect(after.statusCode).toBe(404);
  });

  it("patches only `enabled`", async () => {
    const instance = await boot();
    const created = await create(instance);

    const patched = await instance.inject({
      method: "PATCH",
      url: `/api/v1/subscriptions/${created.id as string}`,
      headers: { "x-api-key": "agent-key" },
      payload: { enabled: false },
    });
    expect(patched.statusCode).toBe(200);
    expect(patched.json().enabled).toBe(false);

    // Anything else is a validation error, not a silent partial update.
    const rejected = await instance.inject({
      method: "PATCH",
      url: `/api/v1/subscriptions/${created.id as string}`,
      headers: { "x-api-key": "agent-key" },
      payload: { metric: "event_counts" },
    });
    expect(rejected.statusCode).toBe(400);
  });

  it("never returns a webhook secret after creation", async () => {
    const instance = await boot({ webhookAllowedHosts: ["hooks.example"] });
    const created = await create(instance, {
      ...declaration,
      delivery: [{ kind: "webhook", url: "https://hooks.example/x", secret: "s".repeat(32) }],
    });

    const body = JSON.stringify(created);
    expect(body).not.toContain("ssssssss");
    expect(body).toContain(MASKED_SECRET_PLACEHOLDER);

    const list = await instance.inject({
      url: "/api/v1/subscriptions",
      headers: { "x-api-key": "reader-key" },
    });
    expect(JSON.stringify(list.json())).not.toContain("ssssssss");
  });
});

describe("capability gates", () => {
  it("requires a key at all", async () => {
    const instance = await boot();
    expect((await instance.inject({ url: "/api/v1/subscriptions" })).statusCode).toBe(401);
  });

  it("reads need `query`, writes need `annotate`", async () => {
    const instance = await boot();
    const created = await create(instance);

    // A plain reader can look…
    const read = await instance.inject({
      url: "/api/v1/subscriptions",
      headers: { "x-api-key": "reader-key" },
    });
    expect(read.statusCode).toBe(200);

    // …but cannot create, patch, delete or trigger an evaluation, because each
    // of those is a way to make the collector act.
    for (const [method, url, payload] of [
      ["POST", "/api/v1/subscriptions", declaration],
      ["PATCH", `/api/v1/subscriptions/${created.id as string}`, { enabled: false }],
      ["DELETE", `/api/v1/subscriptions/${created.id as string}`, undefined],
      ["POST", `/api/v1/subscriptions/${created.id as string}/test`, undefined],
    ] as const) {
      const res = await instance.inject({
        method,
        url,
        headers: { "x-api-key": "reader-key" },
        ...(payload ? { payload } : {}),
      });
      expect(res.statusCode, `${method} ${url}`).toBe(403);
      expect(res.json().error).toContain("metadata");
    }
  });
});

describe("validation", () => {
  it("rejects an unknown metric and names the ones that work", async () => {
    const instance = await boot();
    const res = await instance.inject({
      method: "POST",
      url: "/api/v1/subscriptions",
      headers: { "x-api-key": "agent-key" },
      payload: { ...declaration, metric: "not_a_metric" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain("unknown metric");
    expect(res.json().available).toContain("perf_summary");
  });

  it("rejects a threshold on a column that is not the metric's headline", async () => {
    const instance = await boot();
    const res = await instance.inject({
      method: "POST",
      url: "/api/v1/subscriptions",
      headers: { "x-api-key": "agent-key" },
      payload: {
        ...declaration,
        predicate: { kind: "threshold", column: "avg_fps", op: "<", value: 30 },
      },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().column).toBe("p50_fps");
  });

  it("rejects a window shorter than the finest bucket grain", async () => {
    const instance = await boot();
    const res = await instance.inject({
      method: "POST",
      url: "/api/v1/subscriptions",
      headers: { "x-api-key": "agent-key" },
      payload: { ...declaration, evaluate: { every: "5m", window: "15m" } },
    });
    expect(res.statusCode).toBe(400);
  });

  it("rejects an evaluation interval under a minute", async () => {
    const instance = await boot();
    const res = await instance.inject({
      method: "POST",
      url: "/api/v1/subscriptions",
      headers: { "x-api-key": "agent-key" },
      payload: { ...declaration, evaluate: { every: "10s", window: "1h" } },
    });
    expect(res.statusCode).toBe(400);
  });

  it("refuses a webhook host the operator has not allow-listed", async () => {
    const instance = await boot();
    const res = await instance.inject({
      method: "POST",
      url: "/api/v1/subscriptions",
      headers: { "x-api-key": "agent-key" },
      payload: {
        ...declaration,
        delivery: [{ kind: "webhook", url: "http://169.254.169.254/latest/meta-data" }],
      },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain("COLLECTOR_WEBHOOK_ALLOWED_HOSTS");
  });

  it("refuses a non-http(s) webhook scheme outright", async () => {
    const instance = await boot({ webhookAllowedHosts: ["*"] });
    const res = await instance.inject({
      method: "POST",
      url: "/api/v1/subscriptions",
      headers: { "x-api-key": "agent-key" },
      payload: { ...declaration, delivery: [{ kind: "webhook", url: "file:///etc/passwd" }] },
    });
    expect(res.statusCode).toBe(400);
  });

  it("bounds the number of subscriptions per project", async () => {
    const instance = await boot();
    for (let i = 0; i < LIMITS.maxSubscriptionsPerProject; i += 1) {
      await create(instance, { ...declaration, name: `sub ${i}` });
    }
    const res = await instance.inject({
      method: "POST",
      url: "/api/v1/subscriptions",
      headers: { "x-api-key": "agent-key" },
      payload: declaration,
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toContain(String(LIMITS.maxSubscriptionsPerProject));
  });
});

describe("test and firings", () => {
  it("evaluates on demand without delivering by default", async () => {
    const instance = await boot();
    const created = await create(instance);

    const res = await instance.inject({
      method: "POST",
      url: `/api/v1/subscriptions/${created.id as string}/test`,
      headers: { "x-api-key": "agent-key" },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toHaveProperty("fired");
    expect(body).toHaveProperty("reason");
    expect(body.delivered).toBe(false);
    expect(body.webhookConfigured).toBe(false);

    // Nothing was recorded, because nothing was delivered.
    const events = await instance.inject({
      url: `/api/v1/subscriptions/${created.id as string}/events`,
      headers: { "x-api-key": "reader-key" },
    });
    expect(events.json()).toEqual([]);
  });

  it("404s on a subscription from another project", async () => {
    const instance = await boot();
    const res = await instance.inject({
      method: "POST",
      url: "/api/v1/subscriptions/sub_nope/test",
      headers: { "x-api-key": "agent-key" },
    });
    expect(res.statusCode).toBe(404);
  });
});

describe("the SSE stream", () => {
  it("refuses a request without a live token", async () => {
    const instance = await boot();
    const res = await instance.inject({ url: "/api/v1/subscriptions/stream" });
    expect(res.statusCode).toBe(401);
  });

  it("refuses a tampered token", async () => {
    const instance = await boot();
    const { token } = mintLiveToken("p1", ["query"], "a-different-secret", 60_000);
    const res = await instance.inject({ url: `/api/v1/subscriptions/stream?token=${token}` });
    expect(res.statusCode).toBe(401);
  });

  it("refuses when the shared live connection budget is full", async () => {
    const instance = await boot({ liveMaxConnections: 0 });
    const { token } = mintLiveToken("p1", ["query"], TEST_CONFIG.liveTokenSecret, 60_000);
    const res = await instance.inject({ url: `/api/v1/subscriptions/stream?token=${token}` });
    expect(res.statusCode).toBe(503);
  });

  it("is not shadowed by the `/:id` route", async () => {
    const instance = await boot();
    // `stream` must reach the SSE handler (401 without a token), not the
    // per-subscription read (which would 401 on the missing api key instead and,
    // with a key, 404 on a subscription called "stream").
    const res = await instance.inject({
      url: "/api/v1/subscriptions/stream",
      headers: { "x-api-key": "reader-key" },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().error).toContain("live token");
  });
});
