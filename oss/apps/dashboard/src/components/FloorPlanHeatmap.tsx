"use client";

import { useEffect, useRef } from "react";
import type { PositionBin } from "@/lib/api";
import { heatColor } from "@/lib/format";
import { HeatLegend } from "./HeatLegend";
import { Panel } from "./Panel";

const SIZE = 360;
const PAD = 8;

export const FLOOR_PLAN_TITLE = "Floor-plan heatmap";
export const FLOOR_PLAN_SUBTITLE = "Where visitors stand (top-down, first-person)";
export const FLOOR_PLAN_HELP =
  "Camera positions binned on the ground plane — the first-person counterpart of the pointer heatmap. Filter to the first-person camera mode to isolate walkable sessions.";

/**
 * Top-down "floor plan" camera-position heatmap (ADR 0026): the first-person
 * analog of the 2D pointer heatmap. Each cell is a `cellSize`-sized square on
 * the X/Z ground plane (`gx`, `gz` integer indices); intensity is the dwell
 * `count`. The bins' bounding box is auto-fit into the canvas so a walkable
 * scene of any extent reads at a glance — where visitors stand and linger.
 *
 * This is the panel BODY only (no chrome); the host supplies title/subtitle/help
 * via the ADR 0036 panel contract. {@link FloorPlanHeatmap} wraps it in panel
 * chrome for legacy call sites.
 */
export function FloorPlanHeatmapView({
  bins,
  cellSize,
}: {
  bins: PositionBin[];
  cellSize: number;
}) {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    ctx.clearRect(0, 0, SIZE, SIZE);
    ctx.fillStyle = "#0b0e14";
    ctx.fillRect(0, 0, SIZE, SIZE);

    if (bins.length === 0) return;

    // Auto-fit the occupied cell bounding box into the canvas (cells can be
    // negative; walkable scenes are not centered on the origin).
    let minX = Infinity;
    let maxX = -Infinity;
    let minZ = Infinity;
    let maxZ = -Infinity;
    let max = 0;
    for (const b of bins) {
      if (b.gx < minX) minX = b.gx;
      if (b.gx > maxX) maxX = b.gx;
      if (b.gz < minZ) minZ = b.gz;
      if (b.gz > maxZ) maxZ = b.gz;
      if (b.count > max) max = b.count;
    }
    const spanX = maxX - minX + 1;
    const spanZ = maxZ - minZ + 1;
    const span = Math.max(spanX, spanZ);
    const cell = (SIZE - PAD * 2) / span;

    for (const b of bins) {
      const t = max > 0 ? b.count / max : 0;
      ctx.fillStyle = heatColor(t, 0.9);
      // Flip Z so "north" (smaller world Z) is at the top of the plan.
      const px = PAD + (b.gx - minX) * cell;
      const py = PAD + (maxZ - b.gz) * cell;
      ctx.fillRect(px, py, Math.ceil(cell), Math.ceil(cell));
    }
  }, [bins, cellSize]);

  return (
    <>
      <div className="flex justify-center">
        <div className="relative inline-block">
          <canvas
            ref={ref}
            width={SIZE}
            height={SIZE}
            className="rounded-lg border border-edge"
            aria-label="Floor-plan position heatmap"
          />
          {bins.length > 0 ? (
            <HeatLegend
              title="Dwell density"
              lowLabel="rarely"
              highLabel="most"
              note={`${cellSize} m cells`}
            />
          ) : null}
        </div>
      </div>
      {bins.length === 0 ? (
        <p className="mt-2 text-center text-xs text-fg-muted">
          No camera-position data in range. Capture a first-person session to populate the plan.
        </p>
      ) : null}
    </>
  );
}

/** Chrome-wrapped floor plan for legacy call sites (overview surface). */
export function FloorPlanHeatmap({ bins, cellSize }: { bins: PositionBin[]; cellSize: number }) {
  return (
    <Panel title={FLOOR_PLAN_TITLE} subtitle={FLOOR_PLAN_SUBTITLE} help={FLOOR_PLAN_HELP}>
      <FloorPlanHeatmapView bins={bins} cellSize={cellSize} />
    </Panel>
  );
}
