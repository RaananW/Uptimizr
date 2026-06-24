"use client";

import { ZOOM_IN_FACTOR, ZOOM_OUT_FACTOR } from "@/lib/orbitZoom";

/**
 * Overlay +/- zoom controls for the embedded Babylon canvases. Replaces wheel
 * zoom (which fights page scrolling) — see {@link disableWheelZoom}. `onZoom`
 * receives a radius multiplier: < 1 zooms in, > 1 zooms out. When `onReset` is
 * supplied, a recenter button is shown that restores the camera focus to the
 * scene center (see {@link resetFocus}).
 */
export function ZoomButtons({
  onZoom,
  onReset,
}: {
  onZoom: (factor: number) => void;
  onReset?: () => void;
}) {
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
      {onReset ? (
        <button
          type="button"
          aria-label="Reset camera focus to center"
          title="Reset focus to center"
          className={btn}
          onClick={onReset}
        >
          <svg
            viewBox="0 0 16 16"
            width="16"
            height="16"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.4"
            strokeLinecap="round"
            aria-hidden="true"
          >
            <circle cx="8" cy="8" r="3" />
            <path d="M8 1v2.5M8 12.5V15M1 8h2.5M12.5 8H15" />
          </svg>
        </button>
      ) : null}
    </div>
  );
}
