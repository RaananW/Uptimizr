"use client";

import { useEffect, useState } from "react";
import type { PanelContext, PanelDefinition, PanelSurface } from "@uptimizr/react";
import { usePanelData } from "@uptimizr/react";
import { Panel } from "@/components/Panel";

/**
 * Host for registry-driven panels (ADR 0036). Filters the registry by the
 * active surface and each panel's `enabled(ctx)`, then renders each panel's
 * BODY inside the shared `Panel` chrome and places it in the fixed grid by
 * `span`. Returns a fragment of grid cells so it composes inside the page's
 * existing `grid` container alongside any not-yet-migrated panels.
 */
export function PanelHost({
  panels,
  ctx,
  surface,
  revision = 0,
}: {
  panels: PanelDefinition<unknown>[];
  ctx: PanelContext;
  surface: PanelSurface;
  /** Bump to force a refetch (e.g. throttled live updates) without changing filters. */
  revision?: number;
}) {
  const visible = panels.filter((panel) => {
    const surfaces = panel.surfaces ?? ["overview"];
    if (!surfaces.includes(surface)) return false;
    return panel.enabled ? panel.enabled(ctx) : true;
  });

  return (
    <>
      {visible.map((panel) => (
        <div key={panel.id} className={panel.span === 2 ? "lg:col-span-2" : undefined}>
          <PanelCell panel={panel} ctx={ctx} revision={revision} />
        </div>
      ))}
    </>
  );
}

function PanelCell({
  panel,
  ctx,
  revision,
}: {
  panel: PanelDefinition<unknown>;
  ctx: PanelContext;
  revision: number;
}) {
  const { data, loading, error } = usePanelData(panel, ctx, revision);
  const subtitle = typeof panel.subtitle === "function" ? panel.subtitle(ctx) : panel.subtitle;

  // Show the "Loading…" placeholder only while there is no data to render yet:
  // the very first fetch, or a refetch that follows an error (which resets
  // `data` to null). Once a panel has data, background refreshes (live
  // `revision` bumps, filter changes) keep its last-rendered body on screen
  // instead of collapsing to a one-line placeholder and re-expanding — that
  // swap is what makes panels "jump" as the live dashboard refetches.
  // `usePanelData` keeps the previous `data` in flight, so the existing chart
  // simply stays put until new data arrives and redraws in place. Gating on
  // `data == null` (rather than a "settled once" flag) also avoids rendering a
  // panel body with null data after an error clears on the next refetch.
  const showInitialLoading = loading && Boolean(panel.load) && data == null;

  // Client-only panels (canvas / Babylon) wait for mount to avoid hydration drift.
  const mounted = useMounted();
  const ready = !panel.clientOnly || mounted;

  return (
    <Panel
      title={panel.title}
      subtitle={subtitle}
      help={panel.help}
      collapsible={panel.collapsible}
    >
      {!ready ? null : error ? (
        <p className="text-sm text-fg-muted">Could not load: {error.message}</p>
      ) : showInitialLoading ? (
        <p className="text-sm text-fg-muted">Loading…</p>
      ) : (
        panel.render({ data, ctx })
      )}
    </Panel>
  );
}

function useMounted(): boolean {
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  return mounted;
}
