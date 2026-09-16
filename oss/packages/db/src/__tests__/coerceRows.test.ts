/**
 * Unit tests for numeric coercion at the store edge (ADR 0051 §2).
 *
 * The behaviour these pin down is the contract every store runner relies on:
 * what counts as a numeric column, what `null` means, what happens to junk under
 * test versus in production, and the allocation-free fast path that keeps the
 * three engines which already return numbers from paying for the guarantee.
 */

import { describe, expect, it, beforeEach } from "vitest";
import { z } from "zod";
import {
  coerceRows,
  numericColumns,
  numericColumnsOfMetric,
  resetCoercionWarnings,
} from "../query/coerce.js";
import { getMetric } from "../query/registry.js";

describe("numericColumns", () => {
  it("finds numbers through nullable, optional and default wrappers", () => {
    const row = z.object({
      count: z.number(),
      bin: z.number().int(),
      maybe: z.number().nullable(),
      absent: z.number().optional(),
      both: z.number().nullable().optional(),
      defaulted: z.number().default(0),
      name: z.string(),
      day: z.string(),
      flag: z.boolean(),
    });
    expect([...numericColumns(row)].sort()).toEqual([
      "absent",
      "bin",
      "both",
      "count",
      "defaulted",
      "maybe",
    ]);
  });

  it("reads the registry row schema of a real metric", () => {
    expect([...numericColumnsOfMetric("top_meshes")]).toEqual(["count"]);
    expect([...numericColumnsOfMetric("pointer_heatmap")].sort()).toEqual(["count", "gx", "gy"]);
    // `list_sessions` is id/timestamp text apart from the event count.
    expect([...numericColumnsOfMetric("list_sessions")]).toEqual(["events"]);
    expect(numericColumnsOfMetric(undefined)).toEqual([]);
    expect(numericColumnsOfMetric("not_a_metric" as never)).toEqual([]);
  });
});

describe("coerceRows", () => {
  beforeEach(() => {
    resetCoercionWarnings();
  });

  it("parses string-encoded integers and floats", () => {
    const rows = coerceRows("perf_summary", [
      { samples: "12", avg_fps: "59.5", min_fps: "-0.25", p50_fps: "6e1" },
    ]);
    expect(rows).toEqual([{ samples: 12, avg_fps: 59.5, min_fps: -0.25, p50_fps: 60 }]);
    for (const value of Object.values(rows[0]!)) expect(typeof value).toBe("number");
  });

  it("leaves null and undefined alone — absence is not zero", () => {
    const rows = coerceRows("perf_summary", [
      { samples: 0, avg_fps: null, min_fps: undefined, p50_fps: "30" },
    ]);
    expect(rows[0]).toEqual({ samples: 0, avg_fps: null, min_fps: undefined, p50_fps: 30 });
  });

  it("ignores columns the registry does not declare numeric", () => {
    const rows = coerceRows("list_sessions", [
      { session_id: "42", visitor_id: "7", events: "3", started_at: "2024-01-01 00:00:00.000" },
    ]);
    expect(rows[0]).toEqual({
      session_id: "42",
      visitor_id: "7",
      events: 3,
      started_at: "2024-01-01 00:00:00.000",
    });
  });

  it("passes untagged, unknown and empty inputs straight through", () => {
    const rows = [{ count: "1" }];
    expect(coerceRows(undefined, rows)).toBe(rows);
    expect(coerceRows("not_a_metric" as never, rows)).toBe(rows);
    expect(coerceRows("top_meshes", [])).toEqual([]);
  });

  it("returns the very same array when nothing needs coercing", () => {
    const rows = [
      { mesh: "box", count: 3 },
      { mesh: "sphere", count: 1 },
    ];
    expect(coerceRows("top_meshes", rows)).toBe(rows);
  });

  it("clones only the rows it changes", () => {
    const untouched = { mesh: "box", count: 3 };
    const wire = { mesh: "sphere", count: "1" };
    const out = coerceRows("top_meshes", [untouched, wire]);
    expect(out).not.toBe(undefined);
    expect(out[0]).toBe(untouched);
    expect(out[1]).not.toBe(wire);
    expect(out[1]).toEqual({ mesh: "sphere", count: 1 });
    // The input row is not mutated — a caller holding it sees what the driver gave.
    expect(wire.count).toBe("1");
  });

  it("accepts a resolved MetricDefinition as well as an id", () => {
    const metric = getMetric("top_meshes")!;
    expect(coerceRows(metric, [{ mesh: "box", count: "9" }])).toEqual([{ mesh: "box", count: 9 }]);
  });

  describe("junk policy", () => {
    it("throws under a test runner, naming the metric, column and value", () => {
      expect(() => coerceRows("top_meshes", [{ mesh: "box", count: "not-a-number" }])).toThrow(
        /top_meshes\.count is declared numeric but received "not-a-number" \(string\)/,
      );
    });

    it("treats a non-finite string as junk — JSON carries no Infinity or NaN", () => {
      expect(() => coerceRows("top_meshes", [{ mesh: "box", count: "Infinity" }])).toThrow(
        /top_meshes\.count/,
      );
      expect(() => coerceRows("top_meshes", [{ mesh: "box", count: "" }])).toThrow(
        /top_meshes\.count/,
      );
    });

    it("treats a non-string, non-number value as junk too", () => {
      expect(() => coerceRows("top_meshes", [{ mesh: "box", count: true }])).toThrow(
        /top_meshes\.count is declared numeric but received true \(boolean\)/,
      );
    });

    it("leaves junk untouched and warns once per column when not strict", () => {
      const warnings: string[] = [];
      const rows = coerceRows(
        "top_meshes",
        [
          { mesh: "a", count: "junk" },
          { mesh: "b", count: "also junk" },
          { mesh: "c", count: "4" },
        ],
        { strict: false, onWarn: (message) => warnings.push(message) },
      );
      expect(rows.map((row) => row.count)).toEqual(["junk", "also junk", 4]);
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain("top_meshes.count");
      expect(warnings[0]).toContain("leaving it untouched");

      // A second call for the same column stays silent; a different column warns.
      coerceRows("top_meshes", [{ mesh: "d", count: "junk" }], {
        strict: false,
        onWarn: (message) => warnings.push(message),
      });
      expect(warnings).toHaveLength(1);

      coerceRows("pointer_heatmap", [{ gx: "junk", gy: 0, count: 0 }], {
        strict: false,
        onWarn: (message) => warnings.push(message),
      });
      expect(warnings).toHaveLength(2);
      expect(warnings[1]).toContain("pointer_heatmap.gx");
    });

    it("still coerces the good columns of a row that has a junk one", () => {
      const rows = coerceRows("pointer_heatmap", [{ gx: "junk", gy: "3", count: "7" }], {
        strict: false,
        onWarn: () => {},
      });
      expect(rows[0]).toEqual({ gx: "junk", gy: 3, count: 7 });
    });
  });
});
