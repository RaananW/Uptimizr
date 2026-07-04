import type { XrLocomotionStat } from "../../api";
import { formatNumber, parseTimestamp } from "../../format";

/**
 * VR comfort & locomotion (#148) — the panel BODY only (no chrome). Turns the
 * existing `camera_gesture` / `mesh_interaction` streams (ADR 0025) into a
 * comfort signal for XR developers: the locomotion-style mix (teleport vs.
 * smooth thumbstick locomotion vs. untyped navigate) plus a correlation between
 * heavy locomotion (a motion-sickness risk) and early exits (a discomfort
 * proxy). Buildable from existing data — no schema change.
 */

/** Sessions whose span is under this many ms count as an "early exit". */
export const EARLY_EXIT_MS = 30_000;

/** Duration floor (1 s) when deriving a per-minute rate, so tiny spans don't blow up. */
const MIN_RATE_MS = 1_000;

/** Aggregate locomotion-style mix across XR sessions. */
export interface LocomotionMix {
  /** Discrete viewpoint jumps (`mesh_interaction { kind: "teleport" }`). */
  teleport: number;
  /** Smooth thumbstick locomotion — `fly` gestures that weren't teleports. */
  smooth: number;
  /** Untyped user-bracketed camera moves (`camera_gesture { kind: "navigate" }`). */
  navigate: number;
  /** Sum of the three, for share computation. */
  total: number;
}

/**
 * Sum the locomotion-style mix across sessions. A teleport emits both a `fly`
 * gesture and a `mesh_interaction teleport` (ADR 0025), so smooth locomotion is
 * `fly - teleports`, floored at 0 (a session may report more teleport picks than
 * flies if a jump was cancelled mid-bracket).
 */
export function locomotionMix(stats: XrLocomotionStat[]): LocomotionMix {
  let teleport = 0;
  let smooth = 0;
  let navigate = 0;
  for (const s of stats) {
    teleport += s.teleports;
    smooth += Math.max(0, s.fly_gestures - s.teleports);
    navigate += s.navigate_gestures;
  }
  return { teleport, smooth, navigate, total: teleport + smooth + navigate };
}

/** Session span in ms, from the engine-formatted timestamps; 0 when unparseable. */
export function sessionDurationMs(stat: XrLocomotionStat): number {
  const start = parseTimestamp(stat.started_at);
  const end = parseTimestamp(stat.ended_at);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return 0;
  return Math.max(0, end - start);
}

/** Locomotion gestures (fly + navigate) per minute of session, span-floored. */
function locomotionPerMinute(stat: XrLocomotionStat): number {
  const gestures = stat.fly_gestures + stat.navigate_gestures;
  const minutes = Math.max(sessionDurationMs(stat), MIN_RATE_MS) / 60_000;
  return gestures / minutes;
}

/** One side of the heavy-vs-light locomotion comfort split. */
export interface ComfortSplit {
  /** Number of sessions in this half. */
  sessions: number;
  /** Share (0–1) of sessions whose span is under {@link EARLY_EXIT_MS}. */
  earlyExitRate: number;
  /** Average session span in ms. */
  avgDurationMs: number;
  /** Average locomotion gestures per minute. */
  avgPerMinute: number;
}

/** Heavy vs. light locomotion comfort correlation. */
export interface ComfortCorrelation {
  heavy: ComfortSplit;
  light: ComfortSplit;
}

function summarize(
  rows: { stat: XrLocomotionStat; rate: number }[],
  earlyExitMs: number,
): ComfortSplit {
  const sessions = rows.length;
  if (sessions === 0) {
    return { sessions: 0, earlyExitRate: 0, avgDurationMs: 0, avgPerMinute: 0 };
  }
  let early = 0;
  let totalDuration = 0;
  let totalRate = 0;
  for (const { stat, rate } of rows) {
    const dur = sessionDurationMs(stat);
    if (dur < earlyExitMs) early += 1;
    totalDuration += dur;
    totalRate += rate;
  }
  return {
    sessions,
    earlyExitRate: early / sessions,
    avgDurationMs: totalDuration / sessions,
    avgPerMinute: totalRate / sessions,
  };
}

/**
 * Split XR sessions into heavy vs. light locomotion by the median
 * gestures-per-minute rate and summarize each half's early-exit rate and average
 * session length. Returns `null` when there are fewer than two sessions (nothing
 * to correlate). The heavy half is the upper portion at/above the median rate.
 */
export function comfortCorrelation(
  stats: XrLocomotionStat[],
  earlyExitMs: number = EARLY_EXIT_MS,
): ComfortCorrelation | null {
  if (stats.length < 2) return null;
  const rows = stats
    .map((stat) => ({ stat, rate: locomotionPerMinute(stat) }))
    .sort((a, b) => a.rate - b.rate);
  const mid = Math.floor(rows.length / 2);
  const light = rows.slice(0, mid);
  const heavy = rows.slice(mid);
  return {
    heavy: summarize(heavy, earlyExitMs),
    light: summarize(light, earlyExitMs),
  };
}

/** Compact session-span label: sub-minute as `x.x s`, otherwise `x.x min`. */
function formatSpan(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "0 s";
  return ms < 60_000 ? `${(ms / 1000).toFixed(1)} s` : `${(ms / 60_000).toFixed(1)} min`;
}

function pct(share: number): string {
  return `${Math.round(share * 100)}%`;
}

const MIX_ROWS: { key: keyof Omit<LocomotionMix, "total">; label: string }[] = [
  { key: "teleport", label: "Teleport" },
  { key: "smooth", label: "Smooth locomotion" },
  { key: "navigate", label: "Navigate" },
];

export function XrLocomotionComfortView({ stats }: { stats: XrLocomotionStat[] }) {
  const mix = locomotionMix(stats);
  const correlation = comfortCorrelation(stats);

  if (stats.length === 0 || mix.total === 0) {
    return (
      <p className="text-sm text-fg-muted">
        No XR locomotion in range. This panel reads <code>camera_gesture</code> (fly / navigate) and{" "}
        <code>mesh_interaction</code> teleports from sessions using an XR input source — enter an
        immersive session to populate it.
      </p>
    );
  }

  const max = Math.max(mix.teleport, mix.smooth, mix.navigate, 1);

  return (
    <div className="space-y-4">
      <ul className="space-y-3">
        {MIX_ROWS.map((row) => {
          const value = mix[row.key];
          const share = mix.total > 0 ? value / mix.total : 0;
          return (
            <li key={row.key} className="text-sm">
              <div className="flex items-center justify-between gap-3">
                <span className="font-medium text-fg">{row.label}</span>
                <span className="tabular-nums text-fg-muted">
                  {formatNumber(value)}
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

      {correlation && (
        <div className="border-t border-ink/40 pt-3 text-sm">
          <div className="mb-2 text-xs font-medium uppercase tracking-wide text-fg-muted">
            Comfort · locomotion vs. early exit
          </div>
          <table className="w-full text-xs tabular-nums">
            <thead>
              <tr className="text-fg-muted">
                <th className="text-left font-normal">Locomotion</th>
                <th className="text-right font-normal">Sessions</th>
                <th className="text-right font-normal">Early exit</th>
                <th className="text-right font-normal">Avg length</th>
              </tr>
            </thead>
            <tbody>
              {(
                [
                  { label: "Heavy", split: correlation.heavy },
                  { label: "Light", split: correlation.light },
                ] as const
              ).map(({ label, split }) => (
                <tr key={label}>
                  <td className="py-0.5 text-fg">{label}</td>
                  <td className="py-0.5 text-right text-fg-muted">
                    {formatNumber(split.sessions)}
                  </td>
                  <td className="py-0.5 text-right text-fg-muted">{pct(split.earlyExitRate)}</td>
                  <td className="py-0.5 text-right text-fg-muted">
                    {formatSpan(split.avgDurationMs)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="mt-2 text-xs text-fg-muted">
            Heavy-locomotion sessions above the median gesture rate. A higher early-exit rate there
            than for light-locomotion sessions suggests motion discomfort.
          </p>
        </div>
      )}
    </div>
  );
}

export const XR_LOCOMOTION_TITLE = "VR comfort & locomotion";
export const XR_LOCOMOTION_SUBTITLE =
  "Teleport / smooth / navigate mix for XR sessions + early-exit correlation";
