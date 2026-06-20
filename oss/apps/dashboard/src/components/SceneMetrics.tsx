"use client";

import type { CameraDistanceBucket, CoverageVoxel, NavigationStat } from "@/lib/api";
import { formatNumber } from "@/lib/format";
import { Panel } from "./Panel";

/** A single labelled metric tile. */
function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="rounded-lg border border-edge bg-ink/40 px-3 py-2.5">
      <p className="text-xs uppercase tracking-wide text-fg-muted">{label}</p>
      <p className="mt-0.5 text-lg font-semibold tabular-nums text-fg-hi">{value}</p>
      {hint ? <p className="text-[11px] text-fg-muted">{hint}</p> : null}
    </div>
  );
}

/** Compact horizontal-bar histogram of the camera-distance distribution (#39). */
function DistanceHistogram({
  buckets,
  bucketSize,
}: {
  buckets: CameraDistanceBucket[];
  bucketSize: number;
}) {
  if (buckets.length === 0) {
    return <p className="text-sm text-fg-muted">No camera samples in range.</p>;
  }
  const sorted = [...buckets].sort((a, b) => a.bucket - b.bucket);
  const max = sorted.reduce((m, b) => Math.max(m, b.count), 0) || 1;
  return (
    <div className="flex flex-col gap-1">
      {sorted.map((b) => {
        const from = b.bucket * bucketSize;
        const to = from + bucketSize;
        return (
          <div key={b.bucket} className="flex items-center gap-2">
            <span className="w-24 shrink-0 text-right font-mono text-[11px] text-fg-muted">
              {formatNumber(from, 1)}–{formatNumber(to, 1)}
            </span>
            <div className="h-3.5 flex-1 overflow-hidden rounded-sm bg-ink/60">
              <div
                className="h-full rounded-sm bg-amber"
                style={{ width: `${(b.count / max) * 100}%` }}
              />
            </div>
            <span className="w-12 shrink-0 text-right font-mono text-[11px] text-fg-muted">
              {formatNumber(b.count)}
            </span>
          </div>
        );
      })}
    </div>
  );
}

/**
 * Derived scene-traversal metrics (Issues #38/#39/#40): how much of the scene
 * visitors actually move through (coverage / dead zones), how far the camera
 * sits from a focus point (distance / zoom), and how much effort navigation
 * costs (active travel vs idle). All three are computed server-side from
 * `camera_sample` events — no extra client capture.
 */
export function SceneMetrics({
  coverage,
  cellSize,
  distance,
  bucketSize,
  navigation,
}: {
  coverage: CoverageVoxel[];
  cellSize: number;
  distance: CameraDistanceBucket[];
  bucketSize: number;
  navigation: NavigationStat[];
}) {
  const occupiedCells = coverage.length;
  const cameraSamples = coverage.reduce((s, v) => s + v.count, 0);

  const totalTravel = navigation.reduce((s, n) => s + n.total_distance, 0);
  const totalSegments = navigation.reduce((s, n) => s + n.segments, 0);
  const activeSegments = navigation.reduce((s, n) => s + n.active_segments, 0);
  const sessionsMoved = navigation.length;
  const avgTravel = sessionsMoved > 0 ? totalTravel / sessionsMoved : 0;
  const activeShare = totalSegments > 0 ? activeSegments / totalSegments : 0;

  const hasData = occupiedCells > 0 || navigation.length > 0;

  return (
    <Panel
      title="Scene traversal"
      subtitle="Coverage, camera distance & navigation effort — derived from camera_sample"
      collapsible
      defaultCollapsed
    >
      {!hasData ? (
        <p className="text-sm text-fg-muted">No camera samples in range.</p>
      ) : (
        <div className="flex flex-col gap-5">
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            <Stat
              label="Visited cells"
              value={formatNumber(occupiedCells)}
              hint={`${formatNumber(cellSize, 2)} u voxels`}
            />
            <Stat label="Camera samples" value={formatNumber(cameraSamples)} />
            <Stat
              label="Avg travel"
              value={formatNumber(avgTravel, 1)}
              hint={sessionsMoved > 0 ? `over ${formatNumber(sessionsMoved)} sessions` : undefined}
            />
            <Stat
              label="Active movement"
              value={`${formatNumber(activeShare * 100, 0)}%`}
              hint="of camera segments"
            />
          </div>

          <div>
            <p className="mb-1.5 text-xs uppercase tracking-wide text-fg-muted">
              Camera distance distribution
            </p>
            <DistanceHistogram buckets={distance} bucketSize={bucketSize} />
          </div>
        </div>
      )}
    </Panel>
  );
}
