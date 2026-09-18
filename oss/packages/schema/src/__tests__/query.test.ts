/**
 * Shape gates for the query DSL (ADR 0051 §3, design sketch §C.1).
 *
 * This suite is about the *grammar*, not the vocabulary: that it is closed
 * (unknown keys rejected, no free-form value anywhere), bounded (limit,
 * dimension count, string lengths), and that its two defaults are what the DSL
 * promises. Whether a metric exists and accepts a given filter is
 * `@uptimizr/metrics`' question, and is tested there.
 */

import { describe, expect, it } from "vitest";
import { QUERY_MAX_DIMENSIONS, QUERY_MAX_LIMIT, queryV1Schema } from "../query.js";

const RANGE = { since: 1_757_000_000_000, until: 1_757_600_000_000 };

/** The smallest query that parses. */
function minimal(): Record<string, unknown> {
  return { v: 1, metric: "top_meshes", range: RANGE };
}

describe("queryV1Schema", () => {
  it("accepts the minimal query and defaults format to table and explain to false", () => {
    const parsed = queryV1Schema.parse(minimal());
    expect(parsed.format).toBe("table");
    expect(parsed.explain).toBe(false);
    expect(parsed.metric).toBe("top_meshes");
  });

  it("requires a bounded time range with both ends", () => {
    expect(queryV1Schema.safeParse({ v: 1, metric: "top_meshes" }).success).toBe(false);
    expect(queryV1Schema.safeParse({ ...minimal(), range: { since: RANGE.since } }).success).toBe(
      false,
    );
    // An unbounded "since the beginning of time" query is exactly what a bounded
    // DSL must not allow, so an inverted or empty window is rejected too.
    expect(queryV1Schema.safeParse({ ...minimal(), range: { since: 10, until: 10 } }).success).toBe(
      false,
    );
    expect(queryV1Schema.safeParse({ ...minimal(), range: { since: 20, until: 10 } }).success).toBe(
      false,
    );
  });

  it("pins the grammar version so a future grammar cannot masquerade as this one", () => {
    expect(queryV1Schema.safeParse({ ...minimal(), v: 2 }).success).toBe(false);
    expect(queryV1Schema.safeParse({ ...minimal(), v: undefined }).success).toBe(false);
  });

  it("rejects unknown top-level keys and unknown filters — the grammar is closed", () => {
    expect(queryV1Schema.safeParse({ ...minimal(), sql: "SELECT 1" }).success).toBe(false);
    expect(queryV1Schema.safeParse({ ...minimal(), filters: { where: "1=1" } }).success).toBe(
      false,
    );
  });

  it("bounds the row cap and the dimension count", () => {
    expect(queryV1Schema.safeParse({ ...minimal(), limit: QUERY_MAX_LIMIT }).success).toBe(true);
    expect(queryV1Schema.safeParse({ ...minimal(), limit: QUERY_MAX_LIMIT + 1 }).success).toBe(
      false,
    );
    expect(queryV1Schema.safeParse({ ...minimal(), limit: 0 }).success).toBe(false);
    const dims = Array.from({ length: QUERY_MAX_DIMENSIONS + 1 }, () => "mesh");
    expect(queryV1Schema.safeParse({ ...minimal(), dimensions: dims }).success).toBe(false);
  });

  it("validates identifiers structurally, leaving membership to the registry", () => {
    // Shape only: `not_a_metric` is a well-formed id and parses here. The
    // registry rejects it (see `@uptimizr/metrics`' query suite).
    expect(queryV1Schema.safeParse({ ...minimal(), metric: "not_a_metric" }).success).toBe(true);
    expect(queryV1Schema.safeParse({ ...minimal(), metric: "DROP TABLE" }).success).toBe(false);
    expect(queryV1Schema.safeParse({ ...minimal(), metric: "" }).success).toBe(false);
    expect(queryV1Schema.safeParse({ ...minimal(), dimensions: ["device.os"] }).success).toBe(true);
    expect(queryV1Schema.safeParse({ ...minimal(), dimensions: ["mesh; --"] }).success).toBe(false);
  });

  it("takes a region as either a registered id or an explicit box", () => {
    expect(
      queryV1Schema.safeParse({ ...minimal(), filters: { region: "checkout-counter" } }).success,
    ).toBe(true);
    expect(
      queryV1Schema.safeParse({ ...minimal(), filters: { region: [0, 0, 0, 1, 1, 1] } }).success,
    ).toBe(true);
    expect(queryV1Schema.safeParse({ ...minimal(), filters: { region: [0, 0, 0] } }).success).toBe(
      false,
    );
  });

  it("takes funnel steps as real JSON rather than a string to re-parse", () => {
    const steps = [{ type: "session_start" }, { type: "mesh_interaction", mesh: "buy" }];
    expect(queryV1Schema.safeParse({ ...minimal(), filters: { steps } }).success).toBe(true);
    // A single step is not a funnel, and neither is a JSON-encoded string.
    expect(
      queryV1Schema.safeParse({ ...minimal(), filters: { steps: steps.slice(0, 1) } }).success,
    ).toBe(false);
    expect(
      queryV1Schema.safeParse({ ...minimal(), filters: { steps: JSON.stringify(steps) } }).success,
    ).toBe(false);
  });

  it("parses the deferred grammar so a v1 client and a later one write the same document", () => {
    const parsed = queryV1Schema.parse({
      ...minimal(),
      segment: { "device.os": "iOS" },
      compare: { range: { since: 1, until: 2 } },
      order: { by: "count", dir: "desc" },
      explain: true,
      filters: { event: { type: "mesh_interaction" }, device: { os: "iOS" } },
    });
    expect(parsed.compare).toEqual({ range: { since: 1, until: 2 } });
    expect(parsed.explain).toBe(true);
    expect(parsed.filters?.device?.os).toBe("iOS");
  });
});
