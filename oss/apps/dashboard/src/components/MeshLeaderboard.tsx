import type { MeshSourceCount, MeshTrendPoint } from "@/lib/api";
import { formatNumber } from "@/lib/format";
import { Panel } from "./Panel";

export const MESH_LEADERBOARD_TITLE = "Part-popularity leaderboard";
export const MESH_LEADERBOARD_SUBTITLE = "Ranked meshes, with trend and input split";
export const MESH_LEADERBOARD_HELP =
  "The most-interacted meshes ranked by total active interactions (clicks / hovers / picks / drags — passive gaze is excluded), each with a trend sparkline (rising/falling over the range) and an input-source split (mouse / touch / XR / …). Expand a row to see which sources drove it. Unlike the plain Top-meshes list, gaze-only hits don't inflate the ranking.";

/** Stable per-source colours, shared with the input-modality panel (ADR 0011). */
const SOURCE_COLORS: Record<string, string> = {
  mouse: "#60a5fa",
  touch: "#34d399",
  stylus: "#a78bfa",
  pen: "#a78bfa",
  "xr-controller": "#fbbf24",
  hand: "#f472b6",
  gaze: "#22d3ee",
  transient: "#fb7185",
  keyboard: "#f59e0b",
  gamepad: "#c084fc",
  other: "#94a3b8",
};
const FALLBACK_COLOR = "#64748b";

function sourceColor(source: string): string {
  return SOURCE_COLORS[source] ?? FALLBACK_COLOR;
}

interface LeaderboardRow {
  mesh: string;
  total: number;
  sources: { source: string; count: number }[];
  buckets: number[];
  /** Recent-half minus earlier-half interaction count (the rising/falling signal). */
  delta: number;
}

/**
 * Fold the per-(mesh, source) split and the per-(mesh, bucket) trend into one
 * ranked row per mesh: total + source breakdown + ordered trend buckets + a
 * recent-vs-earlier delta. Exported for unit testing the aggregation logic.
 */
export function buildLeaderboard(
  sources: MeshSourceCount[],
  trend: MeshTrendPoint[],
  topN: number,
): LeaderboardRow[] {
  const byMesh = new Map<string, { total: number; sources: Map<string, number> }>();
  for (const r of sources) {
    let entry = byMesh.get(r.mesh);
    if (!entry) {
      entry = { total: 0, sources: new Map() };
      byMesh.set(r.mesh, entry);
    }
    entry.total += r.count;
    entry.sources.set(r.source, (entry.sources.get(r.source) ?? 0) + r.count);
  }

  // Ordered trend buckets per mesh (oldest first), for the sparkline + delta.
  const trendByMesh = new Map<string, MeshTrendPoint[]>();
  for (const p of trend) {
    const arr = trendByMesh.get(p.mesh);
    if (arr) arr.push(p);
    else trendByMesh.set(p.mesh, [p]);
  }

  const rows: LeaderboardRow[] = [...byMesh.entries()].map(([mesh, entry]) => {
    const points = (trendByMesh.get(mesh) ?? []).slice().sort((a, b) => a.bucket - b.bucket);
    const buckets = points.map((p) => p.count);
    const mid = Math.floor(buckets.length / 2);
    const earlier = buckets.slice(0, mid).reduce((s, n) => s + n, 0);
    const recent = buckets.slice(mid).reduce((s, n) => s + n, 0);
    return {
      mesh,
      total: entry.total,
      sources: [...entry.sources.entries()]
        .map(([source, count]) => ({ source, count }))
        .sort((a, b) => b.count - a.count),
      buckets,
      delta: recent - earlier,
    };
  });

  return rows.sort((a, b) => b.total - a.total).slice(0, topN);
}

/** A compact inline bar sparkline of a mesh's interaction trend across buckets. */
function Sparkline({ buckets }: { buckets: number[] }) {
  if (buckets.length < 2) {
    return <span className="text-[10px] text-fg-muted">—</span>;
  }
  const max = buckets.reduce((m, n) => Math.max(m, n), 0) || 1;
  return (
    <div className="flex h-5 items-end gap-px" aria-hidden>
      {buckets.map((n, i) => (
        <div
          key={i}
          className="w-1 rounded-sm bg-sky-400/70"
          style={{ height: `${Math.max(8, (n / max) * 100)}%` }}
        />
      ))}
    </div>
  );
}

/** A rising/falling/flat indicator derived from the recent-vs-earlier delta. */
function TrendBadge({ delta }: { delta: number }) {
  if (delta > 0) {
    return <span className="tabular-nums text-xs text-emerald-400">▲ {formatNumber(delta)}</span>;
  }
  if (delta < 0) {
    return <span className="tabular-nums text-xs text-rose-400">▼ {formatNumber(-delta)}</span>;
  }
  return <span className="text-xs text-fg-muted">—</span>;
}

/**
 * Part-popularity leaderboard (#74): a ranked mesh list where each row carries a
 * trend sparkline, a rising/falling delta, and an expandable per-source split.
 * Panel BODY only (no chrome); the host supplies the title/subtitle/help via the
 * ADR 0036 panel contract.
 */
export function MeshLeaderboardView({
  sources,
  trend,
  topN = 8,
}: {
  sources: MeshSourceCount[];
  trend: MeshTrendPoint[];
  topN?: number;
}) {
  const rows = buildLeaderboard(sources, trend, topN);
  if (rows.length === 0) {
    return <p className="text-sm text-fg-muted">No mesh interactions in range.</p>;
  }
  return (
    <ol className="space-y-2">
      {rows.map((row, i) => (
        <li key={row.mesh} className="text-sm">
          <details className="group">
            <summary className="flex cursor-pointer list-none items-center gap-3">
              <span className="w-5 shrink-0 text-right tabular-nums text-xs text-fg-muted">
                {i + 1}
              </span>
              <span className="min-w-0 flex-1 truncate font-mono text-xs text-fg">{row.mesh}</span>
              <Sparkline buckets={row.buckets} />
              <TrendBadge delta={row.delta} />
              <span className="w-12 shrink-0 text-right tabular-nums text-fg-muted">
                {formatNumber(row.total)}
              </span>
            </summary>
            <ul className="mt-1.5 space-y-1 pl-8">
              {row.sources.map((s) => (
                <li key={s.source} className="flex items-center gap-2 text-xs">
                  <span
                    className="inline-block h-2 w-2 shrink-0 rounded-sm"
                    style={{ backgroundColor: sourceColor(s.source) }}
                  />
                  <span className="w-24 shrink-0 truncate text-fg-muted">{s.source}</span>
                  <div className="h-1.5 flex-1 overflow-hidden rounded bg-ink/60">
                    <div
                      className="h-full rounded"
                      style={{
                        width: `${row.total > 0 ? (s.count / row.total) * 100 : 0}%`,
                        backgroundColor: sourceColor(s.source),
                      }}
                    />
                  </div>
                  <span className="w-10 shrink-0 text-right tabular-nums text-fg-muted">
                    {formatNumber(s.count)}
                  </span>
                </li>
              ))}
            </ul>
          </details>
        </li>
      ))}
    </ol>
  );
}

/** Chrome-wrapped leaderboard for legacy call sites. */
export function MeshLeaderboard({
  sources,
  trend,
}: {
  sources: MeshSourceCount[];
  trend: MeshTrendPoint[];
}) {
  return (
    <Panel
      title={MESH_LEADERBOARD_TITLE}
      subtitle={MESH_LEADERBOARD_SUBTITLE}
      help={MESH_LEADERBOARD_HELP}
    >
      <MeshLeaderboardView sources={sources} trend={trend} />
    </Panel>
  );
}
