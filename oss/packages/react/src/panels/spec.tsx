"use client";

import {
  PANEL_RANGE_INHERIT,
  panelSpecV1Schema,
  resolvePanelSpecRange,
  type PanelEncoding,
  type PanelSpecV1,
  type QueryV1Input,
} from "@uptimizr/schema";
import { defaultEncoding, getMetric, validatePanelSpec } from "@uptimizr/metrics";
import type { CollectorApi, PanelSpecRow, QueryParams } from "../api";
import { SpecChart, type SpecRow } from "../catalog/views/SpecChart";
import { definePanel, type PanelDefinition } from "./contract";
import type { RemotePanelError } from "./remote";

/**
 * **Declarative panel specs, rendered** (#315, ADR 0051 §7 / sketch §G.3).
 *
 * `specPanel(spec)` turns one stored spec into an ordinary ADR 0036
 * `PanelDefinition`, which the dashboard's grid then treats exactly like a
 * built-in: the same chrome, the same ADR 0039 hide/settings persistence (keyed
 * by the panel id), the same error boundary.
 *
 * ## No code is loaded, and that is the whole point
 *
 * ADR 0041's runtime loader imports a remote ES module and runs it with the
 * dashboard's full privileges — which is why it is off by default and guarded
 * by an origin allowlist. A panel an LLM wrote would be exactly that. So what
 * arrives from the collector here is **data**: a metric id, a chart name and
 * some column names. `specPanel` reads it and picks a component this package
 * already ships. There is nothing to `import()` and nothing to evaluate, so
 * ADR 0041's trust decision is not widened by a single millimetre.
 *
 * ## `range: "inherit"` is why a pinned panel stays useful
 *
 * A spec that froze the window it was pinned at would answer the same question
 * forever while the grid around it moved. `"inherit"` means "whatever the
 * filter bar currently says", and it is resolved here, from `ctx.params`, on
 * every load — so a spec panel honours the global filters like every other
 * panel does.
 */

/** The id prefix every spec panel carries, so a built-in can never collide. */
export const SPEC_PANEL_ID_PREFIX = "spec:";

/** The panel id for a stored spec row. */
export function specPanelId(id: string): string {
  return `${SPEC_PANEL_ID_PREFIX}${id}`;
}

/** Whether a panel id names a spec panel (used by the dashboard's unpin control). */
export function isSpecPanelId(id: string): boolean {
  return id.startsWith(SPEC_PANEL_ID_PREFIX);
}

/** The stored row id behind a spec panel id, or `undefined` for anything else. */
export function specIdFromPanelId(panelId: string): string | undefined {
  return isSpecPanelId(panelId) ? panelId.slice(SPEC_PANEL_ID_PREFIX.length) : undefined;
}

/** What a spec panel's `load` produces: the rows, or the reason there are none. */
export interface SpecPanelData {
  rows: SpecRow[];
  /** Set when the spec could not be run at all — rendered inline, not thrown. */
  error?: string;
}

/**
 * The encoding a spec renders with: its own, filled in from the metric's
 * declared label/axis/measure columns for every channel it left open.
 *
 * Exported because the assistant's "Pin as panel" pre-fills the same defaults,
 * and a spec that renders differently from the preview that sold it is a small
 * betrayal.
 */
export function resolveEncoding(spec: PanelSpecV1): PanelEncoding {
  const metric = getMetric(spec.query.metric);
  const derived = metric == null ? {} : defaultEncoding(metric, spec.chart);
  return { ...derived, ...(spec.encoding ?? {}) };
}

/**
 * The `queryV1` document a spec runs for the window the host is showing.
 *
 * `format: "full"` rather than the DSL's own `table` default: a panel draws
 * rows, and the envelope's window and sample metadata is exactly what the
 * dashboard already has from its filter bar.
 */
export function specQuery(
  spec: PanelSpecV1,
  active: { since: number; until: number },
): QueryV1Input {
  const { range, ...rest } = spec.query;
  return { ...rest, range: resolvePanelSpecRange(range, active), format: "full" };
}

/**
 * Read the active window out of a `PanelContext`'s resolved query params.
 *
 * The filter bar always resolves to a bounded window, so both ends are present
 * in practice; the fallback is a one-hour window ending now, which is the same
 * default the dashboard starts at — better than running an unbounded query or
 * refusing to draw.
 */
function activeRange(params: Pick<QueryParams, "since" | "until">): {
  since: number;
  until: number;
} {
  const since = Number(params.since);
  const until = Number(params.until);
  if (Number.isFinite(since) && Number.isFinite(until) && until > since) return { since, until };
  const now = Date.now();
  return { since: now - 3_600_000, until: now };
}

/** Coerce the DSL's `format: "full"` answer into rows, whatever it returned. */
function toRows(result: unknown): SpecRow[] {
  if (Array.isArray(result)) return result as SpecRow[];
  // A single-record metric (`perf_summary`) answers with a bare object rather
  // than an array of one — a `stat` chart reads row zero either way.
  if (result != null && typeof result === "object") return [result as SpecRow];
  return [];
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Build a `PanelDefinition` from one stored panel spec.
 *
 * The definition is complete but not trusted: `load` validates the spec against
 * the metric registry before running anything, and a spec the registry rejects
 * renders the validator's message inline instead of throwing. That matters
 * because a spec can become invalid *after* it was pinned — a metric renamed, a
 * filter withdrawn — and a panel that says why it cannot draw is worth far more
 * than one that takes the grid down with it.
 */
export function specPanel(row: Pick<PanelSpecRow, "id" | "spec">): PanelDefinition<SpecPanelData> {
  const { spec } = row;
  const encoding = resolveEncoding(spec);
  return definePanel<SpecPanelData>({
    id: specPanelId(row.id),
    title: spec.title,
    // The agent's one-line reading is the part a person actually reads a week
    // later, so it becomes the subtitle rather than being tucked away.
    ...(spec.note != null && spec.note.length > 0 ? { subtitle: spec.note } : {}),
    span: spec.span,
    surfaces: ["overview"],
    // `world3d` and `heatmap2d` paint to a canvas; the rest are plain markup,
    // but a spec's chart is data, so the flag cannot be decided per panel kind
    // at module scope — client-only is the safe answer for all of them.
    clientOnly: spec.chart === "world3d" || spec.chart === "heatmap2d",
    load: async (ctx) => {
      const { issues } = validatePanelSpec(spec);
      if (issues.length > 0) {
        return { rows: [], error: issues[0]!.message };
      }
      try {
        const result = await ctx.api.query(specQuery(spec, activeRange(ctx.params)));
        return { rows: toRows(result) };
      } catch (err) {
        return { rows: [], error: errorMessage(err) };
      }
    },
    render: ({ data }) =>
      data.error != null ? (
        <p className="text-sm text-fg-muted" data-role="spec-panel-error">
          This panel cannot be drawn: {data.error}
        </p>
      ) : (
        <SpecChart
          chart={spec.chart}
          rows={data.rows}
          encoding={encoding}
          bins={spec.query.filters?.bins}
          cellSize={spec.query.filters?.cellSize}
        />
      ),
  });
}

/** What {@link loadSpecPanels} produced: the panels, and what it skipped. */
export interface LoadSpecPanelsResult {
  panels: PanelDefinition<unknown>[];
  /** One entry per spec that could not become a panel. Never thrown. */
  errors: RemotePanelError[];
  /** The stored rows behind the panels that loaded, for the unpin control. */
  rows: PanelSpecRow[];
}

/**
 * Fetch a project's pinned panels and turn each into a `PanelDefinition`.
 *
 * Mirrors ADR 0041's `loadRemotePanels` deliberately, down to the
 * {@link RemotePanelError} shape: each spec is validated independently, one that
 * fails is reported and skipped, and nothing here throws. A single malformed
 * spec — hand-edited in the database, written against a metric that has since
 * changed — must never be able to empty somebody's dashboard.
 *
 * A failure to reach the collector at all is one `manifest-fetch` error and an
 * empty list, which is the same shape the remote loader uses for the same
 * situation, so the host's error banner needs no second case.
 */
export async function loadSpecPanels(api: CollectorApi): Promise<LoadSpecPanelsResult> {
  let stored: PanelSpecRow[];
  try {
    stored = await api.panels();
  } catch (err) {
    return {
      panels: [],
      errors: [{ source: "api/v1/panels", code: "manifest-fetch", message: errorMessage(err) }],
      rows: [],
    };
  }

  const panels: PanelDefinition<unknown>[] = [];
  const errors: RemotePanelError[] = [];
  const rows: PanelSpecRow[] = [];
  for (const row of stored) {
    // The shape first — a stored row is data the collector validated when it was
    // written, but a store is not a boundary and this one has been round-tripped
    // through JSON. Then the vocabulary, so a panel that could not draw anything
    // is surfaced as an error here rather than as an inline message in the grid.
    const parsed = panelSpecV1Schema.safeParse(row.spec);
    if (!parsed.success) {
      errors.push({
        source: row.id,
        code: "invalid-panel",
        message: parsed.error.issues[0]?.message ?? "Stored spec is not a valid panelSpecV1",
      });
      continue;
    }
    const { issues } = validatePanelSpec(parsed.data);
    if (issues.length > 0) {
      errors.push({ source: row.id, code: "invalid-panel", message: issues[0]!.message });
      continue;
    }
    panels.push(
      specPanel({ id: row.id, spec: parsed.data }) as unknown as PanelDefinition<unknown>,
    );
    rows.push({ ...row, spec: parsed.data });
  }
  return { panels, errors, rows };
}

export { PANEL_RANGE_INHERIT };
