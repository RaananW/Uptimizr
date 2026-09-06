"use client";

import type { DirectionBin } from "../../api";
import { HEAT_GRADIENT } from "../../heat";
import { ViewDirectionHeatmapCanvas } from "../../panels/views";

export const VIEW_DIRECTION_TITLE = "View-direction heatmap";
export const VIEW_DIRECTION_SUBTITLE = "Top-down sphere — center = looking up, rim = looking down";
export const VIEW_DIRECTION_HELP = (
  <>
    A flattened top-down view of where the camera pointed. <strong>Distance from the center</strong>{" "}
    is the up/down tilt: the <strong>center</strong> is looking straight up, the{" "}
    <strong>middle ring</strong> is the horizon (level), and the <strong>outer rim</strong> is
    looking straight down. The <strong>angle around the disc</strong> is the facing (azimuth)
    direction. Color shows how often each direction was viewed, normalized to the most-viewed
    direction in range.
  </>
);

/**
 * View-direction heatmap on an abstract sphere, drawn as a polar (top-down)
 * projection: azimuth maps to the angle around the disc, elevation to radius
 * (straight up at the center, straight down at the rim). The canvas rendering is
 * the shared {@link ViewDirectionHeatmapCanvas}; this view adds the legend.
 * Panel BODY only (no chrome); the host supplies title/subtitle/help via the
 * ADR 0036 panel contract.
 */
export function ViewDirectionHeatmapView({
  bins,
  gridSize,
}: {
  bins: DirectionBin[];
  gridSize: number;
}) {
  return (
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
  );
}
