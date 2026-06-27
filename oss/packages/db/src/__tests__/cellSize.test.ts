/**
 * Unit tests for the bounds-driven default voxel size (ADR 0040 §1).
 */

import { describe, expect, it } from "vitest";
import { defaultCellSizeForBounds } from "../index.js";

describe("defaultCellSizeForBounds", () => {
  it("sizes cells so the longest axis spans ~targetCells", () => {
    // Longest axis is X (64 units); 64 / 64 = 1 unit per cell.
    expect(defaultCellSizeForBounds([0, 0, 0, 64, 4, 8], 64)).toBe(1);
    // A 640-unit scene needs 10-unit cells to keep ~64 across the long axis.
    expect(defaultCellSizeForBounds([-320, 0, -10, 320, 2, 10], 64)).toBe(10);
  });

  it("honors a custom target cell count", () => {
    expect(defaultCellSizeForBounds([0, 0, 0, 32, 1, 1], 32)).toBe(1);
  });

  it("returns null for missing or degenerate bounds", () => {
    expect(defaultCellSizeForBounds(null)).toBeNull();
    expect(defaultCellSizeForBounds(undefined)).toBeNull();
    // Zero-volume box: longest axis is 0.
    expect(defaultCellSizeForBounds([1, 1, 1, 1, 1, 1])).toBeNull();
    // Inverted box: negative longest axis.
    expect(defaultCellSizeForBounds([5, 5, 5, 0, 0, 0])).toBeNull();
    // Non-positive target.
    expect(defaultCellSizeForBounds([0, 0, 0, 10, 10, 10], 0)).toBeNull();
  });
});
