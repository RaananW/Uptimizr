import { describe, expect, it } from "vitest";
import type { AgentAuditEntry, ResolvedApiKey } from "@uptimizr/db";
import { buildApp } from "../app.js";
import { requireCapability } from "../auth.js";
import type { CollectorConfig } from "../config.js";
import type { CollectorStore } from "../store.js";

/**
 * Agent-scoped API keys (#309, ADR 0051 §7): `whoami`, the capability helper
 * that guards the (not-yet-built) metadata write path, per-key rate limits, and
 * the agent audit log — its contents, its privacy guarantees, its read endpoint
 * and its retention sweep.
 */

const config: CollectorConfig = {
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
  livePresenceIntervalMs: 2_000,
  rateLimitMax: 1000,
  rateLimitWindowMs: 60_000,
  ingestRateLimitMax: 1000,
  ingestRateLimitWindowMs: 60_000,
  trustProxy: false,
  bodyLimit: 1_048_576,
  cspMode: "strict",
  auditRetentionDays: 30,
  auditDashboardRequests: false,
};

/**
 * Keys the fake store resolves: a plain reader, a raw-capable agent, a metadata
 * writer, a key carrying its own request budget, and an ingest-only key.
 */
const KEYS: Record<string, ResolvedApiKey> = {
  "query-key": {
    projectId: "p1",
    keyId: "k-query",
    capabilities: ["query"],
    label: null,
    rateLimit: null,
  },
  "raw-key": {
    projectId: "p1",
    keyId: "k-raw",
    capabilities: ["query", "query:raw"],
    label: "replay-agent",
    rateLimit: null,
  },
  "annotate-key": {
    projectId: "p1",
    keyId: "k-annotate",
    capabilities: ["query", "annotate"],
    label: "weekly-report-agent",
    rateLimit: null,
  },
  "limited-key": {
    projectId: "p1",
    keyId: "k-limited",
    capabilities: ["query"],
    label: "throttled-agent",
    rateLimit: { max: 2, windowMs: 60_000 },
  },
  "ingest-key": {
    projectId: "p1",
    keyId: "k-ingest",
    capabilities: ["ingest"],
    label: null,
    rateLimit: null,
  },
};

type FakeStore = CollectorStore & { audit: AgentAuditEntry[] };

function makeStore(overrides: Partial<CollectorStore> = {}): FakeStore {
  const audit: AgentAuditEntry[] = [];
  return {
    audit,
    resolveApiKey: async (key: string) => KEYS[key] ?? null,
    projectExists: async (id: string) => id === "p1",
    insertEvents: async () => {},
    listSessions: async () => [
      {
        session_id: "s1",
        visitor_id: "v1",
        events: 3,
        started_at: "2026-01-01 10:00:00.000",
        ended_at: "2026-01-01 10:05:00.000",
      },
    ],
    getSessionEvents: async () => [],
    streamSessionEvents: async function* () {},
    recordAudit: async (entry) => {
      audit.push({
        id: `a${audit.length}`,
        projectId: entry.projectId,
        keyId: entry.keyId,
        at: entry.at ?? new Date(),
        surface: entry.surface,
        toolOrPath: entry.toolOrPath,
        params: entry.params,
        rowCount: entry.rowCount ?? null,
        durationMs: entry.durationMs,
        status: entry.status,
      });
    },
    listAudit: async (projectId, opts = {}) =>
      audit
        .filter((row) => row.projectId === projectId)
        .slice()
        .reverse()
        .slice(0, opts.limit ?? 100),
    pruneAudit: async (cutoffMs: number) => {
      for (let i = audit.length - 1; i >= 0; i -= 1) {
        if (audit[i]!.at.getTime() < cutoffMs) audit.splice(i, 1);
      }
    },
    ...overrides,
  } as unknown as FakeStore;
}

describe("GET /api/v1/whoami", () => {
  it("reports the key's project, id, capabilities and effective rate limit", async () => {
    const app = await buildApp({ store: makeStore(), config });
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/whoami",
      headers: { "x-api-key": "raw-key" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      projectId: "p1",
      keyId: "k-raw",
      capabilities: ["query", "query:raw"],
      label: "replay-agent",
      rateLimit: { max: config.rateLimitMax, windowMs: config.rateLimitWindowMs },
      rateLimitSource: "default",
    });
    await app.close();
  });

  it("reports a per-key budget as the key's own", async () => {
    const app = await buildApp({ store: makeStore(), config });
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/whoami",
      headers: { "x-api-key": "limited-key" },
    });
    expect(res.json()).toMatchObject({
      keyId: "k-limited",
      rateLimit: { max: 2, windowMs: 60_000 },
      rateLimitSource: "key",
    });
    await app.close();
  });

  it("never echoes the API key back", async () => {
    const app = await buildApp({ store: makeStore(), config });
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/whoami",
      headers: { "x-api-key": "query-key" },
    });
    expect(res.body).not.toContain("query-key");
    await app.close();
  });

  it("requires a key and refuses an ingest-only key", async () => {
    const app = await buildApp({ store: makeStore(), config });
    expect((await app.inject({ method: "GET", url: "/api/v1/whoami" })).statusCode).toBe(401);
    const forbidden = await app.inject({
      method: "GET",
      url: "/api/v1/whoami",
      headers: { "x-api-key": "ingest-key" },
    });
    expect(forbidden.statusCode).toBe(403);
    await app.close();
  });
});

describe("requireCapability (the `annotate` guard #310 will use)", () => {
  it("refuses a query-only key, admits an annotate key, 401s an anonymous one", async () => {
    const store = makeStore();
    const app = await buildApp({ store, config });
    app.get("/test/annotate", async (req, reply) => {
      const resolved = await requireCapability(req, reply, store, "annotate");
      if (!resolved) return reply;
      return { ok: true, keyId: resolved.keyId };
    });
    await app.ready();

    const refused = await app.inject({
      method: "GET",
      url: "/test/annotate",
      headers: { "x-api-key": "query-key" },
    });
    expect(refused.statusCode).toBe(403);
    expect(refused.json()).toEqual({ error: "api key not permitted to write metadata" });

    const allowed = await app.inject({
      method: "GET",
      url: "/test/annotate",
      headers: { "x-api-key": "annotate-key" },
    });
    expect(allowed.statusCode).toBe(200);
    expect(allowed.json()).toEqual({ ok: true, keyId: "k-annotate" });

    expect((await app.inject({ method: "GET", url: "/test/annotate" })).statusCode).toBe(401);
    await app.close();
  });
});

describe("per-key rate limits", () => {
  it("throttles a key with its own budget", async () => {
    const app = await buildApp({ store: makeStore(), config });
    const call = (key: string) =>
      app.inject({ method: "GET", url: "/api/v1/whoami", headers: { "x-api-key": key } });

    expect((await call("limited-key")).statusCode).toBe(200);
    expect((await call("limited-key")).statusCode).toBe(200);
    expect((await call("limited-key")).statusCode).toBe(429);
    await app.close();
  });

  it("buckets per key id, so one throttled key does not affect another", async () => {
    const app = await buildApp({ store: makeStore(), config });
    const call = (key: string) =>
      app.inject({ method: "GET", url: "/api/v1/whoami", headers: { "x-api-key": key } });
    await call("limited-key");
    await call("limited-key");
    expect((await call("limited-key")).statusCode).toBe(429);
    // A key with no budget of its own keeps the generous global limit.
    expect((await call("raw-key")).statusCode).toBe(200);
    expect((await call("query-key")).statusCode).toBe(200);
    await app.close();
  });
});

describe("agent audit log", () => {
  it("records an authenticated read with its route, params, rows and status", async () => {
    const store = makeStore();
    const app = await buildApp({ store, config });
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/sessions?limit=5",
      headers: { "x-api-key": "raw-key" },
    });
    expect(res.statusCode).toBe(200);
    await app.close();

    expect(store.audit).toHaveLength(1);
    expect(store.audit[0]).toMatchObject({
      projectId: "p1",
      keyId: "k-raw",
      surface: "http",
      toolOrPath: "/api/v1/sessions",
      params: '{"limit":5}',
      rowCount: 1,
      status: 200,
    });
    expect(store.audit[0]!.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("never writes key material into the row", async () => {
    const store = makeStore();
    const app = await buildApp({ store, config });
    await app.inject({
      method: "GET",
      // A credential smuggled into the querystring must not be persisted.
      url: "/api/v1/sessions?limit=1&token=super-secret",
      headers: { "x-api-key": "raw-key" },
    });
    await app.close();
    const serialized = JSON.stringify(store.audit);
    expect(serialized).not.toContain("super-secret");
    expect(serialized).not.toContain("raw-key");
    // The key's *id* is the subject, and that is exactly what should be there.
    expect(serialized).toContain("k-raw");
  });

  it("records refusals too — a 403 is precisely what an owner wants to see", async () => {
    const store = makeStore();
    const app = await buildApp({
      store,
      config: { ...config, enableRawSessionRetention: true },
    });
    await app.inject({
      method: "GET",
      url: "/api/v1/sessions/s1/events",
      headers: { "x-api-key": "query-key" },
    });
    await app.close();
    expect(store.audit[0]).toMatchObject({
      toolOrPath: "/api/v1/sessions/:id/events",
      status: 403,
      keyId: "k-query",
    });
  });

  it("skips the dashboard's own session unless configured otherwise", async () => {
    const store = makeStore();
    const app = await buildApp({ store, config });
    await app.inject({
      method: "GET",
      url: "/api/v1/sessions",
      headers: { "x-api-key": "raw-key", "x-uptimizr-client": "dashboard" },
    });
    expect(store.audit).toHaveLength(0);

    // An agent client identifying itself differently is recorded.
    await app.inject({
      method: "GET",
      url: "/api/v1/sessions",
      headers: { "x-api-key": "raw-key", "x-uptimizr-client": "assistant" },
    });
    expect(store.audit).toHaveLength(1);
    await app.close();

    const auditAll = makeStore();
    const strict = await buildApp({
      store: auditAll,
      config: { ...config, auditDashboardRequests: true },
    });
    await strict.inject({
      method: "GET",
      url: "/api/v1/sessions",
      headers: { "x-api-key": "raw-key", "x-uptimizr-client": "dashboard" },
    });
    expect(auditAll.audit).toHaveLength(1);
    await strict.close();
  });

  it("records nothing for keyless ingest", async () => {
    const store = makeStore();
    const app = await buildApp({ store, config });
    await app.inject({
      method: "POST",
      url: "/api/v1/collect",
      payload: {
        events: [
          { type: "session_start", projectId: "p1", sessionId: "s1", ts: 1, sdkVersion: "0.1.0" },
        ],
      },
    });
    await app.close();
    expect(store.audit).toHaveLength(0);
  });

  it("never fails a request when the audit write rejects", async () => {
    const store = makeStore({
      recordAudit: () => Promise.reject(new Error("audit table is gone")),
    });
    const app = await buildApp({ store, config });
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/sessions",
      headers: { "x-api-key": "raw-key" },
    });
    expect(res.statusCode).toBe(200);
    await app.close();
  });

  it("never fails a request when the audit write throws synchronously", async () => {
    const store = makeStore({
      recordAudit: () => {
        throw new Error("store exploded");
      },
    });
    const app = await buildApp({ store, config });
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/sessions",
      headers: { "x-api-key": "raw-key" },
    });
    expect(res.statusCode).toBe(200);
    await app.close();
  });

  it("serves the trail to a query key and refuses an ingest key", async () => {
    const store = makeStore();
    const app = await buildApp({ store, config });
    await app.inject({
      method: "GET",
      url: "/api/v1/sessions",
      headers: { "x-api-key": "raw-key" },
    });
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/audit?limit=10",
      headers: { "x-api-key": "query-key" },
    });
    expect(res.statusCode).toBe(200);
    const rows = res.json() as { toolOrPath: string; at: string; keyId: string }[];
    expect(rows[0]).toMatchObject({ toolOrPath: "/api/v1/sessions", keyId: "k-raw" });
    expect(new Date(rows[0]!.at).getTime()).toBeGreaterThan(0);

    const forbidden = await app.inject({
      method: "GET",
      url: "/api/v1/audit",
      headers: { "x-api-key": "ingest-key" },
    });
    expect(forbidden.statusCode).toBe(403);
    await app.close();
  });

  it("prunes rows past the retention window on boot", async () => {
    const store = makeStore();
    await store.recordAudit({
      projectId: "p1",
      keyId: "k-raw",
      surface: "http",
      toolOrPath: "/api/v1/sessions",
      params: "{}",
      durationMs: 1,
      status: 200,
      at: new Date(Date.now() - 40 * 24 * 60 * 60 * 1000),
    });
    expect(store.audit).toHaveLength(1);
    const app = await buildApp({ store, config: { ...config, auditRetentionDays: 30 } });
    expect(store.audit).toHaveLength(0);
    await app.close();
  });

  it("keeps rows indefinitely when retention is disabled", async () => {
    const store = makeStore();
    await store.recordAudit({
      projectId: "p1",
      keyId: "k-raw",
      surface: "http",
      toolOrPath: "/api/v1/sessions",
      params: "{}",
      durationMs: 1,
      status: 200,
      at: new Date(0),
    });
    const app = await buildApp({ store, config: { ...config, auditRetentionDays: 0 } });
    expect(store.audit).toHaveLength(1);
    await app.close();
  });
});
