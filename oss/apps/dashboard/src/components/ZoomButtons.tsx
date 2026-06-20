"use client";

import { ZOOM_IN_FACTOR, ZOOM_OUT_FACTOR } from "@/lib/orbitZoom";

/**
 * Overlay +/- zoom controls for the embedded Babylon canvases. Replaces wheel
 * zoom (which fights page scrolling) — see {@link disableWheelZoom}. `onZoom`
 * receives a radius multiplier: < 1 zooms in, > 1 zooms out.
 */
export function ZoomButtons({ onZoom }: { onZoom: (factor: number) => void }) {
  const btn =
    "grid h-8 w-8 place-items-center rounded-md border border-edge bg-ink/80 text-lg leading-none text-fg backdrop-blur transition hover:bg-ink hover:text-white";
  return (
    <div className="absolute right-3 top-3 flex flex-col gap-1">
      <button
        type="button"
        aria-label="Zoom in"
        className={btn}
        onClick={() => onZoom(ZOOM_IN_FACTOR)}
      >
        +
      </button>
      <button
        type="button"
        aria-label="Zoom out"
        className={btn}
        onClick={() => onZoom(ZOOM_OUT_FACTOR)}
      >
        &minus;
      </button>
    </div>
  );
}
