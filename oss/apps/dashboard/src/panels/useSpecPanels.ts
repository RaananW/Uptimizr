"use client";

import { useCallback, useEffect, useState } from "react";
import type { CollectorApi, PanelDefinition, RemotePanelError } from "@uptimizr/react";
import { loadSpecPanels } from "@uptimizr/react";

export interface SpecPanelsState {
  /** Panels built from the project's stored specs (#315). */
  readonly panels: PanelDefinition<unknown>[];
  /** Per-spec failures, surfaced without throwing — one bad spec is not a blank grid. */
  readonly errors: RemotePanelError[];
  /** Whether the configured key may pin and unpin (`annotate`). */
  readonly canPin: boolean;
  /** True while a fetch is in flight. */
  readonly loading: boolean;
  /** Re-fetch the project's panels — called after a pin or an unpin. */
  reload: () => void;
  /** Unpin one panel and refresh the grid. No-op without `annotate`. */
  unpin: (specId: string) => Promise<void>;
}

/** Nothing loaded, nothing failed, nothing permitted — the pre-connection state. */
type SpecPanelsData = Omit<SpecPanelsState, "reload" | "unpin">;
const EMPTY: SpecPanelsData = { panels: [], errors: [], canPin: false, loading: false };

/**
 * Load the project's **declarative panel specs** on mount (#315, ADR 0051 §7).
 *
 * The sibling of `useRemotePanels` (ADR 0041), and deliberately shaped like it —
 * same `RemotePanelError` list, same "never throws", same "the host merges what
 * came back with `builtinPanels`". The difference is what is loaded: a remote
 * panel is an ES module that runs with the dashboard's privileges, while a spec
 * is **data** the dashboard renders with panels it already ships. That is why
 * this hook needs no manifest URL, no origin allowlist and no opt-in: there is
 * nothing here to trust.
 *
 * It also asks `whoami` once, so the grid offers an unpin control only to a key
 * that actually holds `annotate`. That is courtesy, not security — the collector
 * refuses the write either way.
 */
export function useSpecPanels(api: CollectorApi | null): SpecPanelsState {
  const [state, setState] = useState<SpecPanelsData>(EMPTY);
  const [revision, setRevision] = useState(0);

  useEffect(() => {
    if (api == null) {
      setState(EMPTY);
      return;
    }
    let cancelled = false;
    setState((prev) => ({ ...prev, loading: true }));

    void (async () => {
      // The capability probe must not be able to fail the load: a collector too
      // old to serve `whoami` still serves panels, and the only consequence of
      // not knowing is that no unpin control is offered.
      const canPin = await api
        .whoami()
        .then((who) => who.capabilities.includes("annotate"))
        .catch(() => false);
      const { panels, errors } = await loadSpecPanels(api);
      if (!cancelled) setState({ panels, errors, canPin, loading: false });
    })();

    return () => {
      cancelled = true;
    };
  }, [api, revision]);

  const reload = useCallback(() => setRevision((r) => r + 1), []);

  const unpin = useCallback(
    async (specId: string) => {
      if (api == null) return;
      await api.unpinPanel(specId);
      setRevision((r) => r + 1);
    },
    [api],
  );

  return { ...state, reload, unpin };
}
