/**
 * The three result envelopes (ADR 0051 §2), which now have exactly one
 * definition — this package's — shared by the collector's response schemas
 * (`@uptimizr/db/summary` re-exports them) and by the agent-facing tool output
 * schemas in `@uptimizr/agent-core` / `@uptimizr/mcp` (#350).
 */

import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  resultEnvelopeSchema,
  resultFormatSchema,
  structuredEnvelopeSchema,
  summaryEnvelopeSchema,
  tableEnvelopeSchema,
} from "../envelopes.js";
import { getMetric } from "../registry.js";

const metric = getMetric("top_meshes")!;
const row = metric.row;
const rows = [{ mesh: "buy", count: 12 }];

const meta = {
  metric: "top_meshes",
  range: { since: 1, until: 2 },
  filters: { scene: "lobby" },
  sampleSize: { sessions: null, events: 18 },
  rows: 1,
  truncated: false,
  limits: metric.limits,
};

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

describe("resultFormatSchema", () => {
  it("accepts the three formats and nothing else", () => {
    expect(resultFormatSchema.options).toEqual(["full", "table", "summary"]);
    expect(resultFormatSchema.safeParse("ndjson").success).toBe(false);
  });
});

describe("tableEnvelopeSchema", () => {
  it("parses a meta envelope around the metric's own rows", () => {
    expect(tableEnvelopeSchema(row).parse({ meta, rows })).toEqual({ meta, rows });
  });

  it("rejects a meta block that is missing a field or has the wrong type", () => {
    expect(
      tableEnvelopeSchema(row).safeParse({ meta: { metric: "top_meshes" }, rows }).success,
    ).toBe(false);
    expect(
      tableEnvelopeSchema(row).safeParse({ meta: { ...meta, rows: "many" }, rows }).success,
    ).toBe(false);
  });

  it("rejects a metric id that is not in the registry", () => {
    expect(
      tableEnvelopeSchema(row).safeParse({ meta: { ...meta, metric: "made_up" }, rows }).success,
    ).toBe(false);
  });
});

describe("summaryEnvelopeSchema", () => {
  it("parses a ranked digest", () => {
    expect(summaryEnvelopeSchema.parse(summary)).toMatchObject({ kind: "ranked" });
  });

  it("discriminates on kind — a ranked payload cannot pass as a series", () => {
    expect(summaryEnvelopeSchema.safeParse({ ...summary, kind: "series" }).success).toBe(false);
    expect(summaryEnvelopeSchema.safeParse({ ...summary, kind: "unknown" }).success).toBe(false);
  });

  it("requires the reading sentence every summary promises", () => {
    const { reading: _reading, ...withoutReading } = summary;
    expect(summaryEnvelopeSchema.safeParse(withoutReading).success).toBe(false);
  });
});

describe("resultEnvelopeSchema", () => {
  const envelope = resultEnvelopeSchema(row);

  it("accepts all three shapes", () => {
    expect(envelope.parse(rows)).toEqual(rows);
    expect(envelope.parse({ meta, rows })).toEqual({ meta, rows });
    expect(envelope.parse(summary)).toMatchObject({ kind: "ranked" });
  });

  it("takes a caller-supplied full shape for a single-record endpoint", () => {
    const record = z.object({ cells: z.number(), hits: z.number() });
    const single = resultEnvelopeSchema(record, record);
    expect(single.parse({ cells: 3, hits: 9 })).toEqual({ cells: 3, hits: 9 });
    expect(single.safeParse([{ cells: 3, hits: 9 }]).success).toBe(false);
  });

  it("rejects something that is none of the three", () => {
    expect(envelope.safeParse({ rows }).success).toBe(false);
  });
});

describe("structuredEnvelopeSchema", () => {
  const structured = structuredEnvelopeSchema(row);

  it("is an object schema — what an MCP outputSchema must be", () => {
    // The MCP SDK normalises an output schema to an object and silently drops
    // anything else (a top-level union included), so the union is advertised in
    // this merged object form.
    expect(z.toJSONSchema(structured).type).toBe("object");
  });

  it("accepts every envelope a formatted call can return", () => {
    expect(structured.parse({ rows })).toEqual({ rows });
    expect(structured.parse({ meta, rows })).toEqual({ meta, rows });
    expect(structured.parse(summary)).toMatchObject({ kind: "ranked", reading: summary.reading });
  });

  it("still holds the rows to the registry's row schema", () => {
    // ADR 0051 §2: the collector coerces at the store edge, so a string-encoded
    // count is a contract violation, not something to repair here.
    const bad = structured.safeParse({ rows: [{ mesh: "buy", count: "12" }] });
    expect(bad.success).toBe(false);
    expect(bad.error?.issues[0]?.path).toEqual(["rows", 0, "count"]);
  });

  it("still holds a table envelope's meta to its shape", () => {
    expect(structured.safeParse({ meta: { ...meta, truncated: "no" }, rows }).success).toBe(false);
  });

  it("keeps an envelope key it does not know rather than dropping it", () => {
    const parsed = structured.parse({ rows, note: "from a newer collector" });
    expect(parsed).toEqual({ rows, note: "from a newer collector" });
  });
});
