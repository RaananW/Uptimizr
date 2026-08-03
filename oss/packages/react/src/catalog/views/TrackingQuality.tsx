import type { TrackingQualityStat } from "../../api";
import { formatNumber, parseTimestamp } from "../../format";

/**
 * Tracking-quality timeline (#155, ADR 0048) — the panel BODY only (no chrome).
 * Turns the `capability_change { kind: "tracking" }` transitions into the signal
 * XR/AR developers otherwise can't see: how much of a session ran with degraded
 * or lost spatial tracking, split by hand vs. controller. A session that looked
 * fine in FPS metrics can still have been unusable because the user's hands kept
 * disappearing. Built from existing data — no schema change (the degraded-episode
 * length reuses the shared `visible_ms` column).
 */

/** Session span in ms, from the engine-formatted timestamps; 0 when unparseable. */
export function sessionDurationMs(stat: TrackingQualityStat): number {
  const start = parseTimestamp(stat.started_at);
  const end = parseTimestamp(stat.ended_at);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return 0;
  return Math.max(0, end - start);
}

/** Aggregate tracking-quality roll-up across XR sessions. */
export interface TrackingSummary {
  /** Number of sessions that reported a tracking transition. */
  sessions: number;
  /** Total session time observed, in ms (sum of session spans). */
  spanMs: number;
  /** Total degraded / lost-tracking time, in ms (all sources). */
  degradedMs: number;
  /** Degraded time attributed to hand tracking, in ms. */
  handMs: number;
  /** Degraded time attributed to controller tracking, in ms. */
  controllerMs: number;
  /** Total completed degraded episodes. */
  episodes: number;
  /** Degraded share of observed session time (0–1). */
  degradedShare: number;
}

/**
 * Sum the degraded-tracking totals across sessions and derive the degraded share
 * of observed session time. The share is `degraded_ms / span_ms`, clamped to
 * [0, 1] (an episode can, in a coarse best-effort report, slightly overrun the
 * session span if it started before the first observed event).
 */
export function trackingSummary(stats: TrackingQualityStat[]): TrackingSummary {
  let spanMs = 0;
  let degradedMs = 0;
  let handMs = 0;
  let controllerMs = 0;
  let episodes = 0;
  for (const s of stats) {
    spanMs += sessionDurationMs(s);
    degradedMs += s.degraded_ms;
    handMs += s.hand_degraded_ms;
    controllerMs += s.controller_degraded_ms;
    episodes += s.degraded_episodes;
  }
  const degradedShare = spanMs > 0 ? Math.min(1, degradedMs / spanMs) : 0;
  return {
    sessions: stats.length,
    spanMs,
    degradedMs,
    handMs,
    controllerMs,
    episodes,
    degradedShare,
  };
}

/** Compact duration label: sub-minute as `x.x s`, otherwise `x.x min`. */
function formatSpan(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "0 s";
  return ms < 60_000 ? `${(ms / 1000).toFixed(1)} s` : `${(ms / 60_000).toFixed(1)} min`;
}

function pct(share: number): string {
  return `${Math.round(share * 100)}%`;
}

const SPLIT_ROWS: { key: "handMs" | "controllerMs"; label: string }[] = [
  { key: "handMs", label: "Hand tracking" },
  { key: "controllerMs", label: "Controller tracking" },
];

export function TrackingQualityView({ stats }: { stats: TrackingQualityStat[] }) {
  const summary = trackingSummary(stats);

  if (summary.sessions === 0 || summary.degradedMs === 0) {
    return (
      <p className="text-sm text-fg-muted">
        No degraded tracking in range. This panel reads{" "}
        <code>capability_change {"{ kind: 'tracking' }"}</code> transitions from XR sessions — when
        hand or controller tracking is lost or degrades, the connector reports the episode. Clean
        tracking means an empty panel.
      </p>
    );
  }

  const max = Math.max(summary.handMs, summary.controllerMs, 1);

  return (
    <div className="space-y-4">
      <div className="flex items-baseline justify-between gap-3">
        <div>
          <div className="text-2xl font-semibold tabular-nums text-fg">
            {pct(summary.degradedShare)}
          </div>
          <div className="text-xs text-fg-muted">of session time with degraded tracking</div>
        </div>
        <div className="text-right text-xs text-fg-muted">
          <div className="tabular-nums">{formatNumber(summary.episodes)} episodes</div>
          <div className="tabular-nums">{formatNumber(summary.sessions)} sessions</div>
        </div>
      </div>

      <ul className="space-y-3">
        {SPLIT_ROWS.map((row) => {
          const value = summary[row.key];
          const share = summary.degradedMs > 0 ? value / summary.degradedMs : 0;
          return (
            <li key={row.key} className="text-sm">
              <div className="flex items-center justify-between gap-3">
                <span className="font-medium text-fg">{row.label}</span>
                <span className="tabular-nums text-fg-muted">
                  {formatSpan(value)}
                  <span className="ml-1 text-xs text-fg-muted">· {pct(share)}</span>
                </span>
              </div>
              <div className="mt-1 h-1.5 w-full overflow-hidden rounded bg-ink/60">
                <div
                  className="h-full rounded bg-amber"
                  style={{ width: `${(value / max) * 100}%` }}
                />
              </div>
            </li>
          );
        })}
      </ul>

      <p className="text-xs text-fg-muted">
        Best-effort: XR connectors report tracking loss when a hand or controller drops out of the
        input registry mid-session (ADR 0048). Split by the input source that degraded.
      </p>
    </div>
  );
}

export const TRACKING_QUALITY_TITLE = "Tracking quality";
export const TRACKING_QUALITY_SUBTITLE =
  "Share of XR session time with degraded / lost tracking, split by hand vs. controller";
