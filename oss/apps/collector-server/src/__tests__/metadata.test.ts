import { describe, expect, it } from "vitest";
import type { ResolvedApiKey } from "@uptimizr/db";
import { buildApp } from "../app.js";
import type { CollectorConfig } from "../config.js";
import { createMemoryStore } from "../memoryStore.js";
import type { CollectorStore } from "../store.js";

/**
 * The metadata write path (#310, ADR 0051 §5): annotations, glossary and saved
 * analyses over HTTP.
 *
 * What these tests hold the implementation to:
 *
 * - writes need `annotate`, reads need `query` — and a read-only key is refused
 *   with 403, not quietly ignored;
 * - payloads are bounded at the edge by the `@uptimizr/schema` contracts;
 * - authorship is decided by the collector from the calling client, never by the
 *   payload;
 * - every write lands in the agent audit log;
 * - and nothing on this path inserts an event.
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

/** A writer key and a read-only key, both on the same project. */
const KEYS: Record<string, ResolvedApiKey> = {
  "annotate-key": {
    projectId: "p1",
    keyId: "k-annotate",
    capabilities: ["query", "annotate"],
    label: "weekly-report-agent",
    rateLimit: null,
  },
  "query-key": {
    projectId: "p1",
    keyId: "k-query",
    capabilities: ["query"],
    label: null,
    rateLimit: null,
  },
};

/**
 * The in-memory store (a real `CollectorStore` implementation, caps and all)
 * with a two-key resolver bolted on, so the capability split can be exercised.
 */
function makeStore(): CollectorStore {
  const base = createMemoryStore({
    projectId: "p1",
    apiKey: "annotate-key",
    capabilities: ["query", "annotate"],
    keyId: "k-annotate",
  });
  return { ...base, resolveApiKey: async (key: string) => KEYS[key] ?? null };
}

const writer = { "x-api-key": "annotate-key" };
const reader = { "x-api-key": "query-key" };
/** What the dashboard's own session sends — a *person* wrote the row. */
const dashboard = { "x-api-key": "annotate-key", "x-uptimizr-client": "dashboard" };

async function makeApp() {
  return buildApp({ store: makeStore(), config });
}

describe("annotations", () => {
  it("creates, lists and deletes a note", async () => {
    const app = await makeApp();

    const created = await app.inject({
      method: "POST",
      url: "/api/v1/annotations",
      headers: writer,
      payload: { targetKind: "mesh", targetId: "counter", text: "dead clicks after the rebuild" },
    });
    expect(created.statusCode).toBe(201);
    const row = created.json();
    expect(row).toMatchObject({
      projectId: "p1",
      targetKind: "mesh",
      targetId: "counter",
      text: "dead clicks after the rebuild",
      authorKeyId: "k-annotate",
    });
    expect(typeof row.id).toBe("string");

    const listed = await app.inject({ method: "GET", url: "/api/v1/annotations", headers: reader });
    expect(listed.statusCode).toBe(200);
    expect(listed.json()).toHaveLength(1);

    const deleted = await app.inject({
      method: "DELETE",
      url: `/api/v1/annotations/${row.id}`,
      headers: writer,
    });
    expect(deleted.statusCode).toBe(204);

    const after = await app.inject({ method: "GET", url: "/api/v1/annotations", headers: reader });
    expect(after.json()).toEqual([]);
  });

  it("filters by target and by overlapping window", async () => {
    const app = await makeApp();
    const post = (payload: unknown) =>
      app.inject({ method: "POST", url: "/api/v1/annotations", headers: writer, payload });

    await post({ targetKind: "project", text: "standing" });
    await post({ targetKind: "window", since: 1_000, until: 2_000, text: "early" });
    await post({ targetKind: "scene", targetId: "lobby", text: "about the lobby" });

    const byTarget = await app.inject({
      method: "GET",
      url: "/api/v1/annotations?targetKind=scene&targetId=lobby",
      headers: reader,
    });
    expect(byTarget.json().map((a: { text: string }) => a.text)).toEqual(["about the lobby"]);

    const window = await app.inject({
      method: "GET",
      url: "/api/v1/annotations?since=1500&until=5000",
      headers: reader,
    });
    expect(
      window
        .json()
        .map((a: { text: string }) => a.text)
        .sort(),
    ).toEqual(["about the lobby", "early", "standing"]);
  });

  it("refuses a write from a key without `annotate` but still allows the read", async () => {
    const app = await makeApp();
    const refused = await app.inject({
      method: "POST",
      url: "/api/v1/annotations",
      headers: reader,
      payload: { targetKind: "project", text: "not allowed" },
    });
    expect(refused.statusCode).toBe(403);
    expect(refused.json().error).toMatch(/not permitted to write metadata/);

    const read = await app.inject({ method: "GET", url: "/api/v1/annotations", headers: reader });
    expect(read.statusCode).toBe(200);
  });

  it("requires a key at all", async () => {
    const app = await makeApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/annotations",
      payload: { targetKind: "project", text: "anonymous" },
    });
    expect(res.statusCode).toBe(401);
  });

  it("rejects payloads the schema bounds", async () => {
    const app = await makeApp();
    const cases: unknown[] = [
      { targetKind: "mesh", text: "no target id" },
      { targetKind: "project", text: "" },
      { targetKind: "project", text: "x".repeat(2001) },
      { targetKind: "window", since: 5, until: 1, text: "inverted" },
      { targetKind: "session", text: "unknown kind" },
    ];
    for (const payload of cases) {
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/annotations",
        headers: writer,
        payload,
      });
      expect(res.statusCode, JSON.stringify(payload)).toBe(400);
    }
  });

  it("answers 404 for an unknown id", async () => {
    const app = await makeApp();
    const res = await app.inject({
      method: "DELETE",
      url: "/api/v1/annotations/nope",
      headers: writer,
    });
    expect(res.statusCode).toBe(404);
  });

  it("attributes the row from the calling client, not the payload", async () => {
    const app = await makeApp();

    const byAgent = await app.inject({
      method: "POST",
      url: "/api/v1/annotations",
      headers: writer,
      payload: { targetKind: "project", text: "from an agent", authorKind: "user" },
    });
    expect(byAgent.json().authorKind).toBe("agent");

    const byPerson = await app.inject({
      method: "POST",
      url: "/api/v1/annotations",
      headers: dashboard,
      payload: { targetKind: "project", text: "from the dashboard" },
    });
    expect(byPerson.json().authorKind).toBe("user");
  });
});

describe("glossary", () => {
  it("upserts by term, lists and deletes", async () => {
    const app = await makeApp();

    const first = await app.inject({
      method: "PUT",
      url: "/api/v1/glossary/TTFR",
      headers: writer,
      payload: { meaning: "time to first render" },
    });
    expect(first.statusCode).toBe(200);

    const second = await app.inject({
      method: "PUT",
      url: "/api/v1/glossary/TTFR",
      headers: writer,
      payload: { meaning: "time to first rendered frame" },
    });
    expect(second.json().meaning).toBe("time to first rendered frame");

    const listed = await app.inject({ method: "GET", url: "/api/v1/glossary", headers: reader });
    expect(listed.json()).toHaveLength(1);

    const deleted = await app.inject({
      method: "DELETE",
      url: "/api/v1/glossary/TTFR",
      headers: writer,
    });
    expect(deleted.statusCode).toBe(204);
    expect(
      (await app.inject({ method: "DELETE", url: "/api/v1/glossary/TTFR", headers: writer }))
        .statusCode,
    ).toBe(404);
  });

  it("accepts a multi-word term and bounds the meaning", async () => {
    const app = await makeApp();
    const ok = await app.inject({
      method: "PUT",
      url: `/api/v1/glossary/${encodeURIComponent("checkout counter")}`,
      headers: writer,
      payload: { meaning: "the till cluster by the exit" },
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().term).toBe("checkout counter");

    const tooLong = await app.inject({
      method: "PUT",
      url: "/api/v1/glossary/term",
      headers: writer,
      payload: { meaning: "x".repeat(501) },
    });
    expect(tooLong.statusCode).toBe(400);
  });

  it("refuses a definition from a read-only key", async () => {
    const app = await makeApp();
    const res = await app.inject({
      method: "PUT",
      url: "/api/v1/glossary/TTFR",
      headers: reader,
      payload: { meaning: "nope" },
    });
    expect(res.statusCode).toBe(403);
  });
});

describe("saved analyses", () => {
  it("creates, lists and deletes an analysis", async () => {
    const app = await makeApp();
    const created = await app.inject({
      method: "POST",
      url: "/api/v1/analyses",
      headers: writer,
      payload: {
        title: "Lobby FPS after the lighting change",
        query: { metric: "perf_summary", scene: "lobby" },
        conclusion: "p50 fell from 58 to 41 on integrated GPUs.",
      },
    });
    expect(created.statusCode).toBe(201);
    const row = created.json();
    expect(row.query).toEqual({ metric: "perf_summary", scene: "lobby" });

    const listed = await app.inject({ method: "GET", url: "/api/v1/analyses", headers: reader });
    expect(listed.json()).toHaveLength(1);

    expect(
      (await app.inject({ method: "DELETE", url: `/api/v1/analyses/${row.id}`, headers: writer }))
        .statusCode,
    ).toBe(204);
  });

  it("rejects an over-long query document and a non-object query", async () => {
    const app = await makeApp();
    for (const query of [{ blob: "x".repeat(8001) }, "select *", []]) {
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/analyses",
        headers: writer,
        payload: { title: "t", query },
      });
      expect(res.statusCode).toBe(400);
    }
  });

  it("refuses a save from a read-only key", async () => {
    const app = await makeApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/analyses",
      headers: reader,
      payload: { title: "t", query: {} },
    });
    expect(res.statusCode).toBe(403);
  });
});

describe("every metadata write is audited", () => {
  it("records one audit row per write, with the route pattern and the key id", async () => {
    const app = await makeApp();

    await app.inject({
      method: "POST",
      url: "/api/v1/annotations",
      headers: writer,
      payload: { targetKind: "project", text: "audited" },
    });
    await app.inject({
      method: "PUT",
      url: "/api/v1/glossary/TTFR",
      headers: writer,
      payload: { meaning: "time to first render" },
    });
    await app.inject({
      method: "POST",
      url: "/api/v1/analyses",
      headers: writer,
      payload: { title: "audited", query: {} },
    });

    const audit = await app.inject({ method: "GET", url: "/api/v1/audit", headers: reader });
    const paths = audit.json().map((row: { toolOrPath: string }) => row.toolOrPath);
    expect(paths).toContain("/api/v1/annotations");
    expect(paths).toContain("/api/v1/glossary/:term");
    expect(paths).toContain("/api/v1/analyses");

    const writes = audit
      .json()
      .filter((row: { toolOrPath: string }) => row.toolOrPath !== "/api/v1/audit");
    for (const row of writes) {
      expect(row.keyId).toBe("k-annotate");
      expect(row.projectId).toBe("p1");
    }
  });
});

describe("metadata never becomes an event", () => {
  it("leaves the event surface untouched after writes on all three tables", async () => {
    const store = makeStore();
    let inserted = 0;
    const app = await buildApp({
      store: {
        ...store,
        insertEvents: async (events) => {
          inserted += events.length;
        },
      },
      config,
    });

    await app.inject({
      method: "POST",
      url: "/api/v1/annotations",
      headers: writer,
      payload: { targetKind: "project", text: "not an event" },
    });
    await app.inject({
      method: "PUT",
      url: "/api/v1/glossary/TTFR",
      headers: writer,
      payload: { meaning: "not an event" },
    });
    await app.inject({
      method: "POST",
      url: "/api/v1/analyses",
      headers: writer,
      payload: { title: "not an event", query: {} },
    });

    expect(inserted).toBe(0);
    const sessions = await app.inject({
      method: "GET",
      url: "/api/v1/sessions",
      headers: reader,
    });
    expect(sessions.json()).toEqual([]);
  });
});

describe("OpenAPI describes the metadata group", () => {
  it("lists the six paths, their capabilities and the row schemas", async () => {
    const app = await makeApp();
    const res = await app.inject({ method: "GET", url: "/api/v1/openapi.json" });
    const doc = res.json();

    for (const path of [
      "/api/v1/annotations",
      "/api/v1/annotations/{id}",
      "/api/v1/glossary",
      "/api/v1/glossary/{term}",
      "/api/v1/analyses",
      "/api/v1/analyses/{id}",
    ]) {
      expect(doc.paths[path], path).toBeDefined();
    }
    expect(doc.paths["/api/v1/annotations"].post.description).toMatch(/annotate/);
    expect(doc.components.schemas.Annotation).toBeDefined();
    expect(doc.components.schemas.GlossaryEntry).toBeDefined();
    expect(doc.components.schemas.SavedAnalysis).toBeDefined();
    expect(doc.components.responses.Conflict).toBeDefined();
    // The read API's promise is unchanged; the metadata group is one of the two
    // exceptions the document now names (the other is `session_narrative`).
    expect(doc.info.description).toMatch(/read-only/);
    expect(doc.info.description).toMatch(/aggregate-only/);
    expect(doc.info.description).toMatch(/metadata/);
  });
});
