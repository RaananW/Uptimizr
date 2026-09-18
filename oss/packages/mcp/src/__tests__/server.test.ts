/**
 * End-to-end MCP protocol test: a real `Client` and the real `createMcpServer`
 * joined by the SDK's in-memory transport pair, with a stub collector standing
 * in for the HTTP layer. It exercises what an MCP client actually sees —
 * `tools/list` (now the whole generated catalog, ADR 0051 §1) and `tools/call`
 * with the registry-derived `outputSchema`, whose `structuredContent` the SDK
 * validates for us before it ever reaches the client.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CollectorClient, QueryParams } from "@uptimizr/agent-core";
import { readTools } from "@uptimizr/agent-core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createMcpServer } from "../server.js";

/** What the stub collector was asked for, so a test can assert the mapping. */
interface Recorded {
  path: string;
  params: QueryParams;
}

let requests: Recorded[] = [];
let respond: (path: string) => unknown = () => [];
let client: Client;

const stubCollector: CollectorClient = {
  async get(path, params = {}) {
    requests.push({ path, params });
    return respond(path);
  },
};

beforeEach(async () => {
  requests = [];
  client = new Client({ name: "test", version: "0.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([
    client.connect(clientTransport),
    createMcpServer(stubCollector).connect(serverTransport),
  ]);
  // Listing first is what a real client does, and it is what arms the SDK
  // client's strict (Ajv) validation of `structuredContent` against each tool's
  // advertised output schema — so every `tools/call` below is checked twice.
  await client.listTools();
});

afterEach(async () => {
  await client.close();
});

describe("tools/list", () => {
  it("advertises every generated tool with an input and an output schema", async () => {
    const { tools } = await client.listTools();
    expect(tools).toHaveLength(readTools.length);
    expect(tools.length).toBeGreaterThanOrEqual(69);
    for (const tool of tools) {
      expect(tool.inputSchema.type).toBe("object");
      expect(tool.outputSchema?.type).toBe("object");
      expect(Object.keys(tool.outputSchema?.properties ?? {})).toEqual(["rows"]);
      expect(tool.description).toContain("Caveats:");
    }
  });

  it("includes the metrics agents could not reach before the registry", async () => {
    const names = (await client.listTools()).tools.map((t) => t.name);
    for (const name of [
      "dead_clicks",
      "rage_clicks",
      "perf_by_device",
      "jank_rate",
      "scene_coverage",
      "variant_leaderboard",
    ]) {
      expect(names).toContain(name);
    }
  });
});

describe("tools/call", () => {
  it("returns structured rows and the JSON text for a legacy tool", async () => {
    respond = () => [{ mesh: "buy", count: 12 }];
    const result = await client.callTool({
      name: "top_meshes",
      arguments: { since: 1, limit: 5 },
    });
    expect(requests).toEqual([
      {
        path: "api/v1/meshes/top",
        params: { since: 1, until: undefined, bins: undefined, limit: 5, session: undefined },
      },
    ]);
    expect(result.structuredContent).toEqual({ rows: [{ mesh: "buy", count: 12 }] });
    expect((result.content as { text: string }[])[0]?.text).toBe('[{"mesh":"buy","count":12}]');
  });

  it("reports a string-encoded number rather than silently repairing it", async () => {
    // ClickHouse renders 64-bit integers as strings over HTTP, but since
    // ADR 0051 §2 every store coerces at its own edge (`coerceRows`), so the
    // collector's contract is that a numeric column *is* a number. The registry
    // row schemas are strict `z.number()` accordingly, and they are what this
    // server advertises as each tool's `outputSchema`. A collector that still
    // string-encodes is therefore out of contract, and the SDK's output
    // validation says so by name instead of the edge quietly papering over it.
    respond = () => [{ mesh: "buy", count: "12" }];
    const result = await client.callTool({ name: "top_meshes", arguments: {} });
    expect(result.isError).toBe(true);
    expect((result.content as { text: string }[])[0]?.text).toContain("rows[0].count");
  });

  it("accepts a null measure — an aggregate over a range with no samples", async () => {
    respond = () => [{ samples: 0, avg_fps: null, min_fps: null, p50_fps: null }];
    const result = await client.callTool({ name: "perf_summary", arguments: {} });
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toEqual({
      rows: [{ samples: 0, avg_fps: null, min_fps: null, p50_fps: null }],
    });
  });

  it("passes through a column the route adds on top of the aggregation", async () => {
    respond = () => ({ cellSize: 0.5, cells: 3, hits: 9 });
    const result = await client.callTool({ name: "world_heatmap_stats", arguments: {} });
    expect(result.structuredContent).toEqual({ rows: [{ cellSize: 0.5, cells: 3, hits: 9 }] });
  });

  it("serves a newly generated tool", async () => {
    respond = () => [{ total_clicks: 10, dead_clicks: 4 }];
    const result = await client.callTool({ name: "dead_clicks", arguments: { scene: "lobby" } });
    expect(requests[0]?.path).toBe("api/v1/clicks/dead");
    expect(requests[0]?.params.scene).toBe("lobby");
    expect((result.structuredContent as { rows: unknown[] }).rows).toHaveLength(1);
  });

  it("wraps a single-object result in the same rows envelope", async () => {
    respond = () => ({ sessionId: "s1", startedAt: "2026-09-16 10:00:00.000" });
    const result = await client.callTool({
      name: "session_meta",
      arguments: { sessionId: "s1" },
    });
    expect(requests[0]?.path).toBe("api/v1/sessions/s1/meta");
    expect(result.structuredContent).toEqual({
      rows: [{ sessionId: "s1", startedAt: "2026-09-16 10:00:00.000" }],
    });
  });

  it("rejects arguments the generated input schema does not allow", async () => {
    const result = await client.callTool({ name: "rage_clicks", arguments: { minRepeats: 1 } });
    expect(result.isError).toBe(true);
  });

  it("reports a collector failure as a tool error, not a protocol error", async () => {
    respond = () => {
      throw new Error("collector unavailable");
    };
    const result = await client.callTool({ name: "list_scenes", arguments: {} });
    expect(result.isError).toBe(true);
    expect((result.content as { text: string }[])[0]?.text).toContain("collector unavailable");
  });
});

/**
 * The `capabilities` option (#313) carries the API key's capability set from the
 * collector-hosted Streamable HTTP transport into the shared server factory, so
 * one session's surface can be shaped by what its key may actually do. The stdio
 * entry point omits it and must be unaffected.
 */
describe("createMcpServer options", () => {
  async function connectWith(options?: Parameters<typeof createMcpServer>[1]): Promise<Client> {
    const paired = new Client({ name: "options-test", version: "0.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([
      paired.connect(clientTransport),
      createMcpServer(stubCollector, options).connect(serverTransport),
    ]);
    return paired;
  }

  it("registers the same catalog with or without a capability set", async () => {
    const withOption = await connectWith({ capabilities: ["query"] });
    const withoutOption = await connectWith();
    const listed = (await withOption.listTools()).tools.map((tool) => tool.name).sort();
    expect(listed).toEqual((await withoutOption.listTools()).tools.map((t) => t.name).sort());
    expect(listed).toHaveLength(readTools.length);
    await withOption.close();
    await withoutOption.close();
  });

  it("names the granted capabilities in the server instructions", async () => {
    const reader = await connectWith({ capabilities: ["query"] });
    expect(reader.getInstructions()).toContain("query");
    expect(reader.getInstructions()).not.toContain("annotate");
    await reader.close();

    const writer = await connectWith({ capabilities: ["query", "annotate"] });
    expect(writer.getInstructions()).toContain("annotate");
    await writer.close();
  });

  it("leaves the stdio server's initialize result untouched when omitted", async () => {
    const plain = await connectWith();
    expect(plain.getInstructions()).toBeUndefined();
    await plain.close();
  });
});
