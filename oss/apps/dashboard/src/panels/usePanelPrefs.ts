"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  EMPTY_PANEL_STATE,
  createLocalStoragePanelStore,
  pruneDefaultOverrides,
  type AnyPanelSettingValue,
  type PanelDefinition,
  type PanelState,
  type PanelStateStore,
  type PanelSurface,
} from "@uptimizr/react";

/** localStorage key for one dashboard surface's viewer panel state (ADR 0039). */
function storageKeyFor(surface: PanelSurface): string {
  return `uptimizr:dashboard:panels:${surface}`;
}

/** A panel's setting spec keyed by id, for pruning overrides back to defaults. */
type SpecLookup = (panelId: string) => PanelDefinition<unknown>["settings"];

/**
 * Viewer-scoped panel preferences for one surface (ADR 0039): which panels are
 * hidden and any per-panel setting overrides, persisted via a {@link PanelStateStore}
 * (localStorage by default; pass `store` to back it with an embed's own store).
 *
 * SSR-safe: the first render (server + first client paint) uses the empty state,
 * then the stored state is applied after mount, so a `clientOnly` panel that was
 * hidden simply drops out post-hydration rather than mismatching the server HTML.
 * `hydrated` lets the host defer visibility filtering until that swap.
 */
export function usePanelPrefs(
  surface: PanelSurface,
  specFor: SpecLookup,
  store?: PanelStateStore,
) {
  const resolvedStore = useMemo(
    () => store ?? createLocalStoragePanelStore(storageKeyFor(surface)),
    [store, surface],
  );

  const [state, setState] = useState<PanelState>(EMPTY_PANEL_STATE);
  const [hydrated, setHydrated] = useState(false);

  // `specFor` is rebuilt each render; keep it in a ref so `commit` stays stable.
  const specRef = useRef(specFor);
  specRef.current = specFor;

  useEffect(() => {
    setState(resolvedStore.load());
    setHydrated(true);
  }, [resolvedStore]);

  const commit = useCallback(
    (next: PanelState) => {
      setState(next);
      resolvedStore.save(next);
    },
    [resolvedStore],
  );

  const hide = useCallback(
    (id: string) => {
      setState((prev) => {
        if (prev.hidden.includes(id)) return prev;
        const next = { ...prev, hidden: [...prev.hidden, id] };
        resolvedStore.save(next);
        return next;
      });
    },
    [resolvedStore],
  );

  const show = useCallback(
    (id: string) => {
      setState((prev) => {
        if (!prev.hidden.includes(id)) return prev;
        const next = { ...prev, hidden: prev.hidden.filter((h) => h !== id) };
        resolvedStore.save(next);
        return next;
      });
    },
    [resolvedStore],
  );

  const showAll = useCallback(() => {
    setState((prev) => {
      if (prev.hidden.length === 0) return prev;
      const next = { ...prev, hidden: [] };
      resolvedStore.save(next);
      return next;
    });
  }, [resolvedStore]);

  const setSetting = useCallback(
    (panelId: string, key: string, value: AnyPanelSettingValue) => {
      setState((prev) => {
        const merged = { ...(prev.settings[panelId] ?? {}), [key]: value };
        const pruned = pruneDefaultOverrides(specRef.current(panelId), merged);
        const settings = { ...prev.settings };
        if (Object.keys(pruned).length > 0) settings[panelId] = pruned;
        else delete settings[panelId];
        const next = { ...prev, settings };
        resolvedStore.save(next);
        return next;
      });
    },
    [resolvedStore],
  );

  const resetSettings = useCallback(
    (panelId: string) => {
      setState((prev) => {
        if (!prev.settings[panelId]) return prev;
        const settings = { ...prev.settings };
        delete settings[panelId];
        const next = { ...prev, settings };
        resolvedStore.save(next);
        return next;
      });
    },
    [resolvedStore],
  );

  const overridesFor = useCallback(
    (panelId: string): Record<string, AnyPanelSettingValue> => state.settings[panelId] ?? {},
    [state],
  );

  const isHidden = useCallback((id: string) => state.hidden.includes(id), [state]);

  return {
    hydrated,
    hidden: state.hidden,
    isHidden,
    hide,
    show,
    showAll,
    overridesFor,
    setSetting,
    resetSettings,
    /** Replace the whole state (used by tests / bulk resets). */
    replace: commit,
  };
}

export type PanelPrefs = ReturnType<typeof usePanelPrefs>;
