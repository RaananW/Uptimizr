"use client";

import type { HeatmapBin } from "@/lib/api";
import { PointerHeatmapCanvas } from "@uptimizr/react";
import { Panel } from "./Panel";

/**
 * 2D pointer heatmap. The canvas rendering is the shared
 * {@link PointerHeatmapCanvas} from `@uptimizr/react`; this component only adds
 * the dashboard panel chrome around it.
 */
export function PointerHeatmap({ bins, gridSize }: { bins: HeatmapBin[]; gridSize: number }) {
  return (
    <Panel title="Pointer heatmap" subtitle="Normalized screen positions">
      <div className="flex justify-center">
        <PointerHeatmapCanvas
          bins={bins}
          gridSize={gridSize}
          className="rounded-lg border border-edge"
        />
      </div>
    </Panel>
  );
}
