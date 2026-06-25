"use client";

import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import type { PanelContext, PanelDefinition, PanelSurface } from "@uptimizr/react";
import { resolvePanelSettings, usePanelData } from "@uptimizr/react";
import { Panel } from "@/components/Panel";
import { PanelSettingsForm } from "@/panels/PanelSettingsForm";
import { usePanelPrefs } from "@/panels/usePanelPrefs";

/**
 * Host for registry-driven panels (ADR 0036, extended by ADR 0039). Filters the
 * registry by the active surface and each panel's `enabled(ctx)`, then renders
 * each panel's BODY inside the shared `Panel` chrome and places it in the fixed
 * grid by `span`. Returns a fragment of grid cells so it composes inside the
 * page's existing `grid` container alongside any not-yet-migrated panels.
 *
 * Per ADR 0039 it also owns **viewer-configurable** panel state: each panel can
 * be hidden (and restored from a manage bar) and exposes its declared `settings`
 * through a "⚙" menu; both persist per surface in localStorage and thread the
 * resolved settings into each panel's `ctx.settings`.
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
  const specFor = useCallback(
    (panelId: string) => panels.find((p) => p.id === panelId)?.settings,
    [panels],
  );
  const prefs = usePanelPrefs(surface, specFor);

  // Panels eligible for this surface, each paired with its resolved settings so
  // `enabled` (and later `load`/`render`) see the viewer's overrides.
  const eligible = useMemo(
    () =>
      panels
        .filter((panel) => (panel.surfaces ?? ["overview"]).includes(surface))
        .map((panel) => {
          const settings = resolvePanelSettings(panel.settings, prefs.overridesFor(panel.id));
          return { panel, panelCtx: { ...ctx, settings } as PanelContext };
        })
        .filter(({ panel, panelCtx }) => (panel.enabled ? panel.enabled(panelCtx) : true)),
    [panels, surface, ctx, prefs],
  );

  // Before hydration nothing is hidden (matches SSR); after, apply stored state.
  const visible = prefs.hydrated
    ? eligible.filter(({ panel }) => !prefs.isHidden(panel.id))
    : eligible;
  const hiddenEligible = prefs.hydrated
    ? eligible.filter(({ panel }) => prefs.isHidden(panel.id))
    : [];

  return (
    <>
      {hiddenEligible.length > 0 ? (
        <div className="lg:col-span-2">
          <HiddenPanelsBar
            hidden={hiddenEligible.map(({ panel }) => ({ id: panel.id, title: panel.title }))}
            onRestore={prefs.show}
            onRestoreAll={prefs.showAll}
          />
        </div>
      ) : null}
      {visible.map(({ panel, panelCtx }) => (
        <div key={panel.id} className={panel.span === 2 ? "lg:col-span-2" : undefined}>
          <PanelCell
            panel={panel}
            ctx={panelCtx}
            revision={revision}
            onHide={() => prefs.hide(panel.id)}
            settingsForm={
              panel.settings ? (
                <PanelSettingsForm
                  panelId={panel.id}
                  spec={panel.settings}
                  values={panelCtx.settings}
                  onChange={(key, value) => prefs.setSetting(panel.id, key, value)}
                  onReset={() => prefs.resetSettings(panel.id)}
                />
              ) : undefined
            }
          />
        </div>
      ))}
    </>
  );
}

/** The "manage panels" affordance: restore individual hidden panels, or all. */
function HiddenPanelsBar({
  hidden,
  onRestore,
  onRestoreAll,
}: {
  hidden: { id: string; title: string }[];
  onRestore: (id: string) => void;
  onRestoreAll: () => void;
}) {
  return (
    <section className="flex flex-wrap items-center gap-2 rounded-xl border border-dashed border-edge bg-panel/60 px-4 py-2.5 text-xs text-fg-muted">
      <span className="font-medium uppercase tracking-wide">Hidden panels ({hidden.length})</span>
      {hidden.map((p) => (
        <button
          key={p.id}
          type="button"
          onClick={() => onRestore(p.id)}
          className="rounded-md border border-edge px-2 py-1 text-fg transition hover:border-amber hover:text-fg-hi"
        >
          + {p.title}
        </button>
      ))}
      <button
        type="button"
        onClick={onRestoreAll}
        className="ml-auto text-fg-muted underline-offset-2 transition hover:text-amber hover:underline"
      >
        Show all
      </button>
    </section>
  );
}

function PanelCell({
  panel,
  ctx,
  revision,
  onHide,
  settingsForm,
}: {
  panel: PanelDefinition<unknown>;
  ctx: PanelContext;
  revision: number;
  onHide: () => void;
  settingsForm?: ReactNode;
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
      onHide={onHide}
      settings={settingsForm}
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
