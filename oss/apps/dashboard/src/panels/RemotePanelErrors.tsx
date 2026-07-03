"use client";

import { useState } from "react";
import type { RemotePanelError } from "@uptimizr/react";

/**
 * Surfaces runtime / remote panel load failures (ADR 0041) as a dismissible
 * banner. Each failed manifest or panel is listed so a self-hoster can see what
 * didn't load, while the rest of the grid keeps rendering. Renders nothing when
 * there are no errors.
 */
export function RemotePanelErrors({ errors }: { errors: RemotePanelError[] }) {
  const [dismissed, setDismissed] = useState(false);
  if (errors.length === 0 || dismissed) return null;

  return (
    <section className="rounded-xl border border-dashed border-amber/60 bg-panel/60 px-4 py-3 text-xs text-fg-muted">
      <div className="flex items-center justify-between gap-2">
        <span className="font-medium uppercase tracking-wide text-fg">
          {errors.length} panel{errors.length === 1 ? "" : "s"} failed to load
        </span>
        <button
          type="button"
          onClick={() => setDismissed(true)}
          className="text-fg-muted underline-offset-2 transition hover:text-amber hover:underline"
        >
          Dismiss
        </button>
      </div>
      <ul className="mt-2 space-y-1">
        {errors.map((err, i) => (
          <li key={`${err.source}-${i}`} className="font-mono">
            <span className="text-fg">{err.source}</span>
            <span className="text-fg-muted">
              {" "}
              — [{err.code}] {err.message}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}
