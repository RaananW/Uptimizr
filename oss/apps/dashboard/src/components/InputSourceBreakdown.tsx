import type { InteractionSource } from "@/lib/api";
import { formatNumber } from "@/lib/format";
import { formatSource } from "@/lib/filters";
import { Panel } from "./Panel";

/** Humanize an interaction event type for display (e.g. `pointer_click` → `Pointer click`). */
function formatEventType(type: string): string {
  const spaced = type.replace(/_/g, " ");
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

interface SourceGroup {
  source: string;
  total: number;
  sessions: number;
  byType: { event_type: string; count: number }[];
}

/** Roll the flat `(event_type, source)` rows up into per-source groups. */
function groupBySource(rows: InteractionSource[]): SourceGroup[] {
  const groups = new Map<string, SourceGroup>();
  for (const r of rows) {
    let g = groups.get(r.source);
    if (!g) {
      g = { source: r.source, total: 0, sessions: 0, byType: [] };
      groups.set(r.source, g);
    }
    g.total += r.count;
    g.sessions = Math.max(g.sessions, r.sessions);
    g.byType.push({ event_type: r.event_type, count: r.count });
  }
  for (const g of groups.values()) g.byType.sort((a, b) => b.count - a.count);
  return [...groups.values()].sort((a, b) => b.total - a.total);
}

/**
 * Input-source breakdown (ADR 0011): which input sources actually drive the
 * scene's interactions. Every interaction event carries a source (mouse, touch,
 * XR controller, hand, gaze, …); this surfaces that dimension — e.g. how much of
 * the engagement is immersive vs. flat-screen — instead of only filtering by it.
 */
export function InputSourceBreakdown({ rows }: { rows: InteractionSource[] }) {
  const groups = groupBySource(rows);
  const max = groups.reduce((m, g) => Math.max(m, g.total), 0);
  return (
    <Panel title="Input sources" subtitle="Interactions by input source">
      {groups.length === 0 ? (
        <p className="text-sm text-fg-muted">No source-bearing interactions in range.</p>
      ) : (
        <ul className="space-y-3">
          {groups.map((g) => (
            <li key={g.source} className="text-sm">
              <div className="flex items-center justify-between gap-3">
                <span className="font-medium text-fg">{formatSource(g.source)}</span>
                <span className="tabular-nums text-fg-muted">
                  {formatNumber(g.total)}
                  <span className="ml-1 text-xs text-fg-muted">
                    · {formatNumber(g.sessions)} {g.sessions === 1 ? "session" : "sessions"}
                  </span>
                </span>
              </div>
              <div className="mt-1 h-1.5 w-full overflow-hidden rounded bg-ink/60">
                <div
                  className="h-full rounded bg-amber"
                  style={{ width: `${max > 0 ? (g.total / max) * 100 : 0}%` }}
                />
              </div>
              <div className="mt-1.5 flex flex-wrap gap-1.5">
                {g.byType.map((t) => (
                  <span
                    key={t.event_type}
                    className="rounded bg-ink/60 px-1.5 py-0.5 font-mono text-[11px] text-fg-muted"
                  >
                    {formatEventType(t.event_type)} {formatNumber(t.count)}
                  </span>
                ))}
              </div>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}
