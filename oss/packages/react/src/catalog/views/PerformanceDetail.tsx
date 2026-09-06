import type {
  FrameTimePercentiles,
  JankRate,
  PerfByDevice,
  PerfByScene,
  ResourcePercentiles,
  StabilityCounts,
} from "../../api";
import { formatNumber } from "../../format";

// The dedicated performance panels (ADR 0028): per-session, device-aware
// aggregates that complement the p05/p50/p95 distribution panel. Each view is a
// panel BODY only (no chrome); the host supplies title/subtitle via the ADR 0036
// panel contract.

export const FRAME_TIME_TITLE = "Frame time";
export const FRAME_TIME_SUBTITLE = "per-session median & worst-window p95";
export const JANK_TITLE = "Jank";
export const JANK_SUBTITLE = "long frames per sample window";
export const PERF_BY_DEVICE_TITLE = "FPS by device";
export const PERF_BY_DEVICE_SUBTITLE =
  "per-session median FPS, by session_start.device + UA-derived browser/OS";
export const PERF_BY_SCENE_TITLE = "FPS by scene";
export const PERF_BY_SCENE_SUBTITLE = "per-session median FPS per scene";
export const STABILITY_TITLE = "Stability";
export const STABILITY_SUBTITLE = "hard failures frame_perf can't show";
export const RESOURCE_FOOTPRINT_TITLE = "Resource footprint";
export const RESOURCE_FOOTPRINT_SUBTITLE =
  "per-session p50 / p95 of what the scene asked of the device";

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

/** Per-session median and worst-window p95 frame time. */
export function FrameTimeView({ frameTime }: { frameTime: FrameTimePercentiles | null }) {
  if (!frameTime || frameTime.sessions === 0) {
    return <p className="text-sm text-fg-muted">No frame-time samples in range.</p>;
  }
  return (
    <div className="grid grid-cols-2 gap-3">
      <Stat label="p50 frame time" value={formatNumber(frameTime.p50_ms, 1)} unit="ms" />
      <Stat label="p95 frame time" value={formatNumber(frameTime.p95_ms, 1)} unit="ms" />
    </div>
  );
}

/** Long-frame (jank) rate: the median session and the worst decile. */
export function JankView({ jank }: { jank: JankRate | null }) {
  if (!jank || jank.sessions === 0) {
    return <p className="text-sm text-fg-muted">No jank data in range.</p>;
  }
  return (
    <div className="grid grid-cols-2 gap-3">
      <Stat label="Median session" value={formatNumber(jank.median_rate, 2)} />
      <Stat label="Worst decile" value={formatNumber(jank.worst_decile_rate, 2)} />
    </div>
  );
}

/** Per-session median FPS broken down by engine backend, browser, OS, and GPU. */
export function PerfByDeviceView({ rows }: { rows: PerfByDevice[] }) {
  if (rows.length === 0) {
    return <p className="text-sm text-fg-muted">No device data in range.</p>;
  }
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-left text-sm">
        <thead className="text-xs uppercase tracking-wide text-fg-muted">
          <tr>
            <th className="py-1 pr-4 font-medium">Backend</th>
            <th className="py-1 pr-4 font-medium">Browser</th>
            <th className="py-1 pr-4 font-medium">OS</th>
            <th className="py-1 pr-4 font-medium">Mobile</th>
            <th className="py-1 pr-4 font-medium">GPU</th>
            <th className="py-1 pr-4 text-right font-medium">Sessions</th>
            <th className="py-1 text-right font-medium">p50 FPS</th>
          </tr>
        </thead>
        <tbody className="text-fg">
          {rows.map((d, i) => (
            <tr
              key={`${d.engine}|${d.browser}|${d.os}|${d.is_mobile}|${d.renderer}|${i}`}
              className="border-t border-ink/60"
            >
              <td className="py-1 pr-4">{d.engine || "—"}</td>
              <td className="py-1 pr-4">{d.browser || "—"}</td>
              <td className="py-1 pr-4">{d.os || "—"}</td>
              <td className="py-1 pr-4">{d.is_mobile === "true" ? "yes" : "no"}</td>
              <td className="py-1 pr-4 max-w-[16rem] truncate" title={d.renderer}>
                {d.renderer || "—"}
              </td>
              <td className="py-1 pr-4 text-right tabular-nums">{formatNumber(d.sessions)}</td>
              <td className="py-1 text-right tabular-nums">{formatNumber(d.p50_fps, 1)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Per-session median FPS per scene (always across every scene, independent of the scene filter). */
export function PerfBySceneView({ rows }: { rows: PerfByScene[] }) {
  if (rows.length === 0) {
    return <p className="text-sm text-fg-muted">No scene data in range.</p>;
  }
  return (
    <table className="w-full text-left text-sm">
      <thead className="text-xs uppercase tracking-wide text-fg-muted">
        <tr>
          <th className="py-1 pr-4 font-medium">Scene</th>
          <th className="py-1 pr-4 text-right font-medium">Sessions</th>
          <th className="py-1 text-right font-medium">p50 FPS</th>
        </tr>
      </thead>
      <tbody className="text-fg">
        {rows.map((s) => (
          <tr key={s.scene_id} className="border-t border-ink/60">
            <td className="py-1 pr-4">{s.scene_id || "—"}</td>
            <td className="py-1 pr-4 text-right tabular-nums">{formatNumber(s.sessions)}</td>
            <td className="py-1 text-right tabular-nums">{formatNumber(s.p50_fps, 1)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** Hard failures the frame_perf stream can't show: context losses, compile stalls, incidents. */
export function StabilityView({ stability }: { stability: StabilityCounts | null }) {
  if (!stability) {
    return <p className="text-sm text-fg-muted">No stability data in range.</p>;
  }
  return (
    <div className="grid grid-cols-3 gap-3">
      <Stat label="Context losses" value={formatNumber(stability.context_losses)} />
      <Stat label="Compile stalls" value={formatNumber(stability.compile_stalls)} />
      <Stat label="Incidents" value={formatNumber(stability.incidents)} />
    </div>
  );
}

/** Per-session p50 / p95 of JS heap, texture memory, and triangle count. */
export function ResourceFootprintView({ resources }: { resources: ResourcePercentiles | null }) {
  if (!resources || resources.sessions === 0) {
    return <p className="text-sm text-fg-muted">No resource samples in range.</p>;
  }
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
      <Stat label="p50 JS heap" value={formatMb(resources.p50_js_heap_bytes)} unit="MB" />
      <Stat label="p50 texture" value={formatMb(resources.p50_texture_bytes)} unit="MB" />
      <Stat label="p50 triangles" value={formatNumber(resources.p50_triangles)} />
      <Stat label="p95 JS heap" value={formatMb(resources.p95_js_heap_bytes)} unit="MB" />
      <Stat label="p95 texture" value={formatMb(resources.p95_texture_bytes)} unit="MB" />
      <Stat label="p95 triangles" value={formatNumber(resources.p95_triangles)} />
    </div>
  );
}
