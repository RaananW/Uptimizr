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
import { allMetrics, type MetricDefinition } from "@uptimizr/metrics";
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
      // MCP output schemas must be objects — the SDK drops anything else, so a
      // union of the three envelopes is advertised in its merged object form.
      expect(tool.outputSchema?.type, tool.name).toBe("object");
      const properties = Object.keys(tool.outputSchema?.properties ?? {});
      expect(properties, tool.name).toContain("rows");
      expect(tool.description).toContain("Caveats:");
      const metric = metricOf(tool.name);
      if (metric.filters.includes("format")) {
        // Every envelope the tool can answer with is described (#350).
        expect(properties, tool.name).toEqual(expect.arrayContaining(["meta", "kind", "reading"]));
      } else {
        // A resource read takes no `format`, so its schema is unchanged.
        expect(properties, tool.name).toEqual(["rows"]);
      }
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
    // `format` defaults to `table` in the tool schema (#336) and travels
    // explicitly on the wire, so the collector default stays `full`.
    expect(requests).toEqual([
      {
        path: "api/v1/meshes/top",
        params: {
          since: 1,
          until: undefined,
          bins: undefined,
          limit: 5,
          session: undefined,
          format: "table",
        },
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

// ---------------------------------------------------------------------------
// Result envelopes (#350 / #336)
// ---------------------------------------------------------------------------

const METRICS = new Map<string, MetricDefinition>(allMetrics().map((m) => [m.id, m]));

function metricOf(name: string): MetricDefinition {
  const metric = METRICS.get(name);
  if (!metric) throw new Error(`no registry metric for tool '${name}'`);
  return metric;
}

/**
 * The arguments a tool declares **required** — the two the collector requires in
 * its querystring, plus the two path parameters. Everything else is optional, so
 * a call can be made with nothing but the format under test.
 */
const REQUIRED_ARGS: Readonly<Record<string, Record<string, unknown>>> = {
  funnel: { steps: '[{"type":"scene_change","to":"lobby"}]' },
  mesh_uv_heatmap: { mesh: "box" },
  session_meta: { sessionId: "s1" },
  session_trajectory: { sessionId: "s4" },
  scene_representation: { sceneId: "lobby" },
};

/**
 * One row of a metric with every column `null`. The generated row schema makes
 * every column nullable (an aggregate over an empty window really does project
 * SQL `NULL`), so this is a valid row for *every* metric in the registry — which
 * is what lets one loop check all 69 row schemas against all three envelopes
 * without inventing 69 sets of plausible values.
 */
function nullRow(metric: MetricDefinition): Record<string, unknown> {
  return Object.fromEntries(Object.keys(metric.row.shape).map((column) => [column, null]));
}

/** What the collector answers with for `format=table`. */
function tableEnvelope(metric: MetricDefinition, rows: readonly unknown[]): unknown {
  return {
    meta: {
      metric: metric.id,
      range: { since: 1, until: 2 },
      filters: { since: 1, until: 2 },
      sampleSize: { sessions: null, events: 3 },
      rows: rows.length,
      truncated: false,
      limits: metric.limits,
    },
    rows,
  };
}

/** What the collector answers with for `format=summary` (the `ranked` grain). */
function summaryEnvelope(metric: MetricDefinition): unknown {
  return {
    kind: "ranked",
    metric: metric.id,
    range: { since: 1, until: 2 },
    filters: { since: 1, until: 2 },
    sampleSize: { sessions: null, events: 3 },
    total: 3,
    measure: { column: "count", unit: "count", additive: true },
    confidence: { kind: "wilson", level: 0.95, note: "95% Wilson interval." },
    top: [
      {
        label: "buy",
        value: 2,
        share: 0.666,
        shareInterval: { low: 0.2, high: 0.94 },
        drill: { mesh: "buy" },
      },
    ],
    rest: { rows: 1, value: 1, share: 0.333 },
    reading: `${metric.title}: buy leads with 2 (66.6% of 3).`,
    caveats: metric.caveats,
  };
}

describe("result envelopes", () => {
  it("accepts all three formats for every generated tool", async () => {
    for (const tool of readTools) {
      const metric = metricOf(tool.name);
      const args = { ...(REQUIRED_ARGS[tool.name] ?? {}) };
      const row = nullRow(metric);

      respond = () => [row];
      const full = await client.callTool({
        name: tool.name,
        arguments: { ...args, format: "full" },
      });
      expect(full.isError, `${tool.name} format=full`).toBeFalsy();
      expect(full.structuredContent, tool.name).toEqual({ rows: [row] });

      // The two resource reads declare no `format` — the argument is rejected
      // by the input schema rather than silently ignored.
      if (!metric.filters.includes("format")) continue;

      respond = () => tableEnvelope(metric, [row]);
      const table = await client.callTool({
        name: tool.name,
        arguments: { ...args, format: "table" },
      });
      expect(table.isError, `${tool.name} format=table`).toBeFalsy();
      expect(table.structuredContent, tool.name).toEqual(tableEnvelope(metric, [row]));

      respond = () => summaryEnvelope(metric);
      const summary = await client.callTool({
        name: tool.name,
        arguments: { ...args, format: "summary" },
      });
      expect(summary.isError, `${tool.name} format=summary`).toBeFalsy();
      expect((summary.structuredContent as { kind: string }).kind, tool.name).toBe("ranked");
      expect((summary.structuredContent as { reading: string }).reading, tool.name).toContain(
        metric.title,
      );
    }
  }, 120_000);

  it("defaults to the table envelope when the caller omits format (#336)", async () => {
    const metric = metricOf("top_meshes");
    respond = () => tableEnvelope(metric, [{ mesh: "buy", count: 12 }]);
    const result = await client.callTool({ name: "top_meshes", arguments: {} });
    expect(requests[0]?.params.format).toBe("table");
    expect(result.isError).toBeFalsy();
    const structured = result.structuredContent as { meta: { rows: number }; rows: unknown[] };
    expect(structured.meta.rows).toBe(1);
    expect(structured.rows).toEqual([{ mesh: "buy", count: 12 }]);
  });

  it("keeps the summary digest whole rather than stripping it to rows", async () => {
    // The regression #350 reported: the tool advertised `{ rows }` only, so the
    // SDK rejected the summary envelope with -32602 before a client ever saw it.
    const metric = metricOf("top_meshes");
    respond = () => summaryEnvelope(metric);
    const result = await client.callTool({
      name: "top_meshes",
      arguments: { format: "summary" },
    });
    expect(result.isError).toBeFalsy();
    const structured = result.structuredContent as {
      kind: string;
      top: { label: string }[];
      reading: string;
    };
    expect(structured.kind).toBe("ranked");
    expect(structured.top[0]?.label).toBe("buy");
    expect(structured.reading).toContain("buy leads");
  });

  it("still wraps rows from an older collector that ignores format", async () => {
    // A published client pointed at a collector from before ADR 0051 §2 asks for
    // `table` and gets the bare rows back. That is not an envelope, so it is
    // reported as `{ rows }` — the tool keeps working instead of failing output
    // validation on a payload the collector never promised.
    respond = () => [{ mesh: "buy", count: 12 }];
    const result = await client.callTool({ name: "top_meshes", arguments: { format: "table" } });
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toEqual({ rows: [{ mesh: "buy", count: 12 }] });
  });

  it("rejects a malformed envelope instead of passing it off as a result", async () => {
    // `meta.rows` is the row count, not the rows; a collector that sends the
    // wrong shape is reported by name rather than silently accepted.
    respond = () => ({ meta: { metric: "top_meshes", rows: "many" }, rows: [] });
    const result = await client.callTool({ name: "top_meshes", arguments: { format: "table" } });
    expect(result.isError).toBe(true);
    expect((result.content as { text: string }[])[0]?.text).toContain("meta");
  });
});
