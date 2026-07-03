"use client";

import type { GraphicsDiagnosticCount } from "@/lib/api";
import { formatNumber } from "@/lib/format";
import { Panel } from "./Panel";

/** A single (label, count) cell in one of the diagnostic breakdowns. */
export interface DiagnosticBucket {
  key: string;
  /** Human-readable label (e.g. "device-lost", "unknown"). */
  label: string;
  count: number;
}

/** The three breakdowns the panel renders, plus the grand total. */
export interface DiagnosticBreakdown {
  bySeverity: DiagnosticBucket[];
  byCategory: DiagnosticBucket[];
  byBackend: DiagnosticBucket[];
  total: number;
}

/**
 * Severity rank (most serious first) so the breakdown reads worst-to-best
 * regardless of how the rows arrive. Unknown severities sort last.
 */
const SEVERITY_ORDER = ["fatal", "error", "warning", "info"];

function severityRank(severity: string): number {
  const i = SEVERITY_ORDER.indexOf(severity);
  return i === -1 ? SEVERITY_ORDER.length : i;
}

/**
 * Fold the crossed `(severity, category, backend)` rows from the query API into
 * the three independent breakdowns the panel shows. Each breakdown sums the same
 * `incidents` total — which already folds discrete markers (count=1) and
 * per-session rollups (count=N) server-side (ADR 0021 decision 4) — so the three
 * views are three projections of one honest total. A blank `backend` is surfaced
 * as "unknown".
 */
export function foldGraphicsDiagnostics(rows: GraphicsDiagnosticCount[]): DiagnosticBreakdown {
  const severity = new Map<string, number>();
  const category = new Map<string, number>();
  const backend = new Map<string, number>();
  let total = 0;

  for (const row of rows) {
    const incidents = Number(row.incidents) || 0;
    if (incidents <= 0) continue;
    total += incidents;
    severity.set(row.severity, (severity.get(row.severity) ?? 0) + incidents);
    category.set(row.category, (category.get(row.category) ?? 0) + incidents);
    const backendKey = row.backend === "" ? "unknown" : row.backend;
    backend.set(backendKey, (backend.get(backendKey) ?? 0) + incidents);
  }

  const toBuckets = (m: Map<string, number>): DiagnosticBucket[] =>
    [...m.entries()].map(([key, count]) => ({ key, label: key, count }));

  // Severity by fixed worst-first rank; category & backend by count desc then name.
  const bySeverity = toBuckets(severity).sort(
    (a, b) => severityRank(a.key) - severityRank(b.key) || a.key.localeCompare(b.key),
  );
  const byCount = (a: DiagnosticBucket, b: DiagnosticBucket) =>
    b.count - a.count || a.key.localeCompare(b.key);

  return {
    bySeverity,
    byCategory: toBuckets(category).sort(byCount),
    byBackend: toBuckets(backend).sort(byCount),
    total,
  };
}

function severityTone(severity: string): "bad" | "warn" | "neutral" {
  if (severity === "fatal" || severity === "error") return "bad";
  if (severity === "warning") return "warn";
  return "neutral";
}

/** A small label/value cell, color-tonable for severity emphasis. */
function Cell({
  label,
  value,
  tone = "neutral",
}: {
  label: string;
  value: string;
  tone?: "neutral" | "warn" | "bad";
}) {
  const toneClass =
    tone === "bad" ? "text-red-300" : tone === "warn" ? "text-amber-300" : "text-fg-hi";
  return (
    <div className="rounded-lg border border-edge bg-ink/40 px-3 py-2.5">
      <p className="truncate text-xs uppercase tracking-wide text-fg-muted" title={label}>
        {label}
      </p>
      <p className={`mt-0.5 text-lg font-semibold tabular-nums ${toneClass}`}>{value}</p>
    </div>
  );
}

function Group({
  title,
  buckets,
  tones,
}: {
  title: string;
  buckets: DiagnosticBucket[];
  tones?: (b: DiagnosticBucket) => "neutral" | "warn" | "bad";
}) {
  return (
    <div>
      <p className="mb-1.5 text-xs font-medium uppercase tracking-wide text-fg-muted">{title}</p>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
        {buckets.map((b) => (
          <Cell key={b.key} label={b.label} value={formatNumber(b.count)} tone={tones?.(b)} />
        ))}
      </div>
    </div>
  );
}

/**
 * Opt-in engine-diagnostics overview (#16, ADR 0021 part 2): `graphics_diagnostic`
 * incident counts broken down by severity, category, and backend. Capture is
 * **off by default**, so the common case is zero rows — the empty state says so
 * explicitly rather than reading as a broken/empty panel.
 */
export function GraphicsDiagnostics({ rows }: { rows: GraphicsDiagnosticCount[] }) {
  const { bySeverity, byCategory, byBackend, total } = foldGraphicsDiagnostics(rows);

  return (
    <Panel
      title="Engine diagnostics"
      subtitle="GPU-health incidents by severity, category & backend in the selected window"
    >
      {total === 0 ? (
        <div className="space-y-1.5">
          <p className="text-sm text-fg-muted">No engine diagnostics in range.</p>
          <p className="text-xs text-fg-muted">
            Engine diagnostics (<code className="text-fg-hi">graphics_diagnostic</code>) are{" "}
            <span className="text-fg-hi">opt-in and off by default</span>. Enable{" "}
            <code className="text-fg-hi">captureGraphicsDiagnostics</code> in the SDK to surface GPU
            errors, device losses, and shader-compile failures here.
          </p>
        </div>
      ) : (
        <div className="space-y-4">
          <Group title="By severity" buckets={bySeverity} tones={(b) => severityTone(b.key)} />
          <Group title="By category" buckets={byCategory} />
          <Group title="By backend" buckets={byBackend} />
        </div>
      )}
    </Panel>
  );
}
