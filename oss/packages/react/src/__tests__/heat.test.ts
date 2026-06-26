import { describe, expect, it } from "vitest";
import { percentileMax } from "../heat";

describe("percentileMax (ADR 0040 §2 robust normalization)", () => {
  it("returns 1 for an empty set (never a zero divisor)", () => {
    expect(percentileMax([])).toBe(1);
  });

  it("clamps to at least 1 for tiny counts", () => {
    expect(percentileMax([0, 0, 0])).toBe(1);
  });

  it("ignores a single hot outlier at the default p95", () => {
    // 19 modest cells and one 1000-hit spike: p95 lands on the modest band, not
    // the spike, so the rest of the scene keeps its contrast.
    const counts = [...Array(19).fill(10), 1000];
    expect(percentileMax(counts, 0.95)).toBeLessThan(100);
    expect(percentileMax(counts, 0.95)).toBeGreaterThanOrEqual(10);
  });

  it("matches the global max at p = 1", () => {
    expect(percentileMax([1, 2, 3, 4, 100], 1)).toBe(100);
  });

  it("interpolates between ranks for the median", () => {
    expect(percentileMax([0, 10, 20, 30], 0.5)).toBe(15);
  });

  it("is order-independent", () => {
    expect(percentileMax([30, 0, 20, 10], 0.5)).toBe(15);
  });
});
