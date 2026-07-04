import type { LoadBounceBand } from "../../api";
import { formatNumber } from "../../format";

/**
 * Default load-time band boundaries (ms) — must mirror the collector default so
 * the client and server agree on the buckets. The dashboard passes these to the
 * API explicitly, and the view labels each band from the same list.
 */
export const LOAD_BANDS = [1000, 3000, 5000] as const;

/** Compact ms → `xxx ms` under a second, else `x.x s`. */
function formatMs(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "0 ms";
  if (ms < 1000) return `${Math.round(ms)} ms`;
  const s = ms / 1000;
  return `${Number.isInteger(s) ? s : s.toFixed(1)} s`;
}

/** Human label for band `i` given ascending boundary list `bounds`. */
function bandLabel(i: number, bounds: readonly number[]): string {
  if (i === 0) return `< ${formatMs(bounds[0] ?? 0)}`;
  if (i >= bounds.length) return `≥ ${formatMs(bounds[bounds.length - 1] ?? 0)}`;
  return `${formatMs(bounds[i - 1] ?? 0)} – ${formatMs(bounds[i] ?? 0)}`;
}

/** A bounce rate over 40% is bad enough to flag red; 15–40% amber; else neutral. */
function rateTone(rate: number): string {
  if (rate >= 0.4) return "bg-red";
  if (rate >= 0.15) return "bg-amber";
  return "bg-emerald";
}

/**
 * Load → bounce funnel — the panel BODY only (no chrome). Buckets sessions by
 * their initial `asset_load` load time and shows, per band, the **bounce rate**:
 * the share of sessions that produced no interaction (`pointer_*` /
 * `mesh_interaction` / `camera_gesture`) after loading. Slow-load bands with a
 * high bounce rate are the concrete "slow load costs you customers" signal (#152).
 *
 * The query may omit empty bands, so the view walks the full band list (derived
 * from `boundaries`) and fills missing bands with zeroes.
 */
export function LoadBounceFunnelView({
  rows,
  boundaries = LOAD_BANDS,
}: {
  rows: LoadBounceBand[];
  boundaries?: readonly number[];
}) {
  const byBand = new Map(rows.map((r) => [r.band, r]));
  const bandCount = boundaries.length + 1;
  const totalSessions = rows.reduce((sum, r) => sum + r.sessions, 0);

  if (totalSessions === 0) {
    return (
      <p className="text-sm text-fg-muted">
        No <code>asset_load</code> events in range. Enable asset/scene load capture in the SDK (on
        by default for Babylon) to see how load time affects bounce rate.
      </p>
    );
  }

  const bands = Array.from({ length: bandCount }, (_, i) => {
    const row = byBand.get(i);
    const sessions = row?.sessions ?? 0;
    const bounced = row?.bounced ?? 0;
    const rate = sessions > 0 ? bounced / sessions : 0;
    return { i, sessions, bounced, rate };
  });

  return (
    <ul className="space-y-3">
      {bands.map((b) => (
        <li key={b.i} className="text-sm">
          <div className="flex items-center justify-between gap-3">
            <span className="font-medium text-fg">{bandLabel(b.i, boundaries)}</span>
            <span className="tabular-nums text-fg-muted">
              {(b.rate * 100).toFixed(0)}% bounced
              <span className="ml-2 text-xs text-fg-muted">
                · {formatNumber(b.bounced)}/{formatNumber(b.sessions)} sessions
              </span>
            </span>
          </div>
          <div className="mt-1 h-1.5 w-full overflow-hidden rounded bg-ink/60">
            <div
              className={`h-full rounded ${rateTone(b.rate)}`}
              style={{ width: `${b.sessions > 0 ? b.rate * 100 : 0}%` }}
            />
          </div>
        </li>
      ))}
    </ul>
  );
}

export const LOAD_BOUNCE_TITLE = "Load → bounce funnel";
export const LOAD_BOUNCE_SUBTITLE = "Bounce rate by asset-load time band";
export const LOAD_BOUNCE_HELP =
  "Sessions bucketed by their initial asset-load time. A session 'bounces' when it produces no " +
  "interaction (pointer, mesh, or camera gesture) at or after loading. Rising bounce rate in the " +
  "slower bands is the concrete cost of slow loads.";
