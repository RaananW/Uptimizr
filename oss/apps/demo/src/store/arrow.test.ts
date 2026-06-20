import { describe, expect, it } from "vitest";
import { convertArrowValue, tableToRows, type ArrowTableLike } from "./arrow.js";

/** Apache Arrow `Type` enum ids used by DuckDB-Wasm result schemas. */
const TIMESTAMP = 10;
const INT = 2;

/** Build a minimal {@link ArrowTableLike} from plain row objects + field types. */
function fakeTable(
  fields: ReadonlyArray<{ name: string; typeId: number }>,
  rows: ReadonlyArray<Record<string, unknown>>,
): ArrowTableLike {
  return {
    numRows: rows.length,
    schema: { fields: fields.map((f) => ({ name: f.name, type: { typeId: f.typeId } })) },
    get: (i: number) => rows[i],
  };
}

describe("convertArrowValue", () => {
  it("narrows bigint (BIGINT / COUNT) to number", () => {
    expect(convertArrowValue(42n)).toBe(42);
  });

  it("recursively converts list vectors via toArray()", () => {
    const vector = { toArray: () => [1, 2n, 3] };
    expect(convertArrowValue(vector)).toEqual([1, 2, 3]);
  });

  it("passes scalars through and maps null/undefined to null", () => {
    expect(convertArrowValue("free")).toBe("free");
    expect(convertArrowValue(0.5)).toBe(0.5);
    expect(convertArrowValue(null)).toBeNull();
    expect(convertArrowValue(undefined)).toBeNull();
  });
});

describe("tableToRows temporal handling", () => {
  it("formats TIMESTAMP columns (epoch-ms numbers) to naive-UTC strings", () => {
    // 2026-06-20T18:49:55.727Z as epoch-ms — the shape DuckDB-Wasm yields.
    const ms = Date.UTC(2026, 5, 20, 18, 49, 55, 727);
    const table = fakeTable(
      [
        { name: "started_at", typeId: TIMESTAMP },
        { name: "events", typeId: INT },
      ],
      [{ started_at: ms, events: 15n }],
    );
    const rows = tableToRows<{ started_at: string; events: number }>(table);
    expect(rows[0]?.started_at).toBe("2026-06-20 18:49:55.727");
    // Counts in the same row stay numeric (regression guard for the dashboard).
    expect(rows[0]?.events).toBe(15);
  });

  it("formats a Date-valued TIMESTAMP column too", () => {
    const table = fakeTable(
      [{ name: "ts", typeId: TIMESTAMP }],
      [{ ts: new Date(Date.UTC(2024, 0, 2, 3, 4, 5, 6)) }],
    );
    const rows = tableToRows<{ ts: string }>(table);
    expect(rows[0]?.ts).toBe("2024-01-02 03:04:05.006");
  });

  it("leaves non-temporal numeric columns untouched", () => {
    const table = fakeTable([{ name: "vx", typeId: 11 /* Float */ }], [{ vx: 1781981003796 }]);
    const rows = tableToRows<{ vx: number }>(table);
    expect(rows[0]?.vx).toBe(1781981003796);
  });
});
