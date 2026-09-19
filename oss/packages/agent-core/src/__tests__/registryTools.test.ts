import { describe, expect, it } from "vitest";
import { z } from "zod";
import { allMetrics, getMetric, type MetricDefinition } from "@uptimizr/metrics";
import {
  DEFAULT_TOOL_FORMAT,
  describeMetric,
  metricToTool,
  registryToTools,
} from "../registryTools.js";

const tools = registryToTools();
const byName = (name: string) => {
  const tool = tools.find((t) => t.name === name);
  if (!tool) throw new Error(`tool ${name} not found`);
  return tool;
};

describe("registryToTools", () => {
  it("generates exactly one tool per registry metric that has an endpoint", () => {
    const withEndpoint = allMetrics().filter((m) => m.endpoint);
    expect(tools).toHaveLength(withEndpoint.length);
    expect(tools.map((t) => t.name)).toEqual(withEndpoint.map((m) => m.id));
  });

  it("covers the whole collector read surface — 73 tools, uniquely named", () => {
    // The ordinary `query` surface plus the one `query:raw` metric
    // (`session_narrative`). `registryToTools` is capability-blind; `tools.ts`
    // is what splits them into `readTools` and `rawTools`.
    expect(tools).toHaveLength(73);
    expect(new Set(tools.map((t) => t.name)).size).toBe(tools.length);
    for (const tool of tools) expect(tool.name).toMatch(/^[a-z][a-z0-9_]*$/);
  });

  it("skips the two rollups that have no route, so no tool can 404", () => {
    const names = tools.map((t) => t.name);
    expect(names).not.toContain("events_daily");
    expect(names).not.toContain("perf_daily");
  });

  it("exposes the metrics agents could not see before", () => {
    const names = tools.map((t) => t.name);
    for (const metric of [
      "dead_clicks",
      "rage_clicks",
      "jank_rate",
      "perf_by_device",
      "scene_coverage",
      "mesh_blind_spots",
      "scene_retention",
      "variant_leaderboard",
      "load_bounce_funnel",
    ]) {
      expect(names).toContain(metric);
    }
  });

  it("only targets read (api/v1/...) paths and never collect/mutation endpoints", () => {
    for (const tool of tools) {
      const { path } = tool.buildRequest({ sessionId: "s", sceneId: "lobby" });
      expect(path.startsWith("api/v1/")).toBe(true);
      expect(path).not.toContain("collect");
      expect(path).not.toContain(":");
    }
  });

  it("carries the registry title and composed prose", () => {
    const metric = getMetric("dead_clicks") as MetricDefinition;
    const tool = byName("dead_clicks");
    expect(tool.title).toBe(metric.title);
    expect(tool.description).toContain(metric.description);
    expect(tool.description).toContain(metric.interpretation);
    for (const caveat of metric.caveats) expect(tool.description).toContain(caveat);
  });

  it("gives every tool an output schema derived from the registry row", () => {
    for (const tool of tools) {
      expect(tool.outputSchema, tool.name).toBeDefined();
      // One object schema per tool: what an MCP output schema has to be.
      expect(z.toJSONSchema(tool.outputSchema!).type, tool.name).toBe("object");
    }
    const schema = byName("top_meshes").outputSchema!;
    expect(schema.parse({ rows: [{ mesh: "buy", count: 12 }] })).toEqual({
      rows: [{ mesh: "buy", count: 12 }],
    });
    // Registry row schemas are strict `z.number()` (ADR 0051 §2): the collector
    // coerces at the store edge, so the advertised schema describes the API, not
    // a dialect's wire format. A string-encoded count is a contract violation
    // and must be rejected rather than silently repaired here.
    expect(schema.safeParse({ rows: [{ mesh: "buy", count: "12" }] }).success).toBe(false);
  });

  it("keeps unknown columns rather than silently dropping them", () => {
    const parsed = byName("world_heatmap_stats").outputSchema!.parse({
      rows: [{ cells: 3, hits: 9, cellSize: 0.5 }],
    });
    expect(parsed).toEqual({ rows: [{ cells: 3, hits: 9, cellSize: 0.5 }] });
  });

  it("omits undefined params and forwards provided ones", () => {
    const { path, params } = byName("pointer_heatmap").buildRequest({ bins: 50, scene: "lobby" });
    expect(path).toBe("api/v1/heatmaps/pointer");
    expect(params.bins).toBe(50);
    expect(params.scene).toBe("lobby");
    expect(params.since).toBeUndefined();
    expect(params.source).toBeUndefined();
  });

  it("substitutes and encodes path parameters", () => {
    expect(byName("session_meta").buildRequest({ sessionId: "a/b c" }).path).toBe(
      "api/v1/sessions/a%2Fb%20c/meta",
    );
    expect(byName("scene_representation").buildRequest({ sceneId: "lob by" }).path).toBe(
      "api/v1/scenes/lob%20by/representation",
    );
    const trajectory = byName("session_trajectory").buildRequest({ sessionId: "s1", limit: 10 });
    expect(trajectory.path).toBe("api/v1/sessions/s1/trajectory");
    expect(trajectory.params.limit).toBe(10);
  });

  it("requires the parameters the collector requires, and nothing else", () => {
    const required = (name: string) =>
      Object.entries(byName(name).inputSchema)
        .filter(([, field]) => !(field instanceof z.ZodOptional))
        .map(([key]) => key);
    expect(required("funnel")).toEqual(["steps"]);
    expect(required("mesh_uv_heatmap")).toEqual(["mesh"]);
    expect(required("session_meta")).toEqual(["sessionId"]);
    expect(required("scene_representation")).toEqual(["sceneId"]);
    expect(required("top_meshes")).toEqual([]);
  });

  it("sends the boolean flow-link toggle as the collector's string enum", () => {
    const { params } = byName("flow_links").buildRequest({ groupByOrigin: true });
    expect(params.groupByOrigin).toBe("true");
  });

  it("validates arguments against the generated input schema", () => {
    const schema = z.object(byName("rage_clicks").inputSchema);
    expect(schema.safeParse({ minRepeats: 1 }).success).toBe(false);
    expect(schema.safeParse({ minRepeats: 3 }).success).toBe(true);
    expect(z.object(byName("funnel").inputSchema).safeParse({}).success).toBe(false);
  });

  it("is pure: the same registry always yields the same catalog", () => {
    const again = registryToTools();
    expect(again.map((t) => t.name)).toEqual(tools.map((t) => t.name));
  });
});

describe("metricToTool", () => {
  it("returns undefined for a metric with no collector endpoint", () => {
    const metric = getMetric("events_daily") as MetricDefinition;
    expect(metricToTool(metric)).toBeUndefined();
  });

  it("rejects an endpoint whose declared path params do not match the path", () => {
    const metric = getMetric("session_meta") as MetricDefinition;
    const broken = { ...metric, endpoint: { ...metric.endpoint!, pathParams: [] } };
    expect(() => metricToTool(broken as MetricDefinition)).toThrow(/path parameter/);
  });
});

describe("describeMetric", () => {
  it("reads as prose an agent can act on", () => {
    const metric = getMetric("jank_rate") as MetricDefinition;
    const text = describeMetric(metric);
    expect(text).toContain("How to read it:");
    expect(text).toContain("Caveats:");
    expect(text.split("\n").filter((l) => l.startsWith("- "))).toHaveLength(metric.caveats.length);
  });
});

describe("result envelopes", () => {
  const meta = {
    metric: "top_meshes",
    range: { since: 1, until: 2 },
    filters: { scene: "lobby" },
    sampleSize: { sessions: null, events: 18 },
    rows: 1,
    truncated: false,
    limits: { maxRows: 1000, maxSummaryRows: 10 },
  };
  const rows = [{ mesh: "buy", count: 12 }];

  it("advertises all three envelopes for a tool that honours format", () => {
    // #350: the tool used to advertise `{ rows }` only, so an MCP client
    // rejected the `table` and `summary` results the guides tell agents to ask
    // for. All three now validate against the one advertised schema.
    const schema = byName("top_meshes").outputSchema!;
    expect(schema.parse({ rows })).toEqual({ rows });
    expect(schema.parse({ meta, rows })).toEqual({ meta, rows });
    const summary = {
      kind: "ranked",
      metric: "top_meshes",
      range: { since: 1, until: 2 },
      filters: {},
      sampleSize: { sessions: null, events: 18 },
      total: 18,
      measure: { column: "count", unit: "count", additive: true },
      top: [{ label: "buy", value: 12, share: 0.667 }],
      rest: { rows: 1, value: 6, share: 0.333 },
      reading: "Most-interacted meshes: buy leads on count with 12 (66.7% of 18).",
      caveats: [],
    };
    expect(schema.parse(summary)).toMatchObject({ kind: "ranked" });
  });

  it("leaves a resource read's schema at the rows envelope it shipped with", () => {
    // `session_meta` and `scene_representation` declare no `format`: a stored
    // record has nothing to summarise, so their schema must not widen.
    const schema = byName("session_meta").outputSchema!;
    expect(Object.keys(z.toJSONSchema(schema).properties ?? {})).toEqual(["rows"]);
  });

  it("asks for the table envelope by default and lets a caller choose another", () => {
    expect(byName("top_meshes").buildRequest({}).params.format).toBe(DEFAULT_TOOL_FORMAT);
    expect(byName("top_meshes").buildRequest({ format: "summary" }).params.format).toBe("summary");
    expect(byName("top_meshes").buildRequest({ format: "full" }).params.format).toBe("full");
  });

  it("never sends format to an endpoint that does not accept it", () => {
    expect(byName("session_meta").buildRequest({ sessionId: "s1" }).params.format).toBeUndefined();
    expect(
      byName("scene_representation").buildRequest({ sceneId: "lobby" }).params.format,
    ).toBeUndefined();
  });
});
