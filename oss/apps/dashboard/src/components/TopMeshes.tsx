import type { MeshCount } from "@/lib/api";
import { formatNumber } from "@/lib/format";
import { Panel } from "./Panel";

export function TopMeshes({ meshes }: { meshes: MeshCount[] }) {
  const max = meshes.reduce((m, x) => Math.max(m, x.count), 0);
  return (
    <Panel title="Top meshes" subtitle="Most-interacted meshes">
      {meshes.length === 0 ? (
        <p className="text-sm text-fg-muted">No mesh interactions in range.</p>
      ) : (
        <ul className="space-y-1.5">
          {meshes.map((m) => (
            <li key={m.mesh} className="text-sm">
              <div className="flex items-center justify-between gap-3">
                <span className="truncate font-mono text-xs text-fg">{m.mesh}</span>
                <span className="tabular-nums text-fg-muted">{formatNumber(m.count)}</span>
              </div>
              <div className="mt-1 h-1.5 w-full overflow-hidden rounded bg-ink/60">
                <div
                  className="h-full rounded bg-amber"
                  style={{ width: `${max > 0 ? (m.count / max) * 100 : 0}%` }}
                />
              </div>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}
