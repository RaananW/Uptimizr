import type { MeshInteractionKind } from "@/lib/api";
import { formatNumber } from "@/lib/format";
import { Panel } from "./Panel";

export const MESH_KINDS_TITLE = "Interaction kinds";
export const MESH_KINDS_SUBTITLE = "How visitors act on each mesh";
export const MESH_KINDS_HELP =
  "Per-mesh breakdown of interaction kinds (hover, pick, click, drag, …) from mesh_interaction events. The dwell ranking says which objects draw attention; this says how people act on them — a hovered-but-never-picked mesh reads very differently from a dragged one.";

/** Stable per-kind colours (the mesh_interaction kind enum, ADR 0023). */
const KIND_COLORS: Record<string, string> = {
  hover: "#60a5fa",
  pick: "#34d399",
  click: "#fbbf24",
  drag: "#f472b6",
  select: "#a78bfa",
  squeeze: "#fb7185",
  grab: "#22d3ee",
  release: "#94a3b8",
  teleport: "#f59e0b",
};
const FALLBACK_COLOR = "#64748b";

function kindColor(kind: string): string {
  return KIND_COLORS[kind] ?? FALLBACK_COLOR;
}

interface MeshRow {
  mesh: string;
  total: number;
  kinds: { kind: string; count: number }[];
}

function groupByMesh(rows: MeshInteractionKind[], topN: number): MeshRow[] {
  const byMesh = new Map<string, MeshRow>();
  for (const r of rows) {
    let entry = byMesh.get(r.mesh);
    if (!entry) {
      entry = { mesh: r.mesh, total: 0, kinds: [] };
      byMesh.set(r.mesh, entry);
    }
    entry.kinds.push({ kind: r.kind, count: r.count });
    entry.total += r.count;
  }
  const meshes = [...byMesh.values()].sort((a, b) => b.total - a.total).slice(0, topN);
  for (const m of meshes) m.kinds.sort((a, b) => b.count - a.count);
  return meshes;
}

/**
 * Interaction-kind breakdown (#72, ADR 0023): a stacked bar per top-N mesh,
 * one segment per interaction kind. Panel BODY only (no chrome); the host
 * supplies title/subtitle/help via the ADR 0036 panel contract.
 */
export function MeshInteractionKindsView({
  rows,
  topN = 8,
}: {
  rows: MeshInteractionKind[];
  topN?: number;
}) {
  const meshes = groupByMesh(rows, topN);
  if (meshes.length === 0) {
    return <p className="text-sm text-fg-muted">No mesh interactions in range.</p>;
  }
  const kinds = [...new Set(rows.map((r) => r.kind))];
  return (
    <div className="space-y-3">
      <ul className="space-y-2">
        {meshes.map((m) => (
          <li key={m.mesh} className="text-sm">
            <div className="flex items-center justify-between gap-3">
              <span className="truncate font-mono text-xs text-fg">{m.mesh}</span>
              <span className="tabular-nums text-fg-muted">{formatNumber(m.total)}</span>
            </div>
            <div className="mt-1 flex h-2 w-full overflow-hidden rounded bg-ink/60">
              {m.kinds.map((k) => (
                <div
                  key={k.kind}
                  className="h-full"
                  style={{
                    width: `${m.total > 0 ? (k.count / m.total) * 100 : 0}%`,
                    backgroundColor: kindColor(k.kind),
                  }}
                  title={`${k.kind}: ${formatNumber(k.count)}`}
                />
              ))}
            </div>
          </li>
        ))}
      </ul>
      <ul className="flex flex-wrap gap-x-3 gap-y-1">
        {kinds.map((k) => (
          <li key={k} className="flex items-center gap-1.5 text-xs text-fg-muted">
            <span
              className="inline-block h-2 w-2 rounded-sm"
              style={{ backgroundColor: kindColor(k) }}
            />
            {k}
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Chrome-wrapped interaction-kind breakdown for legacy call sites. */
export function MeshInteractionKinds({ rows }: { rows: MeshInteractionKind[] }) {
  return (
    <Panel title={MESH_KINDS_TITLE} subtitle={MESH_KINDS_SUBTITLE} help={MESH_KINDS_HELP}>
      <MeshInteractionKindsView rows={rows} />
    </Panel>
  );
}
