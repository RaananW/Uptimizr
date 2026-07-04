import type { BacktrackRatioStat } from "../../api";
import { formatNumber } from "../../format";

export const BACKTRACK_TITLE = "Backtracking hotspots";
export const BACKTRACK_SUBTITLE = "Scenes ranked by how often visitors re-walk the same area";
export const BACKTRACK_HELP =
  "Path-retrace signal (#153): the same camera-position stream that feeds desire lines, binned onto a coarse grid. Consecutive samples in one cell are collapsed (so standing still doesn't count), then re-entering a cell you already left is a 'backtrack'. The ratio is revisits ÷ cell entries, pooled per scene — a high ratio flags a dead end, a missed cue, or an unclear puzzle, i.e. a candidate for clearer signage / level-design fixes.";

/** Label an empty scene id (the default/unnamed scene) readably. */
function sceneLabel(scene: string): string {
  return scene === "" ? "(default scene)" : scene;
}

/**
 * Backtracking-hotspots leaderboard — the panel BODY only (no chrome). One row
 * per scene, ranked by backtrack ratio (worst first): a bar + percent for the
 * ratio, plus the raw revisits / entries and session count behind it. High-ratio
 * scenes are where visitors keep re-walking the same area.
 */
export function BacktrackRatioView({ stats }: { stats: BacktrackRatioStat[] }) {
  const rows = [...stats].sort((a, b) => b.backtrack_ratio - a.backtrack_ratio);
  const max = rows.reduce((m, r) => Math.max(m, r.backtrack_ratio), 0);

  if (rows.length === 0) {
    return (
      <p className="text-sm text-fg-muted">
        No camera-position samples in range. Enable <code>cameraSample</code> capture in the SDK (on
        by default for Babylon) to populate this.
      </p>
    );
  }

  return (
    <ul className="space-y-3">
      {rows.map((r) => {
        const pct = r.backtrack_ratio * 100;
        return (
          <li key={r.scene} className="text-sm">
            <div className="flex items-center justify-between gap-3">
              <span className="font-medium text-fg">{sceneLabel(r.scene)}</span>
              <span className="tabular-nums text-fg-muted">
                {pct.toFixed(0)}%
                <span className="ml-2 text-xs text-fg-muted">
                  {formatNumber(r.revisits)} / {formatNumber(r.entries)} entries ·{" "}
                  {formatNumber(r.sessions)} {r.sessions === 1 ? "session" : "sessions"}
                </span>
              </span>
            </div>
            <div className="mt-1 h-1.5 w-full overflow-hidden rounded bg-ink/60">
              <div
                className="h-full rounded bg-amber"
                style={{ width: `${max > 0 ? (r.backtrack_ratio / max) * 100 : 0}%` }}
              />
            </div>
          </li>
        );
      })}
    </ul>
  );
}
