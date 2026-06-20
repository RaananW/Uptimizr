import { describe, expect, it } from "vitest";
import { drawDirectionHeatmap, drawPointerHeatmap } from "../draw";

/** A minimal 2D-context spy that records the calls the painters make. */
function fakeContext() {
  const calls: string[] = [];
  const rects: Array<[number, number, number, number]> = [];
  const ctx = {
    fillStyle: "",
    strokeStyle: "",
    lineWidth: 0,
    font: "",
    textAlign: "",
    textBaseline: "",
    clearRect: () => calls.push("clearRect"),
    fillRect: (x: number, y: number, w: number, h: number) => {
      calls.push("fillRect");
      rects.push([x, y, w, h]);
    },
    beginPath: () => calls.push("beginPath"),
    closePath: () => calls.push("closePath"),
    arc: () => calls.push("arc"),
    moveTo: () => calls.push("moveTo"),
    lineTo: () => calls.push("lineTo"),
    stroke: () => calls.push("stroke"),
    fill: () => calls.push("fill"),
    strokeText: () => calls.push("strokeText"),
    fillText: () => calls.push("fillText"),
  };
  return { ctx: ctx as unknown as CanvasRenderingContext2D, calls, rects };
}

describe("drawPointerHeatmap", () => {
  it("clears + paints a background and one rect per bin", () => {
    const { ctx, calls, rects } = fakeContext();
    drawPointerHeatmap(
      ctx,
      [
        { gx: 0, gy: 0, count: 1 },
        { gx: 1, gy: 2, count: 4 },
      ],
      4,
      320,
    );
    expect(calls[0]).toBe("clearRect");
    // 1 background fill + 2 cell fills.
    expect(rects).toHaveLength(3);
    // The hottest bin lands at grid (1,2) with cell size 80.
    expect(rects[2]?.slice(0, 2)).toEqual([80, 160]);
  });

  it("paints only the background when there are no bins", () => {
    const { ctx, rects } = fakeContext();
    drawPointerHeatmap(ctx, [], 4, 320);
    expect(rects).toHaveLength(1);
  });
});

describe("drawDirectionHeatmap", () => {
  it("draws the sphere rings and a wedge per bin", () => {
    const { ctx, calls } = fakeContext();
    drawDirectionHeatmap(ctx, [{ azimuth_bin: 0, elevation_bin: 0, count: 3 }], 8, 340);
    // Two outline rings (arc) + the wedge fill.
    expect(calls.filter((c) => c === "arc").length).toBeGreaterThanOrEqual(3);
    expect(calls).toContain("fill");
    // Axis labels are drawn.
    expect(calls.filter((c) => c === "fillText").length).toBeGreaterThanOrEqual(3);
  });
});
