import { describe, expect, it } from "vitest";
import { renderHook } from "@testing-library/react";
import { sameItems, useStableArray } from "../stableArray";

describe("sameItems", () => {
  it("compares items, not array identity", () => {
    const a = { id: 1 };
    expect(sameItems([a, "x"], [a, "x"])).toBe(true);
    expect(sameItems([a], [{ id: 1 }])).toBe(false);
    expect(sameItems([1, 2], [1, 2, 3])).toBe(false);
    expect(sameItems([], [])).toBe(true);
    expect(sameItems(undefined, undefined)).toBe(true);
    expect(sameItems(undefined, [])).toBe(false);
  });
});

describe("useStableArray", () => {
  it("keeps the first array while re-renders pass equal copies", () => {
    const first = ["a", "b"];
    const { result, rerender } = renderHook(({ v }) => useStableArray(v), {
      initialProps: { v: first },
    });
    rerender({ v: ["a", "b"] });
    rerender({ v: ["a", "b"] });
    expect(result.current).toBe(first);
  });

  it("takes the new array once its contents change", () => {
    const { result, rerender } = renderHook(({ v }) => useStableArray(v), {
      initialProps: { v: ["a"] },
    });
    const next = ["a", "b"];
    rerender({ v: next });
    expect(result.current).toBe(next);
  });
});
