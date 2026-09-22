/**
 * Shape gates for the declarative panel spec (ADR 0051 §7, design sketch §G.3).
 *
 * As with the query DSL, this suite is about the *grammar*: that it is closed,
 * bounded, versioned, and that `range: "inherit"` is a first-class member of
 * the union rather than a magic string some consumer has to remember. Whether
 * `line` is a sensible chart for `top_meshes` is a question about the metric
 * registry, and is tested in `@uptimizr/metrics`.
 */

import { describe, expect, it } from "vitest";
import { LIMITS } from "../limits.js";
import {
  PANEL_RANGE_INHERIT,
  panelChartKindSchema,
  panelSpecV1Schema,
  resolvePanelSpecRange,
} from "../panelSpec.js";

const RANGE = { since: 1_757_000_000_000, until: 1_757_600_000_000 };

/** The smallest spec that parses. */
function minimal(): Record<string, unknown> {
  return {
    v: 1,
    title: "Top meshes",
    query: { v: 1, metric: "top_meshes", range: PANEL_RANGE_INHERIT },
    chart: "bar",
  };
}

describe("panelSpecV1Schema", () => {
  it("accepts the minimal spec and defaults span to 1", () => {
    const parsed = panelSpecV1Schema.parse(minimal());
    expect(parsed.span).toBe(1);
    expect(parsed.chart).toBe("bar");
    expect(parsed.query.range).toBe("inherit");
    expect(parsed.note).toBeUndefined();
  });

  it("accepts an explicit pinned window as well as `inherit`", () => {
    const pinned = panelSpecV1Schema.parse({
      ...minimal(),
      query: { v: 1, metric: "top_meshes", range: RANGE },
    });
    expect(pinned.query.range).toEqual(RANGE);
  });

  it("rejects a range that is neither `inherit` nor a bounded window", () => {
    for (const range of ["last-week", { since: RANGE.since }, { since: 20, until: 10 }, null]) {
      const result = panelSpecV1Schema.safeParse({
        ...minimal(),
        query: { v: 1, metric: "top_meshes", range },
      });
      expect(result.success, JSON.stringify(range)).toBe(false);
    }
  });

  it("pins the grammar version so a future shape cannot masquerade as this one", () => {
    expect(panelSpecV1Schema.safeParse({ ...minimal(), v: 2 }).success).toBe(false);
    expect(panelSpecV1Schema.safeParse({ ...minimal(), v: undefined }).success).toBe(false);
  });

  it("closes the chart vocabulary — a chart the catalog cannot draw is a parse error", () => {
    expect(panelChartKindSchema.options).toEqual([
      "stat",
      "table",
      "bar",
      "line",
      "area",
      "heatmap2d",
      "world3d",
    ]);
    expect(panelSpecV1Schema.safeParse({ ...minimal(), chart: "pie" }).success).toBe(false);
    expect(panelSpecV1Schema.safeParse({ ...minimal(), chart: "sankey" }).success).toBe(false);
  });

  it("rejects unknown keys at every level — the document is closed", () => {
    expect(panelSpecV1Schema.safeParse({ ...minimal(), script: "alert(1)" }).success).toBe(false);
    expect(
      panelSpecV1Schema.safeParse({ ...minimal(), encoding: { x: "mesh", colour: "count" } })
        .success,
    ).toBe(false);
    expect(
      panelSpecV1Schema.safeParse({
        ...minimal(),
        query: { v: 1, metric: "top_meshes", range: PANEL_RANGE_INHERIT, sql: "SELECT 1" },
      }).success,
    ).toBe(false);
  });

  it("drops `format` and `explain` — a panel renders rows, not an envelope or a plan", () => {
    for (const extra of [{ format: "summary" }, { explain: true }]) {
      const result = panelSpecV1Schema.safeParse({
        ...minimal(),
        query: { v: 1, metric: "top_meshes", range: PANEL_RANGE_INHERIT, ...extra },
      });
      expect(result.success, JSON.stringify(extra)).toBe(false);
    }
  });

  it("inherits the DSL's own bounds rather than restating them", () => {
    // `limit` is capped by `queryV1Schema`; the panel spec must not have loosened
    // it by rebuilding the query grammar by hand.
    const over = panelSpecV1Schema.safeParse({
      ...minimal(),
      query: { v: 1, metric: "top_meshes", range: PANEL_RANGE_INHERIT, limit: 100_000 },
    });
    expect(over.success).toBe(false);
  });

  it("bounds the title, the note and every encoding column", () => {
    const long = (n: number) => "x".repeat(n);
    expect(
      panelSpecV1Schema.safeParse({ ...minimal(), title: long(LIMITS.maxPanelSpecTitleLength) })
        .success,
    ).toBe(true);
    expect(
      panelSpecV1Schema.safeParse({ ...minimal(), title: long(LIMITS.maxPanelSpecTitleLength + 1) })
        .success,
    ).toBe(false);
    expect(panelSpecV1Schema.safeParse({ ...minimal(), title: "" }).success).toBe(false);
    expect(
      panelSpecV1Schema.safeParse({ ...minimal(), note: long(LIMITS.maxPanelSpecNoteLength + 1) })
        .success,
    ).toBe(false);
    expect(
      panelSpecV1Schema.safeParse({
        ...minimal(),
        encoding: { x: long(LIMITS.maxPanelEncodingColumnLength + 1) },
      }).success,
    ).toBe(false);
  });

  it("is bounded by construction — the largest spec the grammar admits is small", () => {
    // Unlike a saved analysis, whose `query` is an opaque record and needs an
    // explicit serialized-length cap, a panel spec has no open field: every leaf
    // is bounded by this file or by `queryV1`. So the stored row needs no
    // document-length refinement, and this pins that the claim is true — the
    // fattest document the grammar accepts is still a few KB, not a blob.
    const fattest = panelSpecV1Schema.parse({
      v: 1,
      title: "x".repeat(LIMITS.maxPanelSpecTitleLength),
      chart: "bar",
      span: 2,
      note: "y".repeat(LIMITS.maxPanelSpecNoteLength),
      encoding: {
        x: "a".repeat(LIMITS.maxPanelEncodingColumnLength),
        y: "b".repeat(LIMITS.maxPanelEncodingColumnLength),
        series: "c".repeat(LIMITS.maxPanelEncodingColumnLength),
      },
      query: {
        v: 1,
        metric: "funnel",
        range: PANEL_RANGE_INHERIT,
        dimensions: ["mesh", "source", "scene"],
        filters: {
          steps: Array.from({ length: 20 }, () => ({ type: "custom", name: "z".repeat(128) })),
        },
      },
    });
    expect(JSON.stringify(fattest).length).toBeLessThan(8_000);
  });

  it("allows only the two grid widths the panel contract has", () => {
    expect(panelSpecV1Schema.safeParse({ ...minimal(), span: 2 }).success).toBe(true);
    expect(panelSpecV1Schema.safeParse({ ...minimal(), span: 3 }).success).toBe(false);
    expect(panelSpecV1Schema.safeParse({ ...minimal(), span: 0 }).success).toBe(false);
  });
});

describe("resolvePanelSpecRange", () => {
  const active = { since: 1_000, until: 2_000 };

  it("substitutes the host's active window for `inherit`", () => {
    expect(resolvePanelSpecRange(PANEL_RANGE_INHERIT, active)).toEqual(active);
  });

  it("leaves a pinned window alone — that spec is about one period, not `now`", () => {
    expect(resolvePanelSpecRange(RANGE, active)).toEqual(RANGE);
  });
});
