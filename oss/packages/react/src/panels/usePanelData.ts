"use client";

import { useEffect, useRef, useState } from "react";
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
 * changing the filters. A refresh is coalesced rather than restarted: when the
 * revision moves while this panel's previous load is still in flight for the
 * same panel, surface, session and settings, that load is allowed to finish
 * and exactly one more load follows it, against the latest context. Restarting
 * instead would discard every result on a backend slower than the refresh
 * cadence (the panel would never update) and pile aborted queries onto it.
 * Any other change (filters, settings, session) still aborts and reloads at once.
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
  // What a refresh may coalesce across: everything but the params, which a live
  // refresh moves on its own (a relative window's `until` advances to now).
  const identity = JSON.stringify({
    surface: ctx.surface,
    sessionId: ctx.sessionId ?? null,
    settings: ctx.settings,
  });

  // The latest context, for the follow-up load a coalesced refresh runs.
  const ctxRef = useRef(ctx);
  ctxRef.current = ctx;
  const runRef = useRef<{
    panel: PanelDefinition<TData>;
    identity: string;
    controller: AbortController;
    /** A refresh arrived while this load was in flight. */
    pending: boolean;
  } | null>(null);
  const revisionRef = useRef(revision);

  useEffect(() => {
    const refreshed = revision !== revisionRef.current;
    revisionRef.current = revision;

    const current = runRef.current;
    if (refreshed && current && current.panel === panel && current.identity === identity) {
      current.pending = true;
      return;
    }
    current?.controller.abort();
    runRef.current = null;

    if (!panel.load) {
      setState({ data: null, loading: false, error: null });
      return;
    }
    const load = panel.load;

    const start = () => {
      const controller = new AbortController();
      const run = { panel, identity, controller, pending: false };
      runRef.current = run;
      setState((s) => ({ ...s, loading: true, error: null }));
      load({ ...ctxRef.current, signal: controller.signal }).then(
        (data) => {
          if (runRef.current !== run) return;
          runRef.current = null;
          setState({ data, loading: false, error: null });
          if (run.pending) start();
        },
        (error: unknown) => {
          if (runRef.current !== run || controller.signal.aborted) return;
          runRef.current = null;
          setState({
            data: null,
            loading: false,
            error: error instanceof Error ? error : new Error(String(error)),
          });
          if (run.pending) start();
        },
      );
    };
    start();
    // ctx is intentionally not a dep: it is rebuilt every render, so we key on
    // the stable, serialized inputs instead (and read the latest via ctxRef).
  }, [panel, key, identity, revision]);

  // Abort whatever is in flight on unmount.
  useEffect(
    () => () => {
      runRef.current?.controller.abort();
      runRef.current = null;
    },
    [],
  );

  return state;
}
