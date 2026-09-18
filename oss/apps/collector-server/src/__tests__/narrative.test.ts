/**
 * `GET /api/v1/sessions/:id/narrative` — the route (#314, ADR 0051 §7).
 *
 * The compaction itself is unit-tested in `@uptimizr/db`
 * (`src/__tests__/narrative.test.ts`); what this suite owns is everything the
 * route adds on top of it:
 *
 * 1. the **double gate** — the full matrix of retention on/off × `query` /
 *    `query:raw`, plus the unauthenticated and unknown-key cases;
 * 2. the 404 for a session this project has no events for;
 * 3. parameter validation and the three formats (`full`, `table`, `text`);
 * 4. that a refusal is written to the audit log, which is what makes the gate
 *    observable to the project owner.
 *
 * The store is a fake: no DuckDB, no disk. What matters here is the guard and
 * the wiring, and both are visible through `app.inject()`.
 */

import { describe, expect, it } from "vitest";
import type { AgentAuditEntry, ResolvedApiKey } from "@uptimizr/db";
import { NARRATIVE_LIMITS, type SessionNarrativeEntry } from "@uptimizr/metrics";
import type { AnyEvent } from "@uptimizr/schema";
import { buildApp } from "../app.js";
import type { CollectorConfig } from "../config.js";
import type { CollectorStore } from "../store.js";

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
  livePresenceIntervalMs: 2_000,
  rateLimitMax: 1000,
  rateLimitWindowMs: 60_000,
  ingestRateLimitMax: 1000,
  ingestRateLimitWindowMs: 60_000,
  trustProxy: false,
  bodyLimit: 1_048_576,
  cspMode: "off",
  auditRetentionDays: 30,
  auditDashboardRequests: false,
};

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
};

const T0 = 1_760_000_000_000;

function ev(type: string, atMs: number, extra: Record<string, unknown> = {}): AnyEvent {
  return {
    type,
    projectId: "p1",
    sessionId: "s1",
    visitorId: "visitor-hash-do-not-leak",
    ts: T0 + atMs,
    sdkVersion: "1.0.0",
    sceneId: "lobby",
    url: "https://shop.example.com/cart",
    ...extra,
  } as unknown as AnyEvent;
}

/** A short session: a start, a dwell, two interactions, a dip and an end. */
const EVENTS: AnyEvent[] = [
  ev("session_start", 0, { device: { engine: "webgl2", renderer: "Apple M2 Pro" } }),
  ev("mesh_visibility", 500, { mesh: "statue", visibleMs: 2_400 }),
  ev("mesh_interaction", 1_000, { mesh: "buy", kind: "click", source: "mouse" }),
  ev("custom", 1_500, { name: "add_to_cart", props: { sku: "SKU-1" } }),
  ev("frame_perf", 2_000, { fps: 18 }),
  ev("frame_perf", 2_500, { fps: 20 }),
  ev("session_end", 3_000, { reason: "unload", durationMs: 3_000 }),
];

type FakeStore = CollectorStore & { audit: AgentAuditEntry[] };

function makeStore(events: readonly AnyEvent[] = EVENTS): FakeStore {
  const audit: AgentAuditEntry[] = [];
  return {
    audit,
    resolveApiKey: async (key: string) => KEYS[key] ?? null,
    projectExists: async (id: string) => id === "p1",
    insertEvents: async () => {},
    getSessionEvents: async () => [...events],
    streamSessionEvents: async function* (_projectId: string, sessionId: string) {
      if (sessionId !== "s1") return;
      for (const event of events) yield event;
    },
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
    listAudit: async () => audit,
    pruneAudit: async () => {},
  } as unknown as FakeStore;
}

/** Boot the app with retention on or off and run one GET against it. */
async function get(
  url: string,
  key: string | undefined,
  retention: boolean,
  store: FakeStore = makeStore(),
) {
  const app = await buildApp({
    store,
    config: { ...baseConfig, enableRawSessionRetention: retention },
  });
  try {
    return await app.inject({
      method: "GET",
      url,
      headers: key ? { "x-api-key": key } : {},
    });
  } finally {
    await app.close();
  }
}

const NARRATIVE = "/api/v1/sessions/s1/narrative";

describe("GET /api/v1/sessions/:id/narrative — the gate matrix", () => {
  it("serves the narrative only with retention on AND query:raw", async () => {
    const res = await get(NARRATIVE, "raw-key", true);
    expect(res.statusCode).toBe(200);
    expect((res.json() as SessionNarrativeEntry[]).length).toBeGreaterThan(0);
  });

  it("refuses a query:raw key when retention is off", async () => {
    const res = await get(NARRATIVE, "raw-key", false);
    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ error: "raw session retention is disabled" });
  });

  it("refuses a query-only key when retention is on", async () => {
    const res = await get(NARRATIVE, "query-key", true);
    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ error: "api key not permitted to read raw session data" });
  });

  it("refuses a query-only key when retention is off, naming retention first", async () => {
    // The retention check runs before the capability check, exactly as it does
    // on `/events`, so the two surfaces cannot be used to probe one another.
    const res = await get(NARRATIVE, "query-key", false);
    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ error: "raw session retention is disabled" });
  });

  it("requires a key at all, and rejects an unknown one", async () => {
    expect((await get(NARRATIVE, undefined, true)).statusCode).toBe(401);
    expect((await get(NARRATIVE, "utk_not_a_key", true)).statusCode).toBe(401);
  });

  it("matches the raw event stream's gate exactly", async () => {
    // The two raw surfaces must be indistinguishable to a caller probing them.
    const events = "/api/v1/sessions/s1/events";
    for (const [key, retention] of [
      ["query-key", true],
      ["raw-key", false],
      ["query-key", false],
    ] as const) {
      const narrative = await get(NARRATIVE, key, retention);
      const stream = await get(events, key, retention);
      expect(narrative.statusCode, `${key}/${retention}`).toBe(stream.statusCode);
      expect(narrative.json(), `${key}/${retention}`).toEqual(stream.json());
    }
  });
});

describe("GET /api/v1/sessions/:id/narrative — behaviour", () => {
  it("404s a session the project has no events for", async () => {
    const res = await get("/api/v1/sessions/nope/narrative", "raw-key", true);
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: "session not found" });
  });

  it("returns ordered entries ending in the summary", async () => {
    const res = await get(NARRATIVE, "raw-key", true);
    const entries = res.json() as SessionNarrativeEntry[];
    expect(entries.map((entry) => entry.tMs)).toEqual(
      [...entries.map((entry) => entry.tMs)].sort((a, b) => a - b),
    );
    const last = entries.at(-1)!;
    expect(last.kind).toBe("summary");
    expect(last.totals).toMatchObject({ events: EVENTS.length, durationMs: 3_000, dips: 1 });
    expect(last.truncated).toBe(false);
  });

  it("honours minDwellMs, fpsThreshold and maxEntries", async () => {
    const strict = await get(`${NARRATIVE}?minDwellMs=10000&fpsThreshold=10`, "raw-key", true);
    const entries = strict.json() as SessionNarrativeEntry[];
    expect(entries.some((entry) => entry.kind === "dwell")).toBe(false);
    expect(entries.some((entry) => entry.kind === "perf_dip")).toBe(false);

    const bounded = await get(`${NARRATIVE}?maxEntries=2`, "raw-key", true);
    const boundedEntries = bounded.json() as SessionNarrativeEntry[];
    expect(boundedEntries).toHaveLength(2);
    expect(boundedEntries.at(-1)!.truncated).toBe(true);
  });

  it("rejects a parameter outside the registry bounds", async () => {
    const tooMany = await get(
      `${NARRATIVE}?maxEntries=${NARRATIVE_LIMITS.maxMaxEntries + 1}`,
      "raw-key",
      true,
    );
    expect(tooMany.statusCode).toBe(400);
    expect((await get(`${NARRATIVE}?minDwellMs=-1`, "raw-key", true)).statusCode).toBe(400);
    expect((await get(`${NARRATIVE}?format=summary`, "raw-key", true)).statusCode).toBe(400);
  });

  it("wraps the entries in the shared table envelope on format=table", async () => {
    const res = await get(`${NARRATIVE}?format=table&maxEntries=50`, "raw-key", true);
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      meta: { metric: string; rows: number; truncated: boolean; limits: { maxRows: number } };
      rows: SessionNarrativeEntry[];
    };
    expect(body.meta.metric).toBe("session_narrative");
    expect(body.meta.rows).toBe(body.rows.length);
    expect(body.meta.truncated).toBe(false);
    expect(body.meta.limits.maxRows).toBe(NARRATIVE_LIMITS.maxMaxEntries);
    expect(body.rows.at(-1)!.kind).toBe("summary");
  });

  it("renders one line per entry on format=text", async () => {
    const res = await get(`${NARRATIVE}?format=text`, "raw-key", true);
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/plain");
    const lines = res.body.trimEnd().split("\n");
    const entries = (await get(NARRATIVE, "raw-key", true)).json() as SessionNarrativeEntry[];
    expect(lines).toHaveLength(entries.length + 1);
    expect(lines[0]).toContain("session s1");
    expect(lines.length).toBeLessThan(200);
  });

  it("leaks nothing the compaction excludes, in any format", async () => {
    for (const format of ["full", "table", "text"]) {
      const res = await get(`${NARRATIVE}?format=${format}`, "raw-key", true);
      for (const secret of [
        "visitor-hash-do-not-leak",
        "shop.example.com",
        "Apple M2 Pro",
        "SKU-1",
      ]) {
        expect(res.body, `${format} leaked ${secret}`).not.toContain(secret);
      }
    }
  });
});

describe("GET /api/v1/sessions/:id/narrative — audit", () => {
  it("records the read and the refusal under the route pattern", async () => {
    const store = makeStore();
    await get(NARRATIVE, "raw-key", true, store);
    await get(NARRATIVE, "query-key", true, store);
    // The audit write is fire-and-forget; give the microtask queue a turn.
    await new Promise((resolve) => setTimeout(resolve, 10));

    const rows = store.audit.filter((row) => row.toolOrPath === "/api/v1/sessions/:id/narrative");
    expect(rows.map((row) => row.status).sort()).toEqual([200, 403]);
    expect(rows.map((row) => row.keyId).sort()).toEqual(["k-query", "k-raw"]);
    // No key material anywhere in the trail.
    expect(JSON.stringify(rows)).not.toContain("raw-key");
  });
});
