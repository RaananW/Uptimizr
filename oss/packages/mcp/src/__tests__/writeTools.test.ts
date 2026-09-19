/**
 * The metadata write tools over a real MCP client (#310, ADR 0051 §5).
 *
 * The interesting behaviour is conditional registration: `tools/list` shows the
 * six metadata tools only when the calling key holds `annotate`, and the server
 * learns that from `GET /api/v1/whoami` at start-up. Both branches are covered,
 * plus the start-up read itself and what each tool actually sends.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CollectorClient, QueryParams } from "@uptimizr/agent-core";
import { readTools, writeTools } from "@uptimizr/agent-core";
import { describe, expect, it } from "vitest";
import { createMcpServer, fetchKeyCapabilities } from "../server.js";

/** Every call the stub collector saw, so a test can assert the mapping. */
interface Recorded {
  method: "GET" | "POST" | "PUT" | "DELETE";
  path: string;
  params?: QueryParams;
  body?: unknown;
}

function stubCollector(whoami: unknown = { capabilities: ["query", "annotate"] }): {
  client: CollectorClient;
  calls: Recorded[];
} {
  const calls: Recorded[] = [];
  const client: CollectorClient = {
    async get(path, params = {}) {
      calls.push({ method: "GET", path, params });
      return path === "/api/v1/whoami" ? whoami : [];
    },
    async post(path, body) {
      calls.push({ method: "POST", path, body });
      return { id: "an_1" };
    },
    async put(path, body) {
      calls.push({ method: "PUT", path, body });
      return { term: "TTFR" };
    },
    async delete(path) {
      calls.push({ method: "DELETE", path });
      return null;
    },
  };
  return { client, calls };
}

async function connect(
  collector: CollectorClient,
  capabilities?: readonly string[],
): Promise<Client> {
  const client = new Client({ name: "test", version: "0.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([
    client.connect(clientTransport),
    createMcpServer(collector, capabilities ? { capabilities } : {}).connect(serverTransport),
  ]);
  return client;
}

const WRITE_TOOL_NAMES = writeTools.map((tool) => tool.name);

describe("fetchKeyCapabilities", () => {
  it("reads the key's capabilities from whoami", async () => {
    const { client, calls } = stubCollector({ capabilities: ["query", "annotate"] });
    expect(await fetchKeyCapabilities(client)).toEqual(["query", "annotate"]);
    expect(calls[0]).toMatchObject({ method: "GET", path: "/api/v1/whoami" });
  });

  it("degrades to no capabilities when whoami fails or is unrecognisable", async () => {
    const failing: CollectorClient = {
      get: async () => {
        throw new Error("404 not found");
      },
    };
    expect(await fetchKeyCapabilities(failing)).toEqual([]);

    const { client } = stubCollector({ nothing: true });
    expect(await fetchKeyCapabilities(client)).toEqual([]);
  });
});

describe("conditional registration", () => {
  it("omits every metadata tool for a key without `annotate`", async () => {
    const { client } = stubCollector();
    const mcp = await connect(client, ["query"]);
    const names = (await mcp.listTools()).tools.map((tool) => tool.name);
    for (const name of WRITE_TOOL_NAMES) expect(names).not.toContain(name);
    // The read catalog is untouched.
    expect(names).toHaveLength(readTools.length);
    await mcp.close();
  }, 30_000);

  it("omits them when no capabilities are supplied at all (pre-#310 callers)", async () => {
    const { client } = stubCollector();
    const mcp = await connect(client);
    const names = (await mcp.listTools()).tools.map((tool) => tool.name);
    for (const name of WRITE_TOOL_NAMES) expect(names).not.toContain(name);
    await mcp.close();
  }, 30_000);

  it("registers all six for a key holding `annotate`", async () => {
    const { client } = stubCollector();
    const mcp = await connect(client, ["query", "annotate"]);
    const names = (await mcp.listTools()).tools.map((tool) => tool.name);
    for (const name of WRITE_TOOL_NAMES) expect(names).toContain(name);
    expect(names).toHaveLength(readTools.length + writeTools.length);
    await mcp.close();
  }, 30_000);
});

describe("what each write tool sends", () => {
  it("annotate POSTs the note, omitting absent optional fields", async () => {
    const { client, calls } = stubCollector();
    const mcp = await connect(client, ["annotate"]);
    await mcp.callTool({
      name: "annotate",
      arguments: { targetKind: "mesh", targetId: "counter", text: "dead clicks" },
    });
    expect(calls).toContainEqual({
      method: "POST",
      path: "/api/v1/annotations",
      body: { targetKind: "mesh", targetId: "counter", text: "dead clicks" },
    });
    await mcp.close();
  });

  it("define_term PUTs to the encoded term path", async () => {
    const { client, calls } = stubCollector();
    const mcp = await connect(client, ["annotate"]);
    await mcp.callTool({
      name: "define_term",
      arguments: { term: "checkout counter", meaning: "the till cluster" },
    });
    expect(calls).toContainEqual({
      method: "PUT",
      path: "/api/v1/glossary/checkout%20counter",
      body: { meaning: "the till cluster" },
    });
    await mcp.close();
  });

  it("save_analysis POSTs the title, query and conclusion", async () => {
    const { client, calls } = stubCollector();
    const mcp = await connect(client, ["annotate"]);
    await mcp.callTool({
      name: "save_analysis",
      arguments: {
        title: "Lobby FPS",
        query: { metric: "perf_summary", scene: "lobby" },
        conclusion: "p50 fell to 41.",
      },
    });
    expect(calls).toContainEqual({
      method: "POST",
      path: "/api/v1/analyses",
      body: {
        title: "Lobby FPS",
        query: { metric: "perf_summary", scene: "lobby" },
        conclusion: "p50 fell to 41.",
      },
    });
    await mcp.close();
  });

  it("the three metadata reads are GETs and change nothing", async () => {
    const { client, calls } = stubCollector();
    const mcp = await connect(client, ["annotate"]);
    await mcp.callTool({ name: "list_annotations", arguments: { limit: 5 } });
    await mcp.callTool({ name: "list_glossary", arguments: {} });
    await mcp.callTool({ name: "list_analyses", arguments: {} });
    expect(calls.every((call) => call.method === "GET")).toBe(true);
    expect(calls.map((call) => call.path)).toEqual([
      "/api/v1/annotations",
      "/api/v1/glossary",
      "/api/v1/analyses",
    ]);
    await mcp.close();
  });

  it("reports a refusal from the collector as a tool error, not a crash", async () => {
    const refusing: CollectorClient = {
      get: async () => [],
      post: async () => {
        throw new Error("api key not permitted to write metadata");
      },
    };
    const mcp = await connect(refusing, ["annotate"]);
    const result = await mcp.callTool({
      name: "annotate",
      arguments: { targetKind: "project", text: "nope" },
    });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toMatch(/not permitted to write metadata/);
    await mcp.close();
  });

  it("explains itself when the client has no write transport", async () => {
    const readOnly: CollectorClient = { get: async () => [] };
    const mcp = await connect(readOnly, ["annotate"]);
    const result = await mcp.callTool({
      name: "annotate",
      arguments: { targetKind: "project", text: "nope" },
    });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toMatch(/read-only/);
    await mcp.close();
  });
});

describe("no metadata tool can touch an event", () => {
  /** Minimal valid arguments for each tool, so every one can be exercised. */
  const ARGS: Record<string, Record<string, unknown>> = {
    annotate: { targetKind: "project", text: "note" },
    define_term: { term: "t", meaning: "m" },
    save_analysis: { title: "t", query: {} },
    list_annotations: {},
    list_glossary: {},
    list_analyses: {},
  };

  it("every tool in the catalog hits one of the three metadata paths", async () => {
    const { client, calls } = stubCollector();
    for (const tool of writeTools) {
      await tool.execute(client, ARGS[tool.name]!);
    }
    expect(calls).toHaveLength(writeTools.length);
    for (const call of calls) {
      expect(call.path).toMatch(/^\/api\/v1\/(annotations|glossary|analyses)(\/|$)/);
    }
  });

  it("the read catalog and the metadata catalog do not overlap", () => {
    const readNames = new Set(readTools.map((tool) => tool.name));
    for (const tool of writeTools) expect(readNames.has(tool.name)).toBe(false);
  });
});
