import type { CameraGestureStat } from "@/lib/api";
import { formatNumber } from "@/lib/format";
import { Panel } from "./Panel";

/** Human-readable label for each `camera_gesture` kind (ADR 0025). */
const KIND_LABELS: Record<string, string> = {
  orbit: "Orbit",
  pan: "Pan",
  dolly: "Dolly",
  zoom: "Zoom",
  roll: "Roll",
  fly: "Fly",
  navigate: "Navigate",
};

function kindLabel(kind: string): string {
  return KIND_LABELS[kind] ?? kind.charAt(0).toUpperCase() + kind.slice(1);
}

/** Compact duration: sub-second as `xxx ms`, otherwise `x.xx s`. */
function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "0 ms";
  return ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(ms < 10_000 ? 2 : 1)} s`;
}

/**
 * Navigation-style mix — the panel BODY only (no chrome). Breaks deliberate
 * camera navigation (ADR 0025) down by gesture kind: orbit vs. pan vs. dolly
 * vs. zoom vs. roll vs. fly. Each row shows the kind's share of all gestures
 * (bar + percent) and its average duration, so you can see whether viewers
 * mostly orbit a model, pan across a scene, or fly through a level.
 *
 * Gesture *magnitude* (angular / translation delta) is not aggregated today, so
 * v1 reports counts + duration only (deferred per #69).
 */
export function NavigationMixView({ stats }: { stats: CameraGestureStat[] }) {
  const rows = [...stats].sort((a, b) => b.gestures - a.gestures);
  const total = rows.reduce((sum, r) => sum + r.gestures, 0);
  const max = rows.reduce((m, r) => Math.max(m, r.gestures), 0);

  if (rows.length === 0 || total === 0) {
    return (
      <p className="text-sm text-fg-muted">
        No camera-navigation gestures in range. Enable <code>cameraGesture</code> capture in the SDK
        (on by default for Babylon) to populate this.
      </p>
    );
  }

  return (
    <ul className="space-y-3">
      {rows.map((r) => {
        const share = total > 0 ? (r.gestures / total) * 100 : 0;
        return (
          <li key={r.kind} className="text-sm">
            <div className="flex items-center justify-between gap-3">
              <span className="font-medium text-fg">{kindLabel(r.kind)}</span>
              <span className="tabular-nums text-fg-muted">
                {formatNumber(r.gestures)}
                <span className="ml-1 text-xs text-fg-muted">· {share.toFixed(0)}%</span>
                <span className="ml-2 text-xs text-fg-muted">avg {formatDuration(r.avg_ms)}</span>
              </span>
            </div>
            <div className="mt-1 h-1.5 w-full overflow-hidden rounded bg-ink/60">
              <div
                className="h-full rounded bg-amber"
                style={{ width: `${max > 0 ? (r.gestures / max) * 100 : 0}%` }}
              />
            </div>
          </li>
        );
      })}
    </ul>
  );
}

export const NAVIGATION_MIX_TITLE = "Navigation-style mix";
export const NAVIGATION_MIX_SUBTITLE =
  "Orbit / pan / dolly / zoom / roll / fly share + avg gesture duration";

/** Chrome-wrapped navigation mix for legacy call sites (overview + session). */
export function NavigationMix({ stats }: { stats: CameraGestureStat[] }) {
  return (
    <Panel title={NAVIGATION_MIX_TITLE} subtitle={NAVIGATION_MIX_SUBTITLE}>
      <NavigationMixView stats={stats} />
    </Panel>
  );
}
