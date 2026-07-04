import type { MeshBlindSpot } from "../../api";
import { formatNumber } from "../../format";

export const BLIND_SPOTS_TITLE = "Blind spots";
export const BLIND_SPOTS_SUBTITLE = "Rendered but never noticed";
export const BLIND_SPOTS_HELP =
  "The inverse of the mesh leaderboard (#143): objects with lots of on-screen time (mesh_visibility) but little or no engagement (mesh_interaction + hover_dwell). A retail engraving nobody spots, or a prop/room that renders but nobody investigates. Ranked most-seen-yet-least-touched first. Requires object-dwell capture (mesh_visibility) to be enabled.";

/** Compact duration: sub-second as `xxx ms`, otherwise `x.xx s`. */
function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "0 ms";
  return ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(ms < 10_000 ? 2 : 1)} s`;
}

export function BlindSpotReportView({ meshes }: { meshes: MeshBlindSpot[] }) {
  const max = meshes.reduce((m, x) => Math.max(m, x.visible_ms), 0);
  return meshes.length === 0 ? (
    <p className="text-sm text-fg-muted">
      No blind spots in range. This needs object-dwell (<code>meshVisibility</code>) capture
      enabled.
    </p>
  ) : (
    <ul className="space-y-2">
      {meshes.map((m) => {
        const engagement = m.interactions + m.hover_episodes;
        return (
          <li key={m.mesh} className="text-sm">
            <div className="flex items-center justify-between gap-3">
              <span className="truncate font-mono text-xs text-fg">{m.mesh}</span>
              <span className="shrink-0 tabular-nums text-fg-muted">
                {formatDuration(m.visible_ms)} seen
              </span>
            </div>
            <div className="mt-1 h-1.5 w-full overflow-hidden rounded bg-ink/60">
              <div
                className="h-full rounded bg-amber"
                style={{ width: `${max > 0 ? (m.visible_ms / max) * 100 : 0}%` }}
              />
            </div>
            <div className="mt-1 flex items-center gap-2 text-xs text-fg-muted">
              {engagement === 0 ? (
                <span className="rounded bg-rose-500/20 px-1.5 py-0.5 font-medium text-rose-300">
                  never engaged
                </span>
              ) : (
                <span className="tabular-nums">
                  {formatNumber(m.interactions)} interaction{m.interactions === 1 ? "" : "s"}
                  {m.hover_episodes > 0
                    ? ` · ${formatNumber(m.hover_episodes)} hover${
                        m.hover_episodes === 1 ? "" : "s"
                      } (${formatDuration(m.hover_ms)})`
                    : ""}
                </span>
              )}
            </div>
          </li>
        );
      })}
    </ul>
  );
}
