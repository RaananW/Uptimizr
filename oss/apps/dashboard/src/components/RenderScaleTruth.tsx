import type { RenderScaleTruth as RenderScaleTruthData } from "@/lib/api";
import { formatNumber } from "@/lib/format";
import { Panel } from "./Panel";

export const RENDER_SCALE_TITLE = "Render-scale truth";
export const RENDER_SCALE_SUBTITLE = "Is that FPS real, or downscaled?";
export const RENDER_SCALE_HELP =
  "Adaptive renderers keep frame rate up by quietly dropping resolution. This pairs the FPS headline with the render scale that bought it, and flags the 'good FPS at a low render scale' case where the headline overstates the real device experience.";

function pct(x: number): string {
  return `${Math.round(x * 100)}%`;
}

/**
 * Render-scale truth (#71, ADR 0021): the FPS headline paired with the
 * resolution the engine actually rendered at. Panel BODY only (no chrome); the
 * host supplies title/subtitle/help via the ADR 0036 panel contract.
 */
export function RenderScaleTruthView({ data }: { data: RenderScaleTruthData }) {
  if (!data || data.samples === 0) {
    return <p className="text-sm text-fg-muted">No frame-perf samples in range.</p>;
  }
  // "Good FPS at low render scale": the frame rate looks healthy, but the engine
  // is paying for it with resolution. A median render scale below 0.9 alongside
  // a median FPS at or above 50 is the classic hidden-cost signature.
  const flagged = data.p50_fps >= 50 && data.p50_render_scale > 0 && data.p50_render_scale < 0.9;
  const stats: { label: string; value: string }[] = [
    { label: "Median FPS", value: formatNumber(Math.round(data.p50_fps)) },
    { label: "Avg FPS", value: formatNumber(Math.round(data.avg_fps)) },
    { label: "Median render scale", value: pct(data.p50_render_scale) },
    { label: "Avg render scale", value: pct(data.avg_render_scale) },
    { label: "Downscaled frames", value: pct(data.downscaled_share) },
    { label: "Samples", value: formatNumber(data.samples) },
  ];
  return (
    <div className="space-y-3">
      <dl className="grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-3">
        {stats.map((s) => (
          <div key={s.label}>
            <dt className="text-xs text-fg-muted">{s.label}</dt>
            <dd className="tabular-nums text-lg text-fg">{s.value}</dd>
          </div>
        ))}
      </dl>
      {flagged ? (
        <p className="rounded-md border border-amber/40 bg-amber/10 px-3 py-2 text-xs text-amber">
          Good FPS is being bought with resolution — the median frame renders at{" "}
          {pct(data.p50_render_scale)} scale. The headline FPS overstates the device experience.
        </p>
      ) : null}
    </div>
  );
}

/** Chrome-wrapped render-scale truth for legacy call sites. */
export function RenderScaleTruth({ data }: { data: RenderScaleTruthData }) {
  return (
    <Panel title={RENDER_SCALE_TITLE} subtitle={RENDER_SCALE_SUBTITLE} help={RENDER_SCALE_HELP}>
      <RenderScaleTruthView data={data} />
    </Panel>
  );
}
