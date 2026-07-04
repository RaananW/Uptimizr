import { useEffect, useMemo, useState } from "react";

import type { CollectorApi, QueryParams, VariantLeaderboardRow } from "../../api";
import { formatNumber } from "../../format";

export const VARIANT_LEADERBOARD_TITLE = "Variant → conversion leaderboard";
export const VARIANT_LEADERBOARD_SUBTITLE = "Ranked configurator variants, with conversion rate";
export const VARIANT_LEADERBOARD_HELP =
  'Ranks product-configurator variants — `custom` events grouped by their name (e.g. a colour, material, or trim swap) — by how often each was viewed, with distinct sessions and the mean dwell before the shopper switched variant or converted. Pick a "success" custom event (e.g. add_to_cart) to reveal the per-variant conversion rate: the share of sessions that fired the success event at or after first viewing that variant. Everything is session-based and read-only; the variant and success events are the ones your scene already emits — no schema changes.';

/** Format a dwell duration (ms) for display; `—` when there was no later boundary. */
export function formatDwell(ms: number): string {
  if (!(ms > 0)) return "—";
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)} s`;
  return `${(ms / 60_000).toFixed(1)} min`;
}

/** Format a conversion rate (0–1) as a percentage, or `—` when no success event is chosen. */
export function formatRate(rate: number, hasConversion: boolean): string {
  if (!hasConversion) return "—";
  return `${(rate * 100).toFixed(rate >= 0.1 || rate === 0 ? 0 : 1)}%`;
}

/**
 * Variant → conversion leaderboard (#150). The panel loads the ranked variants
 * with no success event chosen (so conversion is "—"); the viewer picks a success
 * custom event from the in-panel dropdown — its options are the discovered variant
 * names — and the view re-fetches through `ctx.api` to reveal conversion rates.
 * Panel BODY only (no chrome); the host supplies title/subtitle/help (ADR 0036).
 */
export function VariantLeaderboardView({
  initialRows,
  api,
  params,
}: {
  initialRows: VariantLeaderboardRow[];
  api: CollectorApi;
  params: QueryParams;
}) {
  const [conversion, setConversion] = useState("");
  const [rows, setRows] = useState(initialRows);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);

  // Candidate success events = every variant name discovered in the base load,
  // sorted for a stable dropdown.
  const names = useMemo(
    () => initialRows.map((r) => r.variant).sort((a, b) => a.localeCompare(b)),
    [initialRows],
  );

  // A new base load (range/scene/filters changed) resets to the un-converted view.
  useEffect(() => {
    setRows(initialRows);
    setConversion("");
    setError(false);
  }, [initialRows]);

  // Serialize params so the effect re-runs on a real filter change, not identity.
  const paramsKey = JSON.stringify(params);
  useEffect(() => {
    if (!conversion) {
      setRows(initialRows);
      setError(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(false);
    api
      .variantLeaderboard({ conversion: { type: "custom", name: conversion } }, params)
      .then((next) => {
        if (!cancelled) setRows(next);
      })
      .catch(() => {
        if (!cancelled) setError(true);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [conversion, paramsKey, initialRows, api]);

  if (initialRows.length === 0) {
    return <p className="text-sm text-fg-muted">No configurator variants in range.</p>;
  }

  const hasConversion = conversion !== "";
  const maxViews = rows.reduce((m, r) => Math.max(m, r.views), 0) || 1;

  return (
    <div className="space-y-3">
      <label className="flex items-center gap-2 text-xs text-fg-muted">
        <span className="shrink-0">Success event</span>
        <select
          className="min-w-0 flex-1 rounded border border-ink/40 bg-ink/40 px-2 py-1 text-xs text-fg"
          value={conversion}
          onChange={(e) => setConversion(e.target.value)}
        >
          <option value="">None — views only</option>
          {names.map((name) => (
            <option key={name} value={name}>
              {name}
            </option>
          ))}
        </select>
        {loading && <span className="shrink-0 text-fg-muted">…</span>}
      </label>

      {error ? (
        <p className="text-sm text-rose-400">Couldn’t load conversion rates.</p>
      ) : (
        <ol className="space-y-2">
          {rows.map((row, i) => (
            <li key={row.variant} className="text-sm">
              <div className="flex items-center gap-3">
                <span className="w-5 shrink-0 text-right tabular-nums text-xs text-fg-muted">
                  {i + 1}
                </span>
                <span className="min-w-0 flex-1 truncate font-mono text-xs text-fg">
                  {row.variant}
                </span>
                <span
                  className="w-16 shrink-0 text-right tabular-nums text-xs text-fg-muted"
                  title="Mean dwell before the next variant switch or conversion"
                >
                  {formatDwell(row.avgDwellMs)}
                </span>
                <span
                  className="w-12 shrink-0 text-right tabular-nums text-xs"
                  title={
                    hasConversion
                      ? `${formatNumber(row.conversions)} of ${formatNumber(row.sessions)} sessions converted`
                      : "Pick a success event to compute conversion"
                  }
                >
                  {formatRate(row.conversionRate, hasConversion)}
                </span>
                <span
                  className="w-12 shrink-0 text-right tabular-nums text-fg-muted"
                  title={`${formatNumber(row.sessions)} distinct sessions`}
                >
                  {formatNumber(row.views)}
                </span>
              </div>
              <div className="mt-1 ml-8 h-1.5 overflow-hidden rounded bg-ink/60">
                <div
                  className="h-full rounded bg-sky-400/70"
                  style={{ width: `${(row.views / maxViews) * 100}%` }}
                />
              </div>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
