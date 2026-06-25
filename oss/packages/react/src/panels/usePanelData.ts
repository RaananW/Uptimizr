"use client";

import { useEffect, useState } from "react";
import type { AsyncState } from "../useAsync";
import type { PanelContext, PanelDefinition } from "./contract";

/**
 * Run a panel's `load()` against the current context, tracking
 * `{ data, loading, error }`. Each run gets a fresh `AbortSignal` that is
 * aborted on cleanup, and superseded results are ignored so a fast filter change
 * never paints stale data. Panels without a `load` resolve immediately to
 * `undefined` (they self-fetch inside `render`).
 *
 * `revision` lets the host force a refetch (e.g. throttled live updates) without
 * changing the filters.
 */
export function usePanelData<TData>(
  panel: PanelDefinition<TData>,
  ctx: PanelContext,
  revision = 0,
): AsyncState<TData> {
  const [state, setState] = useState<AsyncState<TData>>({
    data: null,
    loading: Boolean(panel.load),
    error: null,
  });

  // Re-run when the resolved query, the surface/session, or the revision change.
  // Per-panel settings (ADR 0039) also key the effect so a settings change
  // (e.g. the floor-plan `cellSize`) re-runs `load` against the new value.
  const key = JSON.stringify({ params: ctx.params, settings: ctx.settings });

  useEffect(() => {
    if (!panel.load) {
      setState({ data: null, loading: false, error: null });
      return;
    }
    let active = true;
    const controller = new AbortController();
    setState((s) => ({ ...s, loading: true, error: null }));
    panel.load({ ...ctx, signal: controller.signal }).then(
      (data) => {
        if (active) setState({ data, loading: false, error: null });
      },
      (error: unknown) => {
        if (!active || controller.signal.aborted) return;
        setState({
          data: null,
          loading: false,
          error: error instanceof Error ? error : new Error(String(error)),
        });
      },
    );
    return () => {
      active = false;
      controller.abort();
    };
    // ctx is intentionally not a dep: it is rebuilt every render, so we key on
    // the stable, serialized inputs instead.
  }, [panel, key, ctx.surface, ctx.sessionId, revision]);

  return state;
}
