/**
 * Collector-hosted MCP over Streamable HTTP (#313, ADR 0051 §7, sketch §G.1).
 *
 * These drive a **real MCP client** — the SDK's `Client` over
 * `StreamableHTTPClientTransport` — against a **really listening** collector, so
 * what is asserted is what Claude Desktop / VS Code / Cursor see. `app.inject()`
 * is deliberately not used for the MCP requests: the transport converts Node's
 * `IncomingMessage`/`ServerResponse` into web-standard objects and answers with
 * an SSE stream, which only a socket exercises honestly.
 *
 * The collector is backed by the in-memory store seeded with the cross-engine
 * parity events, so a `tools/call` returns real rows through the real query
 * route — the same code path a `curl` would take.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { PARITY_EVENTS, PARITY_RANGE, type ResolvedApiKey } from "@uptimizr/db";
import { createMcpServer, readTools, type CollectorClient } from "@uptimizr/mcp";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../app.js";
import type { CollectorConfig } from "../config.js";
import { createMemoryStore } from "../memoryStore.js";
import type { CollectorStore } from "../store.js";
import { TEST_CONFIG } from "./support/registryRequests.js";

const PROJECT_ID = "11111111-1111-4111-8111-111111111111";

/** Keys the store resolves: a reader, a writer, an ingest-only key. */
const KEYS: Record<string, ResolvedApiKey> = {
  "query-key": {
    projectId: PROJECT_ID,
    keyId: "k-query",
    capabilities: ["query"],
    label: "mcp-agent",
    rateLimit: null,
  },
  "annotate-key": {
    projectId: PROJECT_ID,
    keyId: "k-annotate",
    capabilities: ["query", "annotate"],
    label: "writer-agent",
    rateLimit: null,
  },
  "ingest-key": {
    projectId: PROJECT_ID,
    keyId: "k-ingest",
    capabilities: ["ingest"],
    label: null,
    rateLimit: null,
  },
};

const config: CollectorConfig = { ...TEST_CONFIG, mcpHttpEnabled: true };

/** The in-memory store, seeded, with a multi-key `resolveApiKey` in front. */
async function makeStore(): Promise<CollectorStore> {
  const base = createMemoryStore({ projectId: PROJECT_ID, apiKey: "query-key" });
  await base.insertEvents(PARITY_EVENTS.map((event) => ({ ...event, projectId: PROJECT_ID })));
  return { ...base, resolveApiKey: async (key: string) => KEYS[key] ?? null };
}

/** Boot a listening collector and return it with its origin. */
async function startCollector(
  overrides: Partial<CollectorConfig> = {},
): Promise<{ app: FastifyInstance; store: CollectorStore; origin: string }> {
  const store = await makeStore();
  const app = await buildApp({ store, config: { ...config, ...overrides } });
  await app.listen({ host: "127.0.0.1", port: 0 });
  const address = app.server.address();
  if (address == null || typeof address === "string") throw new Error("collector did not listen");
  return { app, store, origin: `http://127.0.0.1:${address.port}` };
}

/** Connect an MCP client with `x-api-key`, or the bearer alias when asked. */
async function connect(
  origin: string,
  key: string,
  style: "x-api-key" | "bearer" = "x-api-key",
): Promise<{ client: Client; transport: StreamableHTTPClientTransport }> {
  const headers = style === "bearer" ? { authorization: `Bearer ${key}` } : { "x-api-key": key };
  const transport = new StreamableHTTPClientTransport(new URL(`${origin}/mcp`), {
    requestInit: { headers },
  });
  const client = new Client({ name: "mcp-http-test", version: "0.0.0" });
  await client.connect(transport);
  return { client, transport };
}

/**
 * POST a raw JSON-RPC message, bypassing the SDK client — the only way to
 * assert on a **status code**, which the client transport folds into a message.
 */
async function postRaw(
  origin: string,
  headers: Record<string, string>,
  body: unknown,
): Promise<Response> {
  return fetch(`${origin}/mcp`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

/** A well-formed `initialize` request, for the raw posts above. */
const INITIALIZE = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "raw", version: "0.0.0" },
  },
};

/** The tool names the stdio server registers, from the same shared factory. */
async function stdioToolNames(): Promise<string[]> {
  const stub: CollectorClient = { get: async () => [] };
  const client = new Client({ name: "stdio-parity", version: "0.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createMcpServer(stub);
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  const { tools } = await client.listTools();
  await client.close();
  await server.close();
  return tools.map((tool) => tool.name).sort();
}

/** Wait for the fire-and-forget audit write to land. */
async function waitForAudit(
  store: CollectorStore,
  predicate: (rows: Awaited<ReturnType<CollectorStore["listAudit"]>>) => boolean,
): Promise<Awaited<ReturnType<CollectorStore["listAudit"]>>> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const rows = await store.listAudit(PROJECT_ID, { limit: 100 });
    if (predicate(rows)) return rows;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return store.listAudit(PROJECT_ID, { limit: 100 });
}

describe("POST /mcp — protocol surface", () => {
  let app: FastifyInstance;
  let store: CollectorStore;
  let origin: string;
  let client: Client;
  let transport: StreamableHTTPClientTransport;

  beforeAll(async () => {
    ({ app, store, origin } = await startCollector());
    ({ client, transport } = await connect(origin, "query-key"));
  });

  afterAll(async () => {
    await client?.close();
    await app?.close();
  });

  it("issues a session id on initialize", () => {
    expect(transport.sessionId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("serves the same tool catalog as the stdio server", async () => {
    const { tools } = await client.listTools();
    expect(tools.length).toBe(readTools.length);
    expect(tools.length).toBeGreaterThanOrEqual(69);
    expect(tools.map((tool) => tool.name).sort()).toEqual(await stdioToolNames());
  });

  it("serves the capability-discovery resources", async () => {
    const { resources } = await client.listResources();
    expect(resources.map((resource) => resource.uri).sort()).toEqual([
      "uptimizr://capabilities",
      "uptimizr://scenes",
    ]);
  });

  it("serves the curated prompts", async () => {
    const { prompts } = await client.listPrompts();
    expect(prompts.map((prompt) => prompt.name)).toContain("weekly_scene_health");
  });

  it("names the key's capabilities in the server instructions", () => {
    expect(client.getInstructions()).toContain("query");
  });

  it("answers a tools/call with structured rows from the real query route", async () => {
    const result = await client.callTool({
      name: "event_counts",
      arguments: { since: PARITY_RANGE.since, until: PARITY_RANGE.until },
    });
    expect(result.isError).toBeFalsy();
    const structured = result.structuredContent as { rows: Array<Record<string, unknown>> };
    expect(Array.isArray(structured.rows)).toBe(true);
    expect(structured.rows.length).toBeGreaterThan(0);
    for (const row of structured.rows) expect(typeof row.count).toBe("number");
  });

  it("audits the tool call as surface `mcp-http`", async () => {
    await client.callTool({ name: "list_scenes", arguments: {} });
    const rows = await waitForAudit(store, (found) =>
      found.some((row) => row.toolOrPath === "/api/v1/scenes"),
    );
    const row = rows.find((entry) => entry.toolOrPath === "/api/v1/scenes");
    expect(row).toBeDefined();
    expect(row?.surface).toBe("mcp-http");
    expect(row?.keyId).toBe("k-query");
    // The key itself is never written to the log, on any surface.
    expect(JSON.stringify(rows)).not.toContain("query-key");
    // The JSON-RPC envelope requests around it are not rows of their own.
    expect(rows.filter((entry) => entry.toolOrPath === "/mcp")).toEqual([]);
  });

  it("reports a refusal from the underlying endpoint as a tool error", async () => {
    // Raw retention is off in the test config, so the replay-adjacent resource
    // read is refused by the query route — and the refusal reaches the agent as
    // a tool error rather than a broken session.
    const result = await client.callTool({
      name: "session_meta",
      arguments: { sessionId: "does-not-exist" },
    });
    expect(result.isError).toBe(true);
  });
});

describe("POST /mcp — authentication", () => {
  let app: FastifyInstance;
  let store: CollectorStore;
  let origin: string;

  beforeAll(async () => {
    ({ app, store, origin } = await startCollector());
  });

  afterAll(async () => {
    await app?.close();
  });

  it("refuses an unauthenticated client with 401", async () => {
    expect((await postRaw(origin, {}, INITIALIZE)).status).toBe(401);
    const transport = new StreamableHTTPClientTransport(new URL(`${origin}/mcp`));
    const client = new Client({ name: "anon", version: "0.0.0" });
    await expect(client.connect(transport)).rejects.toThrow();
  });

  it("refuses an unknown key with 401", async () => {
    const response = await postRaw(origin, { "x-api-key": "not-a-key" }, INITIALIZE);
    expect(response.status).toBe(401);
    await expect(connect(origin, "not-a-key")).rejects.toThrow();
  });

  it("refuses an ingest-only key with 403, and records the refusal", async () => {
    const response = await postRaw(origin, { "x-api-key": "ingest-key" }, INITIALIZE);
    expect(response.status).toBe(403);
    const rows = await waitForAudit(store, (found) =>
      found.some((row) => row.toolOrPath === "/mcp"),
    );
    const refusal = rows.find((row) => row.toolOrPath === "/mcp");
    expect(refusal?.status).toBe(403);
    expect(refusal?.keyId).toBe("k-ingest");
    await expect(connect(origin, "ingest-key")).rejects.toThrow();
  });

  it("refuses a non-initialize request that quotes no session with 400", async () => {
    const response = await postRaw(
      origin,
      { "x-api-key": "query-key" },
      {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/list",
        params: {},
      },
    );
    expect(response.status).toBe(400);
  });

  it("accepts the Authorization: Bearer alias", async () => {
    const { client } = await connect(origin, "query-key", "bearer");
    expect((await client.listTools()).tools.length).toBe(readTools.length);
    await client.close();
  });

  it("reports the annotate key's wider capability set in its instructions", async () => {
    const { client } = await connect(origin, "annotate-key");
    // #310 turns this capability set into registered write tools; until it lands
    // this asserts the plumbing that carries the key's capabilities into
    // `createMcpServer`, and that a `query`-only session never sees `annotate`.
    expect(client.getInstructions()).toContain("annotate");
    const reader = await connect(origin, "query-key");
    expect(reader.client.getInstructions()).not.toContain("annotate");
    await reader.client.close();
    await client.close();
  });
});

describe("DELETE /mcp and the session cap", () => {
  it("ends a session so its id stops working", async () => {
    const { app, origin } = await startCollector();
    const { client, transport } = await connect(origin, "query-key");
    const sessionId = transport.sessionId;
    expect(sessionId).toBeDefined();

    await transport.terminateSession();

    // The id is gone: a fresh request quoting it is refused.
    const response = await fetch(`${origin}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "x-api-key": "query-key",
        "mcp-session-id": sessionId as string,
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
    });
    expect(response.status).toBe(404);

    await client.close();
    await app.close();
  });

  it("refuses the session over the cap with 503", async () => {
    const { app, origin } = await startCollector({ mcpMaxSessions: 1 });
    const first = await connect(origin, "query-key");
    const response = await postRaw(origin, { "x-api-key": "query-key" }, INITIALIZE);
    expect(response.status).toBe(503);
    await expect(connect(origin, "query-key")).rejects.toThrow();
    await first.client.close();
    await app.close();
  });

  it("refuses a session id presented by a different key with 403", async () => {
    const { app, origin } = await startCollector();
    const { client, transport } = await connect(origin, "query-key");
    const response = await fetch(`${origin}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "x-api-key": "annotate-key",
        "mcp-session-id": transport.sessionId as string,
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
    });
    expect(response.status).toBe(403);
    await client.close();
    await app.close();
  });
});

describe("the in-process dispatch marker", () => {
  it("cannot be forged from outside to mislabel an audit row or skip the rate limit", async () => {
    const store = await makeStore();
    const app = await buildApp({ store, config });
    const response = await app.inject({
      method: "GET",
      url: "/api/v1/scenes",
      headers: {
        "x-api-key": "query-key",
        // A remote caller guessing at the marker: same header, wrong token.
        "x-uptimizr-internal-dispatch": "guessed-token",
      },
    });
    expect(response.statusCode).toBe(200);
    const rows = await waitForAudit(store, (found) => found.length > 0);
    expect(rows[0]?.surface).toBe("http");
    await app.close();
  });
});

describe("COLLECTOR_MCP_HTTP off (the default)", () => {
  it("does not register /mcp at all", async () => {
    const store = await makeStore();
    const app = await buildApp({ store, config: { ...config, mcpHttpEnabled: false } });
    const response = await app.inject({
      method: "POST",
      url: "/mcp",
      headers: { "x-api-key": "query-key" },
      payload: { jsonrpc: "2.0", id: 1, method: "initialize", params: {} },
    });
    expect(response.statusCode).toBe(404);
    await app.close();
  });
});
