import type { ReachabilityBin } from "../../api";
import { formatNumber } from "../../format";

export const REACHABILITY_TITLE = "Reachability report";
export const REACHABILITY_SUBTITLE = "How far interacted objects sit from the user";
export const REACHABILITY_HELP =
  "Per-mesh distance between where the user stood (the click-time camera position) and the point they interacted with, from mesh_interaction events ASOF-joined to the nearest preceding camera_sample (#151). Objects whose interactions cluster far from the standpoint are consistently reached from an uncomfortable range — actionable feedback for VR UI placement and first-person layout. Meshes past the comfortable-reach threshold are flagged.";

/**
 * Comfortable-reach threshold in world units. Beyond this a mesh is flagged as
 * consistently reached from an awkward range (roughly an arm's reach plus a
 * lean-in for VR; a layout heuristic for general first-person). World units are
 * scene-defined, so this is a sensible default, not an absolute.
 */
export const DEFAULT_REACH_THRESHOLD = 2;

/** Per-mesh reachability summary derived from the distance-band histogram. */
export interface MeshReachability {
  mesh: string;
  /** Total measured interactions across all distance bands. */
  count: number;
  /** Count-weighted mean standpoint→interaction distance (world units). */
  meanDistance: number;
  /** Farthest band's lower edge that carried an interaction (world units). */
  maxBandDistance: number;
  /** Whether the mean distance clears the comfortable-reach threshold. */
  far: boolean;
}

/**
 * Roll the per-(mesh, band) histogram up to a per-mesh summary: the total count,
 * the count-weighted mean distance (each band contributes its own mean distance
 * times its count), and the farthest occupied band. Sorted farthest-mean first
 * so the least reachable objects lead. Pure; exported for tests.
 */
export function summarizeReachability(
  bins: ReachabilityBin[],
  bucketSize: number,
  threshold = DEFAULT_REACH_THRESHOLD,
): MeshReachability[] {
  const byMesh = new Map<string, { count: number; distanceSum: number; maxBand: number }>();
  for (const b of bins) {
    let entry = byMesh.get(b.mesh);
    if (!entry) {
      entry = { count: 0, distanceSum: 0, maxBand: 0 };
      byMesh.set(b.mesh, entry);
    }
    entry.count += b.count;
    entry.distanceSum += b.avg_distance * b.count;
    entry.maxBand = Math.max(entry.maxBand, b.bucket * bucketSize);
  }
  const rows: MeshReachability[] = [...byMesh.entries()].map(([mesh, e]) => {
    const meanDistance = e.count > 0 ? e.distanceSum / e.count : 0;
    return {
      mesh,
      count: e.count,
      meanDistance,
      maxBandDistance: e.maxBand,
      far: meanDistance > threshold,
    };
  });
  rows.sort((a, b) => b.meanDistance - a.meanDistance || b.count - a.count);
  return rows;
}

/**
 * Reachability report (#151): a per-mesh bar of the mean standpoint→interaction
 * distance, farthest first, with a threshold marker and a "far" flag on objects
 * reached from an uncomfortable range. Panel BODY only; the host supplies the
 * chrome via the ADR 0036 panel contract.
 */
export function ReachabilityView({
  bins,
  bucketSize,
  threshold = DEFAULT_REACH_THRESHOLD,
  topN = 12,
}: {
  bins: ReachabilityBin[];
  bucketSize: number;
  threshold?: number;
  topN?: number;
}) {
  const rows = summarizeReachability(bins, bucketSize, threshold);
  if (rows.length === 0) {
    return (
      <p className="text-sm text-fg-muted">
        No measurable interactions in range. Reachability needs mesh_interaction events with a world
        point plus preceding camera_sample positions in the same session.
      </p>
    );
  }

  const max = rows.reduce((m, r) => Math.max(m, r.meanDistance, r.maxBandDistance), 0) || 1;
  const farCount = rows.filter((r) => r.far).length;
  const shown = rows.slice(0, topN);

  return (
    <div className="space-y-3">
      <p className="text-xs text-fg-muted">
        <span className="tabular-nums text-fg">{formatNumber(farCount)}</span> of{" "}
        <span className="tabular-nums text-fg">{formatNumber(rows.length)}</span> meshes are reached
        from beyond <span className="tabular-nums text-fg">{formatNumber(threshold, 2)}</span> m on
        average.
      </p>
      <ul className="space-y-1.5">
        {shown.map((r) => (
          <li key={r.mesh} className="text-sm">
            <div className="flex items-center justify-between gap-3">
              <span className="truncate font-mono text-xs text-fg" title={r.mesh}>
                {r.mesh}
              </span>
              <span className="flex shrink-0 items-center gap-2">
                {r.far && (
                  <span className="rounded bg-rose-500/20 px-1.5 text-xs text-rose-300">far</span>
                )}
                <span className="tabular-nums text-xs text-fg-muted">
                  {formatNumber(r.meanDistance, 2)} m · {formatNumber(r.count)}
                </span>
              </span>
            </div>
            <div className="relative mt-1 h-1.5 w-full overflow-hidden rounded bg-ink/60">
              <div
                className={`h-full rounded ${r.far ? "bg-rose-500/70" : "bg-sky-500/70"}`}
                style={{ width: `${(r.meanDistance / max) * 100}%` }}
              />
              <span
                className="absolute top-0 h-full w-px bg-fg/50"
                style={{ left: `${Math.min(100, (threshold / max) * 100)}%` }}
                title={`Comfortable-reach threshold: ${formatNumber(threshold, 2)} m`}
              />
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
