import type { InputActionCount, InteractionSource } from "@/lib/api";
import { formatNumber } from "@/lib/format";
import { Panel } from "./Panel";

export const INPUT_MODALITY_TITLE = "Input-modality split";
export const INPUT_MODALITY_SUBTITLE = "Keyboard / gamepad / touch / XR — and top shortcuts";
export const INPUT_MODALITY_HELP =
  "How visitors drive the experience: the share of interactions per input source (mouse / touch / keyboard / gamepad / XR), from the input-source breakdown (ADR 0011), paired with the most-used app-level shortcuts/actions from input_action events (ADR 0023).";

/** Stable per-source colours, shared with the part-popularity leaderboard. */
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

interface ModalityShare {
  source: string;
  count: number;
  share: number;
}

/**
 * Collapse the per-(event_type, source) breakdown into a per-source share — the
 * input-modality split. Exported for unit testing the aggregation logic.
 */
export function buildModalitySplit(rows: InteractionSource[]): ModalityShare[] {
  const bySource = new Map<string, number>();
  for (const r of rows) bySource.set(r.source, (bySource.get(r.source) ?? 0) + r.count);
  const total = [...bySource.values()].reduce((s, n) => s + n, 0);
  return [...bySource.entries()]
    .map(([source, count]) => ({ source, count, share: total > 0 ? count / total : 0 }))
    .sort((a, b) => b.count - a.count);
}

/**
 * Input-modality split + most-used shortcuts (#75): a per-source share bar (from
 * the input-source breakdown) and a ranked shortcut list (from input_action).
 * Panel BODY only; the host supplies the chrome via the ADR 0036 panel contract.
 */
export function InputModalitySplitView({
  sources,
  actions,
  topActions = 8,
}: {
  sources: InteractionSource[];
  actions: InputActionCount[];
  topActions?: number;
}) {
  const modality = buildModalitySplit(sources);
  const topShortcuts = actions.slice(0, topActions);
  if (modality.length === 0 && topShortcuts.length === 0) {
    return <p className="text-sm text-fg-muted">No input interactions in range.</p>;
  }
  return (
    <div className="space-y-4">
      <div>
        <h4 className="mb-2 text-xs font-semibold uppercase tracking-wide text-fg-muted">
          Modality share
        </h4>
        {modality.length === 0 ? (
          <p className="text-sm text-fg-muted">No source-bearing interactions in range.</p>
        ) : (
          <>
            <div className="flex h-3 w-full overflow-hidden rounded bg-ink/60">
              {modality.map((m) => (
                <div
                  key={m.source}
                  className="h-full"
                  style={{ width: `${m.share * 100}%`, backgroundColor: sourceColor(m.source) }}
                  title={`${m.source}: ${formatNumber(m.count)}`}
                />
              ))}
            </div>
            <ul className="mt-2 flex flex-wrap gap-x-3 gap-y-1">
              {modality.map((m) => (
                <li key={m.source} className="flex items-center gap-1.5 text-xs text-fg-muted">
                  <span
                    className="inline-block h-2 w-2 rounded-sm"
                    style={{ backgroundColor: sourceColor(m.source) }}
                  />
                  {m.source}
                  <span className="tabular-nums text-fg">{Math.round(m.share * 100)}%</span>
                </li>
              ))}
            </ul>
          </>
        )}
      </div>

      <div>
        <h4 className="mb-2 text-xs font-semibold uppercase tracking-wide text-fg-muted">
          Most-used shortcuts
        </h4>
        {topShortcuts.length === 0 ? (
          <p className="text-sm text-fg-muted">No input_action events in range.</p>
        ) : (
          <ul className="space-y-1.5">
            {topShortcuts.map((a) => (
              <li key={`${a.action}/${a.source}`} className="flex items-center gap-2 text-sm">
                <span
                  className="inline-block h-2 w-2 shrink-0 rounded-sm"
                  style={{ backgroundColor: sourceColor(a.source) }}
                />
                <span className="min-w-0 flex-1 truncate font-mono text-xs text-fg">
                  {a.action}
                </span>
                <span className="shrink-0 text-xs text-fg-muted">{a.source}</span>
                <span className="w-12 shrink-0 text-right tabular-nums text-fg-muted">
                  {formatNumber(a.count)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

/** Chrome-wrapped input-modality split for legacy call sites. */
export function InputModalitySplit({
  sources,
  actions,
}: {
  sources: InteractionSource[];
  actions: InputActionCount[];
}) {
  return (
    <Panel
      title={INPUT_MODALITY_TITLE}
      subtitle={INPUT_MODALITY_SUBTITLE}
      help={INPUT_MODALITY_HELP}
    >
      <InputModalitySplitView sources={sources} actions={actions} />
    </Panel>
  );
}
