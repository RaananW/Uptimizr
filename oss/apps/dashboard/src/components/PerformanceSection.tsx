import type {
  FpsHistogramBin,
  FrameTimePercentiles,
  JankRate,
  PerfByDevice,
  PerfByScene,
  PerfDistribution,
  ResourcePercentiles,
  StabilityCounts,
} from "@/lib/api";
import { formatNumber } from "@/lib/format";
import { Panel } from "./Panel";

/** All performance aggregates the section renders (ADR 0028). */
export interface PerformanceData {
  distribution: PerfDistribution | null;
  histogram: FpsHistogramBin[];
  frameTime: FrameTimePercentiles | null;
  jank: JankRate | null;
  byDevice: PerfByDevice[];
  byScene: PerfByScene[];
  resources: ResourcePercentiles | null;
  stability: StabilityCounts | null;
}

function Stat({ label, value, unit }: { label: string; value: string; unit?: string }) {
  return (
    <div className="rounded-lg bg-ink/60 p-3">
      <div className="text-xs uppercase tracking-wide text-fg-muted">{label}</div>
      <div className="mt-1 text-2xl font-semibold tabular-nums text-fg-hi">
        {value}
        {unit ? <span className="ml-1 text-sm font-normal text-fg-muted">{unit}</span> : null}
      </div>
    </div>
  );
}

function formatMb(bytes: number): string {
  return formatNumber(bytes / 1_048_576, 1);
}

/** Horizontal bar histogram of per-session median FPS (one session = one count). */
function FpsHistogram({ bins }: { bins: FpsHistogramBin[] }) {
  if (bins.length === 0) {
    return <p className="text-sm text-fg-muted">No FPS samples in range.</p>;
  }
  const sorted = [...bins].sort((a, b) => a.bucket - b.bucket);
  const max = sorted.reduce((m, b) => Math.max(m, b.sessions), 0) || 1;
  // Infer the bin width from the first two buckets (builder default is 10).
  const width = sorted.length > 1 ? sorted[1]!.bucket - sorted[0]!.bucket : 10;
  return (
    <div className="space-y-1.5">
      {sorted.map((b) => (
        <div key={b.bucket} className="flex items-center gap-2 text-xs">
          <span className="w-16 shrink-0 text-right tabular-nums text-fg-muted">
            {b.bucket}–{b.bucket + width}
          </span>
          <div className="h-4 flex-1 overflow-hidden rounded bg-ink/60">
            <div
              className="h-full rounded bg-emerald-500/70"
              style={{ width: `${(b.sessions / max) * 100}%` }}
            />
          </div>
          <span className="w-10 shrink-0 tabular-nums text-fg-muted">{b.sessions}</span>
        </div>
      ))}
    </div>
  );
}

/**
 * Dedicated performance view (ADR 0028): a distribution-honest, per-session,
 * device-aware picture of rendering performance — FPS distribution + histogram,
 * frame-time, jank, device/scene breakdowns, resource footprint, and stability.
 * Percentiles are computed per-session then aggregated, so neither long sessions
 * nor fast devices skew the headline numbers.
 */
export function PerformanceSection({ data }: { data: PerformanceData }) {
  const { distribution, histogram, frameTime, jank, byDevice, byScene, resources, stability } =
    data;
  const hasFps = (distribution?.samples ?? 0) > 0;

  return (
    <section className="space-y-4">
      <h2 className="text-sm font-semibold uppercase tracking-wide text-fg-muted">Performance</h2>

      <Panel
        title="FPS distribution"
        subtitle="per-session p05 / p50 / p95, summarized across sessions"
      >
        {!hasFps ? (
          <p className="text-sm text-fg-muted">No performance samples in range.</p>
        ) : (
          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              <Stat label="p05 FPS (worst)" value={formatNumber(distribution!.p05_fps, 1)} />
              <Stat label="p50 FPS (typical)" value={formatNumber(distribution!.p50_fps, 1)} />
              <Stat label="p95 FPS (best)" value={formatNumber(distribution!.p95_fps, 1)} />
              <Stat label="Sessions" value={formatNumber(distribution!.sessions)} />
            </div>
            <FpsHistogram bins={histogram} />
          </div>
        )}
      </Panel>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Panel title="Frame time" subtitle="per-session median & worst-window p95">
          {!frameTime || frameTime.sessions === 0 ? (
            <p className="text-sm text-fg-muted">No frame-time samples in range.</p>
          ) : (
            <div className="grid grid-cols-2 gap-3">
              <Stat label="p50 frame time" value={formatNumber(frameTime.p50_ms, 1)} unit="ms" />
              <Stat label="p95 frame time" value={formatNumber(frameTime.p95_ms, 1)} unit="ms" />
            </div>
          )}
        </Panel>

        <Panel title="Jank" subtitle="long frames per sample window">
          {!jank || jank.sessions === 0 ? (
            <p className="text-sm text-fg-muted">No jank data in range.</p>
          ) : (
            <div className="grid grid-cols-2 gap-3">
              <Stat label="Median session" value={formatNumber(jank.median_rate, 2)} />
              <Stat label="Worst decile" value={formatNumber(jank.worst_decile_rate, 2)} />
            </div>
          )}
        </Panel>
      </div>

      <Panel
        title="FPS by device"
        subtitle="per-session median FPS, attributed to session_start.device"
      >
        {byDevice.length === 0 ? (
          <p className="text-sm text-fg-muted">No device data in range.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="text-xs uppercase tracking-wide text-fg-muted">
                <tr>
                  <th className="py-1 pr-4 font-medium">Backend</th>
                  <th className="py-1 pr-4 font-medium">Mobile</th>
                  <th className="py-1 pr-4 font-medium">GPU</th>
                  <th className="py-1 pr-4 text-right font-medium">Sessions</th>
                  <th className="py-1 text-right font-medium">p50 FPS</th>
                </tr>
              </thead>
              <tbody className="text-fg">
                {byDevice.map((d, i) => (
                  <tr
                    key={`${d.engine}|${d.is_mobile}|${d.renderer}|${i}`}
                    className="border-t border-ink/60"
                  >
                    <td className="py-1 pr-4">{d.engine || "—"}</td>
                    <td className="py-1 pr-4">{d.is_mobile === "true" ? "yes" : "no"}</td>
                    <td className="py-1 pr-4 max-w-[16rem] truncate" title={d.renderer}>
                      {d.renderer || "—"}
                    </td>
                    <td className="py-1 pr-4 text-right tabular-nums">
                      {formatNumber(d.sessions)}
                    </td>
                    <td className="py-1 text-right tabular-nums">{formatNumber(d.p50_fps, 1)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Panel title="FPS by scene" subtitle="per-session median FPS per scene">
          {byScene.length === 0 ? (
            <p className="text-sm text-fg-muted">No scene data in range.</p>
          ) : (
            <table className="w-full text-left text-sm">
              <thead className="text-xs uppercase tracking-wide text-fg-muted">
                <tr>
                  <th className="py-1 pr-4 font-medium">Scene</th>
                  <th className="py-1 pr-4 text-right font-medium">Sessions</th>
                  <th className="py-1 text-right font-medium">p50 FPS</th>
                </tr>
              </thead>
              <tbody className="text-fg">
                {byScene.map((s) => (
                  <tr key={s.scene_id} className="border-t border-ink/60">
                    <td className="py-1 pr-4">{s.scene_id || "—"}</td>
                    <td className="py-1 pr-4 text-right tabular-nums">
                      {formatNumber(s.sessions)}
                    </td>
                    <td className="py-1 text-right tabular-nums">{formatNumber(s.p50_fps, 1)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Panel>

        <Panel title="Stability" subtitle="hard failures frame_perf can't show">
          {!stability ? (
            <p className="text-sm text-fg-muted">No stability data in range.</p>
          ) : (
            <div className="grid grid-cols-3 gap-3">
              <Stat label="Context losses" value={formatNumber(stability.context_losses)} />
              <Stat label="Compile stalls" value={formatNumber(stability.compile_stalls)} />
              <Stat label="Incidents" value={formatNumber(stability.incidents)} />
            </div>
          )}
        </Panel>
      </div>

      <Panel
        title="Resource footprint"
        subtitle="per-session p50 / p95 of what the scene asked of the device"
      >
        {!resources || resources.sessions === 0 ? (
          <p className="text-sm text-fg-muted">No resource samples in range.</p>
        ) : (
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
            <Stat label="p50 JS heap" value={formatMb(resources.p50_js_heap_bytes)} unit="MB" />
            <Stat label="p50 texture" value={formatMb(resources.p50_texture_bytes)} unit="MB" />
            <Stat label="p50 triangles" value={formatNumber(resources.p50_triangles)} />
            <Stat label="p95 JS heap" value={formatMb(resources.p95_js_heap_bytes)} unit="MB" />
            <Stat label="p95 texture" value={formatMb(resources.p95_texture_bytes)} unit="MB" />
            <Stat label="p95 triangles" value={formatNumber(resources.p95_triangles)} />
          </div>
        )}
      </Panel>
    </section>
  );
}
