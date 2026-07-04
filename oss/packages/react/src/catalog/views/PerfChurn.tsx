import type { PerfChurn } from "../../api";
import { formatNumber } from "../../format";

export const PERF_CHURN_TITLE = "Perf-driven churn";
export const PERF_CHURN_SUBTITLE = "Did the stutter actually cost the session?";
export const PERF_CHURN_HELP =
  "Correlates perf dips with early session end (#144). Of the sessions that ended in range, this is the share that ended shortly after an FPS dip (a frame_perf sample below the threshold) or a compile_stall, within the configured window. The cause split attributes each churned session to a low-FPS dip and/or a compile stall — a session hit by both is counted under each cause but only once in the headline rate. No schema change: derived from existing frame_perf, compile_stall and session_end events.";

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="rounded-lg bg-ink/60 p-3">
      <div className="text-xs uppercase tracking-wide text-fg-muted">{label}</div>
      <div className="mt-1 text-2xl font-semibold tabular-nums text-fg-hi">{value}</div>
      {hint ? <div className="mt-0.5 text-xs text-fg-muted">{hint}</div> : null}
    </div>
  );
}

/** One labelled cause bar: churned sessions attributed to a single dip cause. */
function CauseBar({
  label,
  count,
  total,
  color,
}: {
  label: string;
  count: number;
  total: number;
  color: string;
}) {
  const share = total > 0 ? count / total : 0;
  return (
    <div className="flex items-center gap-2 text-xs">
      <span className="w-28 shrink-0 text-right text-fg-muted">{label}</span>
      <div className="h-4 flex-1 overflow-hidden rounded bg-ink/60">
        <div className={`h-full rounded ${color}`} style={{ width: `${share * 100}%` }} />
      </div>
      <span className="w-10 shrink-0 tabular-nums text-fg-muted">{count}</span>
    </div>
  );
}

/**
 * Perf-driven churn overlay (#144): the perf-correlated churn rate plus its
 * FPS-dip vs. compile-stall cause split. Panel BODY only; the host supplies the
 * chrome via the ADR 0036 panel contract. Renders against the single-row
 * `perfChurn` read — no new client state.
 */
export function PerfChurnView({ churn }: { churn: PerfChurn | null }) {
  if (!churn || churn.sessions === 0) {
    return <p className="text-sm text-fg-muted">No ended sessions in range.</p>;
  }
  const rate = churn.churn_sessions / churn.sessions;
  const pct = `${Math.round(rate * 100)}%`;
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        <Stat label="Perf-correlated churn" value={pct} hint="of ended sessions" />
        <Stat
          label="Churned sessions"
          value={formatNumber(churn.churn_sessions)}
          hint={`of ${formatNumber(churn.sessions)} ended`}
        />
        <Stat label="Ended sessions" value={formatNumber(churn.sessions)} />
      </div>
      {churn.churn_sessions > 0 ? (
        <div className="space-y-1.5">
          <div className="text-xs uppercase tracking-wide text-fg-muted">Churn by cause</div>
          <CauseBar
            label="FPS dip"
            count={churn.fps_churn_sessions}
            total={churn.churn_sessions}
            color="bg-amber-500/70"
          />
          <CauseBar
            label="Compile stall"
            count={churn.stall_churn_sessions}
            total={churn.churn_sessions}
            color="bg-rose-500/70"
          />
          <p className="pt-1 text-xs text-fg-muted">
            A session hit by both a dip and a stall is counted under each cause, so the bars can sum
            to more than the churned total.
          </p>
        </div>
      ) : (
        <p className="text-sm text-fg-muted">
          No ended session followed a perf dip within the window — perf isn&apos;t driving churn
          here.
        </p>
      )}
    </div>
  );
}
