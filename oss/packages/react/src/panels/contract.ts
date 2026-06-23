// The dashboard panel contract (ADR 0036).
//
// A panel is a plain, declarative object — not a bespoke component tree. The
// HOST (the standalone dashboard, or any embedding app) owns the chrome and the
// layout; a panel's `render()` returns the panel BODY only. Everything a panel
// needs from its host arrives through one `PanelContext`, so the same definition
// can power the standalone dashboard and an embed.
//
// The contract is intentionally powerful enough to express every built-in
// panel: the declarative `load` / `render` path covers the simple majority, and
// because `render` also receives the full context, advanced panels (self-
// fetching sub-controls, live SSE streams, Babylon 3D scenes) self-manage
// through the same context.

import type { ReactNode } from "react";
import type { CollectorApi, PresenceSnapshot, QueryParams } from "../api";
import type { FilterState } from "../filters";
import type { LiveEvent } from "../live";

/** Which dashboard surface a panel can appear on. */
export type PanelSurface = "overview" | "session";

/** Fixed-grid width: 1 = half width, 2 = full width. */
export type PanelSpan = 1 | 2;

/** Capability flags derived from the active range, for `enabled` / `render`. */
export interface PanelCapabilities {
  /** Whether the active range has first-person camera-position samples (ADR 0026). */
  hasFirstPerson: boolean;
}

/** Host actions a panel can invoke (e.g. from a row click or a brush). */
export interface PanelActions {
  /** Open a session drill-down (switches to the session surface). */
  selectSession(id: string): void;
  /** Set a custom time window — e.g. from a time-series brush (epoch ms). */
  setTimeRange(since: number, until: number): void;
  /** Patch the global filter state. */
  setFilters(patch: Partial<FilterState>): void;
}

/** Live-layer access for SSE-driven panels (ADR 0032). */
export interface PanelLive {
  /** Latest presence snapshot, or `null` when the live layer is disabled. */
  readonly presence: PresenceSnapshot | null;
  /** Whether the live layer is currently enabled (key set + opted in). */
  readonly enabled: boolean;
  /** Subscribe to the live event firehose; returns an unsubscribe fn. */
  subscribe(handler: (event: LiveEvent) => void): () => void;
}

/** Everything a panel needs from its host. */
export interface PanelContext {
  /** Shared query client bound to the active collector. */
  readonly api: CollectorApi;
  /** Raw collector connection (for self-fetch / SSE URLs). */
  readonly baseUrl: string;
  readonly apiKey: string;
  /** Query params resolved from the global filter bar (since/until/scene/source/cameraMode). */
  readonly params: QueryParams;
  /** Raw filter state (panels that need `cameraMode` etc. directly). */
  readonly filters: FilterState;
  /** Current surface + optional session scope. */
  readonly surface: PanelSurface;
  readonly sessionId?: string;
  /** Capability flags derived from the active range. */
  readonly capabilities: PanelCapabilities;
  /** Host actions a panel can invoke. */
  readonly actions: PanelActions;
  /** Live-layer access. */
  readonly live: PanelLive;
}

/** Context passed to `load()`; adds an `AbortSignal` for in-flight cancellation. */
export interface PanelDataContext extends PanelContext {
  readonly signal: AbortSignal;
}

/**
 * A self-contained dashboard panel. `TData` is the shape returned by `load` and
 * handed to `render`; panels that self-fetch in `render` omit `load` and leave
 * `TData` as `void`.
 */
export interface PanelDefinition<TData = void> {
  /** Stable, unique id (used for layout keys and dedupe). */
  readonly id: string;
  /** Panel title shown in the chrome. */
  readonly title: string;
  /** Optional subtitle — static, or derived from the active context. */
  readonly subtitle?: string | ((ctx: PanelContext) => string | undefined);
  /** Optional "?" help content shown in the chrome. */
  readonly help?: ReactNode;
  /** Fixed-grid width. Default `1` (half width). */
  readonly span?: PanelSpan;
  /** Surfaces this panel renders on. Default `["overview"]`. */
  readonly surfaces?: PanelSurface[];
  /** Whether the panel chrome can collapse. */
  readonly collapsible?: boolean;
  /** Render client-only (no SSR) — for canvas / Babylon panels. */
  readonly clientOnly?: boolean;
  /** Show/hide based on filters + capabilities (e.g. first-person only). */
  enabled?(ctx: PanelContext): boolean;
  /** Declarative data load. Omit for panels that self-fetch inside `render`. */
  load?(ctx: PanelDataContext): Promise<TData>;
  /** Render the panel BODY (the host supplies chrome + layout). */
  render(props: { data: TData; ctx: PanelContext }): ReactNode;
}

/**
 * Identity helper that preserves a panel's `TData` inference. Authoring a panel
 * with `definePanel({ ... })` keeps `load`'s return type flowing into `render`'s
 * `data` argument.
 */
export function definePanel<TData>(def: PanelDefinition<TData>): PanelDefinition<TData> {
  return def;
}
