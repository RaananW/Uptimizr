"use client";

import type { RenderingTechnologyCount } from "@/lib/api";
import { formatNumber } from "@/lib/format";
import { Panel } from "./Panel";

/** A single (label, count) cell in one of the technology breakdowns. */
export interface TechBucket {
  key: string;
  label: string;
  count: number;
}

/** The breakdowns the panel renders, plus the grand total of sessions. */
export interface TechBreakdown {
  byApi: TechBucket[];
  byBackend: TechBucket[];
  byShadingLanguage: TechBucket[];
  total: number;
}

/**
 * Fold the crossed `(api, backend, apiVersion, shadingLanguage)` session-count
 * rows into independent breakdowns the panel shows. Each breakdown sums the same
 * session total, so the views are projections of one honest total. A blank field
 * surfaces as "unknown".
 */
export function foldRenderingTechnology(rows: RenderingTechnologyCount[]): TechBreakdown {
  const api = new Map<string, number>();
  const backend = new Map<string, number>();
  const shading = new Map<string, number>();
  let total = 0;

  for (const row of rows) {
    const sessions = Number(row.sessions) || 0;
    if (sessions <= 0) continue;
    total += sessions;
    const add = (m: Map<string, number>, raw: string) => {
      const key = raw === "" ? "unknown" : raw;
      m.set(key, (m.get(key) ?? 0) + sessions);
    };
    add(api, row.api);
    add(backend, row.backend);
    add(shading, row.shadingLanguage);
  }

  const byCount = (a: TechBucket, b: TechBucket) => b.count - a.count || a.key.localeCompare(b.key);
  const toBuckets = (m: Map<string, number>): TechBucket[] =>
    [...m.entries()].map(([key, count]) => ({ key, label: key, count })).sort(byCount);

  return {
    byApi: toBuckets(api),
    byBackend: toBuckets(backend),
    byShadingLanguage: toBuckets(shading),
    total,
  };
}

function Cell({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-edge bg-ink/40 px-3 py-2.5">
      <p className="truncate text-xs uppercase tracking-wide text-fg-muted" title={label}>
        {label}
      </p>
      <p className="mt-0.5 text-lg font-semibold tabular-nums text-fg-hi">{value}</p>
    </div>
  );
}

function Group({ title, buckets }: { title: string; buckets: TechBucket[] }) {
  return (
    <div>
      <p className="mb-1.5 text-xs font-medium uppercase tracking-wide text-fg-muted">{title}</p>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
        {buckets.map((b) => (
          <Cell key={b.key} label={b.label} value={formatNumber(b.count)} />
        ))}
      </div>
    </div>
  );
}

/**
 * Always-on rendering-technology mix (#120, ADR 0021 part 1): session counts by
 * graphics API, backend, and shading language. Always-on, so a populated panel is
 * the common case; the empty state only appears before any sessions land.
 */
export function RenderingTechnology({ rows }: { rows: RenderingTechnologyCount[] }) {
  const { byApi, byBackend, byShadingLanguage, total } = foldRenderingTechnology(rows);

  return (
    <Panel
      title="Rendering technology"
      subtitle="Sessions by graphics API, backend & shading language in the selected window"
    >
      {total === 0 ? (
        <p className="text-sm text-fg-muted">No sessions in range.</p>
      ) : (
        <div className="space-y-4">
          <Group title="By API" buckets={byApi} />
          <Group title="By backend" buckets={byBackend} />
          <Group title="By shading language" buckets={byShadingLanguage} />
        </div>
      )}
    </Panel>
  );
}
