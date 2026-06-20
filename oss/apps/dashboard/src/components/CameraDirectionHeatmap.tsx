"use client";

import type { DirectionBin } from "@/lib/api";
import { ViewDirectionHeatmapCanvas } from "@uptimizr/react";
import { HEAT_GRADIENT } from "@/lib/heat";
import { Panel } from "./Panel";

/**
 * View-direction heatmap on an abstract sphere, drawn as a polar (top-down)
 * projection: azimuth maps to the angle around the disc, elevation to radius
 * (straight up at the center, straight down at the rim). The canvas rendering is
 * the shared {@link ViewDirectionHeatmapCanvas} from `@uptimizr/react`; this
 * component only adds the dashboard chrome (help, legend) around it.
 */
export function CameraDirectionHeatmap({
  bins,
  gridSize,
}: {
  bins: DirectionBin[];
  gridSize: number;
}) {
  return (
    <Panel
      title="View-direction heatmap"
      subtitle="Top-down sphere — center = looking up, rim = looking down"
      help={
        <>
          A flattened top-down view of where the camera pointed.{" "}
          <strong>Distance from the center</strong> is the up/down tilt: the <strong>center</strong>{" "}
          is looking straight up, the <strong>middle ring</strong> is the horizon (level), and the{" "}
          <strong>outer rim</strong> is looking straight down. The{" "}
          <strong>angle around the disc</strong> is the facing (azimuth) direction. Color shows how
          often each direction was viewed, normalized to the most-viewed direction in range.
        </>
      }
    >
      <div className="flex flex-col items-center gap-3">
        <ViewDirectionHeatmapCanvas
          bins={bins}
          gridSize={gridSize}
          className="rounded-lg border border-edge"
        />
        {bins.length > 0 ? (
          <div className="flex items-center gap-2 text-[10px] text-fg-muted">
            <span className="font-medium text-fg">View density</span>
            <span>rarely</span>
            <span className="h-2 w-28 rounded-sm" style={{ background: HEAT_GRADIENT }} />
            <span>most-viewed</span>
          </div>
        ) : null}
      </div>
    </Panel>
  );
}
