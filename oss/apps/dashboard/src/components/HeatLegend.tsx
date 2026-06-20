import { HEAT_GRADIENT } from "@/lib/heat";

/**
 * A small color-scale legend for the 3D heat viewers. Overlaid in a corner of
 * the canvas, it shows the blue→hot ramp with low/high end labels and an
 * optional note explaining what the maximum represents.
 */
export function HeatLegend({
  title,
  lowLabel = "low",
  highLabel = "high",
  note,
}: {
  title: string;
  lowLabel?: string;
  highLabel?: string;
  note?: string;
}) {
  return (
    <div className="pointer-events-none absolute bottom-3 left-3 rounded-md border border-edge bg-ink/80 px-3 py-2 text-fg backdrop-blur-sm">
      <div className="mb-1 text-xs font-medium text-fg">{title}</div>
      <div className="h-2 w-36 rounded-sm" style={{ background: HEAT_GRADIENT }} />
      <div className="mt-1 flex w-36 justify-between text-[10px] text-fg-muted">
        <span>{lowLabel}</span>
        <span>{highLabel}</span>
      </div>
      {note ? (
        <div className="mt-1 max-w-44 text-[10px] leading-tight text-fg-muted">{note}</div>
      ) : null}
    </div>
  );
}
