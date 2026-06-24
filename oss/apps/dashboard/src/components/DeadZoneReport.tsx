import type { Aabb, CoverageVoxel, SceneProxyMesh } from "@/lib/api";
import { formatNumber } from "@/lib/format";
import { Panel } from "./Panel";

export const DEAD_ZONE_TITLE = "Dead-zone report";
export const DEAD_ZONE_SUBTITLE = "Scene parts visitors never approach";
export const DEAD_ZONE_HELP =
  "The negative space: registered proxy meshes (ADR 0014) with near-zero camera proximity, computed by subtracting the occupied camera-position voxels (scene coverage) from the scene's proxy geometry. Ranked coldest first. Requires a registered scene proxy to know which regions could be visited.";

/** How many cells of slack to treat as "near" a mesh when intersecting voxels. */
const DEFAULT_PADDING_CELLS = 1;
/** Cap proxy meshes scanned so the client-side intersection stays bounded. */
const MAX_MESHES = 600;

interface DeadZoneRow {
  mesh: string;
  path?: string;
  /** Camera-position samples that landed near (within the padded AABB of) the mesh. */
  nearbySamples: number;
  dead: boolean;
}

interface DeadZoneReport {
  rows: DeadZoneRow[];
  deadCount: number;
  total: number;
}

/** Whether a voxel centre lies inside an AABB padded by `pad` world units. */
function voxelNearAabb(
  vx: number,
  vy: number,
  vz: number,
  cellSize: number,
  aabb: Aabb,
  pad: number,
): boolean {
  const cx = (vx + 0.5) * cellSize;
  const cy = (vy + 0.5) * cellSize;
  const cz = (vz + 0.5) * cellSize;
  const [minX, minY, minZ, maxX, maxY, maxZ] = aabb;
  return (
    cx >= minX - pad &&
    cx <= maxX + pad &&
    cy >= minY - pad &&
    cy <= maxY + pad &&
    cz >= minZ - pad &&
    cz <= maxZ + pad
  );
}

/**
 * Dead-zone report (#76): for each proxy mesh, sum the camera-position samples
 * (scene-coverage voxels) that fall within its padded AABB, then rank coldest
 * first. A mesh with no nearby samples is "dead". Computed client-side (intersect
 * proxy AABBs with coverage voxels) to avoid a new server join. Exported for tests.
 */
export function buildDeadZones(
  coverage: CoverageVoxel[],
  proxyMeshes: SceneProxyMesh[],
  cellSize: number,
  paddingCells = DEFAULT_PADDING_CELLS,
): DeadZoneReport {
  const pad = cellSize * paddingCells;
  const meshes = proxyMeshes.slice(0, MAX_MESHES);
  const rows: DeadZoneRow[] = meshes.map((m) => {
    let nearbySamples = 0;
    for (const v of coverage) {
      if (voxelNearAabb(v.vx, v.vy, v.vz, cellSize, m.aabb, pad)) nearbySamples += v.count;
    }
    return { mesh: m.name, path: m.path, nearbySamples, dead: nearbySamples === 0 };
  });
  rows.sort((a, b) => a.nearbySamples - b.nearbySamples);
  return { rows, deadCount: rows.filter((r) => r.dead).length, total: rows.length };
}

/**
 * Dead-zone report table (#76): the coldest proxy meshes by camera proximity,
 * with a graceful empty-state when no proxy is registered. Panel BODY only; the
 * host supplies the chrome via the ADR 0036 panel contract.
 */
export function DeadZoneReportView({
  coverage,
  proxyMeshes,
  cellSize,
  topN = 12,
}: {
  coverage: CoverageVoxel[];
  proxyMeshes: SceneProxyMesh[];
  cellSize: number;
  topN?: number;
}) {
  if (proxyMeshes.length === 0) {
    return (
      <div className="space-y-2 text-sm text-fg-muted">
        <p>No scene proxy is registered, so there is no reference geometry to call “dead”.</p>
        <p>
          Register proxy geometry (ADR 0014) via the scene representation API to enumerate the
          regions visitors could approach.
        </p>
      </div>
    );
  }
  if (coverage.length === 0) {
    return (
      <p className="text-sm text-fg-muted">
        No camera-position samples in range — every region reads as dead. Widen the range or check
        that first-person camera samples are being captured.
      </p>
    );
  }

  const report = buildDeadZones(coverage, proxyMeshes, cellSize);
  const max = report.rows.reduce((m, r) => Math.max(m, r.nearbySamples), 0) || 1;
  const coldest = report.rows.slice(0, topN);

  return (
    <div className="space-y-3">
      <p className="text-xs text-fg-muted">
        <span className="tabular-nums text-fg">{formatNumber(report.deadCount)}</span> of{" "}
        <span className="tabular-nums text-fg">{formatNumber(report.total)}</span> proxy meshes are
        dead (no nearby camera samples).
      </p>
      <ul className="space-y-1.5">
        {coldest.map((r) => (
          <li key={r.path ?? r.mesh} className="text-sm">
            <div className="flex items-center justify-between gap-3">
              <span className="truncate font-mono text-xs text-fg" title={r.path ?? r.mesh}>
                {r.mesh}
              </span>
              {r.dead ? (
                <span className="shrink-0 rounded bg-rose-500/20 px-1.5 text-xs text-rose-300">
                  dead
                </span>
              ) : (
                <span className="shrink-0 tabular-nums text-xs text-fg-muted">
                  {formatNumber(r.nearbySamples)}
                </span>
              )}
            </div>
            <div className="mt-1 h-1.5 w-full overflow-hidden rounded bg-ink/60">
              <div
                className="h-full rounded bg-sky-500/70"
                style={{ width: `${(r.nearbySamples / max) * 100}%` }}
              />
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Chrome-wrapped dead-zone report for legacy call sites. */
export function DeadZoneReportPanel({
  coverage,
  proxyMeshes,
  cellSize,
}: {
  coverage: CoverageVoxel[];
  proxyMeshes: SceneProxyMesh[];
  cellSize: number;
}) {
  return (
    <Panel title={DEAD_ZONE_TITLE} subtitle={DEAD_ZONE_SUBTITLE} help={DEAD_ZONE_HELP}>
      <DeadZoneReportView coverage={coverage} proxyMeshes={proxyMeshes} cellSize={cellSize} />
    </Panel>
  );
}
