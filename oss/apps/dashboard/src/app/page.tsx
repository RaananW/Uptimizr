"use client";

import dynamic from "next/dynamic";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ApiError,
  CollectorApi,
  COLLECTOR_URL_IS_PINNED,
  DEFAULT_API_KEY,
  DEFAULT_COLLECTOR_URL,
  DEFAULT_PLAYGROUND_URL,
  type SceneInfo,
  type SessionMeta,
} from "@/lib/api";
import {
  DEFAULT_FILTERS,
  resolveRange,
  toQueryParams,
  type FilterState,
  type TimeWindow,
} from "@/lib/filters";
import {
  LivePresenceView,
  LIVE_PRESENCE_TITLE,
  LIVE_PRESENCE_SUBTITLE,
  LIVE_PRESENCE_HELP,
} from "@uptimizr/react";
import { useLivePresence, useLiveStream, type LiveEvent } from "@/lib/live";
import type { PanelContext, PanelDefinition, RemotePanelError } from "@uptimizr/react";
import { mergePanels } from "@uptimizr/react";
import { PanelHost } from "@/panels/PanelHost";
import { Panel } from "@/components/Panel";
import { builtinPanels } from "@/panels/registry";
import { useRemotePanels } from "@/panels/useRemotePanels";
import { RemotePanelErrors } from "@/panels/RemotePanelErrors";
import { AssistantDrawer } from "@/components/AssistantDrawer";
import { GlobalFilters } from "@/components/GlobalFilters";
import { SceneSelector, type SceneMeta } from "@/components/SceneSelector";
import { SessionInspector } from "@/components/SessionInspector";

// The session replay is Babylon-backed and loads only in the browser (no SSR,
// lazy chunk). Every other analytics panel comes from the `@uptimizr/react`
// catalog through `PanelHost` (ADR 0036 / ADR 0047); the page owns only the
// shell — connection form, filters, scene selector, session inspector, replay
// and live-presence mounts, and the live SSE wiring.
const SessionReplayView = dynamic(
  () => import("@uptimizr/react/panels-3d").then((m) => m.SessionReplayView),
  { ssr: false },
);

const FLOOR_CELL_SIZE = 1;
/** Maximum rows kept in the in-memory live event feed (ADR 0032 §3). */
const LIVE_FEED_MAX = 30;
/** Minimum gap between live-triggered aggregate refetches (ms). */
const LIVE_REFETCH_THROTTLE_MS = 5_000;
/**
 * Per-session drill-down. The shell keeps only the session's identity and
 * metadata; every analytics panel scopes itself to the session through the
 * panel context (`sessionId` / `session`).
 */
interface SessionDetail {
  id: string;
  meta: SessionMeta | null;
}

interface ProjectOption {
  id: string;
  name: string;
  apiKey: string;
  scene?: SceneMeta;
}

export default function Page() {
  const [baseUrl, setBaseUrl] = useState(DEFAULT_COLLECTOR_URL);
  const [apiKey, setApiKey] = useState(DEFAULT_API_KEY);
  const [projects, setProjects] = useState<ProjectOption[]>([]);
  const [selectedId, setSelectedId] = useState("");
  const [filters, setFilters] = useState<FilterState>(DEFAULT_FILTERS);
  const [scenes, setScenes] = useState<SceneInfo[]>([]);
  // Whether the active range has first-person camera-position samples — the
  // panel capability that lets walk-only panels default sensibly (ADR 0026).
  const [hasFirstPerson, setHasFirstPerson] = useState(false);
  const [status, setStatus] = useState<"idle" | "loading" | "ready" | "error">("idle");
  const [error, setError] = useState<string | null>(null);
  const [detail, setDetail] = useState<SessionDetail | null>(null);
  const [detailStatus, setDetailStatus] = useState<"idle" | "loading" | "ready" | "error">("idle");
  // Event types hidden from the open session's replay overlay + data inspector.
  const [hiddenTypes, setHiddenTypes] = useState<ReadonlySet<string>>(new Set());

  // Live layer (ADR 0032): a rolling event feed and a 1s clock that keeps the
  // presence/feed relative times fresh without reopening the SSE connections.
  const [liveFeed, setLiveFeed] = useState<LiveEvent[]>([]);
  const [liveNow, setLiveNow] = useState(() => Date.now());
  // Bumped on a throttled live refetch so registry panels (ADR 0036) refresh and
  // relative time windows advance without a filter change.
  const [liveRevision, setLiveRevision] = useState(0);
  // Bumped by the per-second live-session poll so the OPEN session's registry
  // panels (ADR 0036, `surface: "session"`) refetch while the session is live.
  // `liveRevision` is intentionally frozen while a drill-down is open (so the
  // aggregate view isn't reset under the user), which otherwise left the session
  // panels stale until you navigated away and back.
  const [sessionRevision, setSessionRevision] = useState(0);
  // Live scene auto-follow (ADR 0040): the section the live avatar is currently
  // in, tracked from the firehose so the 3D backdrop swaps to it. Kept in a ref
  // too for the event handler's change check without re-subscribing.
  const [liveSceneId, setLiveSceneId] = useState<string | undefined>(undefined);
  const liveSceneIdRef = useRef<string | undefined>(undefined);
  // Registry panels that opted into the live firehose (ADR 0036 PanelLive).
  const liveSubscribersRef = useRef<Set<(event: LiveEvent) => void>>(new Set());

  // Keep the latest filters in a ref so `load`/`openSession` stay stable and can
  // be invoked from the debounced auto-refetch effect without being re-created.
  const filtersRef = useRef(filters);
  filtersRef.current = filters;
  // The time preset to restore when a volume-chart zoom (custom window) is reset.
  const prevWindowRef = useRef<TimeWindow>(DEFAULT_FILTERS.window);
  // URL ⇄ state plumbing. The dashboard is one client page; we mirror the
  // selected project/session into the path (`/projects/:id`,
  // `/projects/:id/session/:sid`) so links are shareable and the back button
  // works. `next.config.mjs` rewrites those paths back to `/`.
  const selectedIdRef = useRef(selectedId);
  selectedIdRef.current = selectedId;
  const detailRef = useRef(detail);
  detailRef.current = detail;
  // Project id parsed from the initial URL, applied once the registry loads.
  const targetProjectRef = useRef<string | null>(null);
  // Session id from a deep link, opened once its project view is loaded.
  const pendingSessionRef = useRef<string | null>(null);
  // Set when a deep-linked project should auto-load after its key is selected.
  const wantLoadRef = useRef(false);

  const projectPath = useCallback((projectId: string, sessionId?: string) => {
    const base = `/projects/${encodeURIComponent(projectId)}`;
    return sessionId ? `${base}/session/${encodeURIComponent(sessionId)}` : base;
  }, []);

  const pushPath = useCallback((path: string) => {
    if (typeof window === "undefined") return;
    if (window.location.pathname !== path) window.history.pushState({}, "", path);
  }, []);

  // Parse the initial deep link before the project registry resolves.
  useEffect(() => {
    const m = window.location.pathname.match(/^\/projects\/([^/]+)(?:\/session\/([^/]+))?/);
    if (!m?.[1]) return;
    targetProjectRef.current = decodeURIComponent(m[1]);
    if (m[2]) pendingSessionRef.current = decodeURIComponent(m[2]);
  }, []);

  // When no collector URL was baked at build time (e.g. a static dashboard
  // served by the collector itself), default to the origin the page was served
  // from. Runs once after hydration so SSR and first client render still agree.
  useEffect(() => {
    if (COLLECTOR_URL_IS_PINNED) return;
    setBaseUrl(window.location.origin);
  }, []);

  // Populate the project picker from the local registry written by
  // `pnpm playground:new`. Empty (or absent) means the picker stays hidden and
  // the API key field is used directly.
  useEffect(() => {
    let cancelled = false;
    void fetch("/api/projects")
      .then((res) => (res.ok ? res.json() : []))
      .then((list: unknown) => {
        if (cancelled || !Array.isArray(list) || list.length === 0) return;
        const options = list as ProjectOption[];
        setProjects(options);
        const [firstOption] = options;
        const target = targetProjectRef.current;
        const match =
          (target ? options.find((p) => p.id === target) : undefined) ??
          options.find((p) => p.apiKey === DEFAULT_API_KEY) ??
          firstOption;
        if (!match) return;
        setSelectedId(match.id);
        setApiKey(match.apiKey);
        // A valid deep link to this project should load it without a manual click.
        // A lone plain project (no scene card to choose from — e.g. the live demo
        // or a single self-hosted project) also loads straight into its analytics
        // instead of stranding the visitor on an empty scene-selector.
        if ((target && match.id === target) || (options.length === 1 && !match.scene)) {
          wantLoadRef.current = true;
        }
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  const load = useCallback(
    async (overrideKey?: string) => {
      const key = overrideKey ?? apiKey;
      if (!key) {
        setStatus("error");
        setError("An API key is required.");
        return;
      }
      setStatus("loading");
      setError(null);
      setDetail(null);
      setDetailStatus("idle");
      const active = filtersRef.current;
      const params = toQueryParams(active);
      const range = resolveRange(active);
      const api = new CollectorApi(baseUrl, key);
      try {
        // The analytics panels self-fetch through the catalog (ADR 0036); the
        // shell only needs the scene list for the filter bar and a data-driven
        // first-person signal for the panel capability. The floor-plan ("where
        // visitors stand") having any bins means walkable samples exist. It is
        // always scoped to first-person, independent of the global camera-mode
        // toggle, because an arc-rotate camera's position orbits the model
        // (ADR 0026).
        const [sceneList, floorPlan] = await Promise.all([
          api.scenes({ since: range.since, until: range.until, limit: 200 }),
          api.cameraPositionHeatmap({
            ...params,
            source: undefined,
            cameraMode: "first-person",
            cellSize: FLOOR_CELL_SIZE,
          }),
        ]);
        setScenes(sceneList);
        setHasFirstPerson(floorPlan.length > 0);
        setStatus("ready");
      } catch (err) {
        setHasFirstPerson(false);
        setStatus("error");
        setError(
          err instanceof ApiError
            ? `${err.status}: ${err.message}`
            : err instanceof Error
              ? err.message
              : "Request failed.",
        );
      }
    },
    [apiKey, baseUrl],
  );

  // Open a scene/project's analytics from the landing scene-selector: select it,
  // mirror it into the URL, and load using its key directly (state updates are
  // async, so pass the key through rather than relying on the next render).
  const viewProject = useCallback(
    (project: ProjectOption) => {
      setSelectedId(project.id);
      setApiKey(project.apiKey);
      // Reset the live-followed section so the new project's backdrop doesn't
      // inherit the previous project's last section (ADR 0040).
      setLiveSceneId(undefined);
      liveSceneIdRef.current = undefined;
      pushPath(projectPath(project.id));
      void load(project.apiKey);
    },
    [load, projectPath, pushPath],
  );

  // Debounced auto-refetch when filters change (only once connected).
  useEffect(() => {
    if (status === "idle") return;
    const t = setTimeout(() => void load(), 300);
    return () => clearTimeout(t);
    // `load` reads filters via ref, so re-running only on `filters` is sufficient.
  }, [filters]);

  // Live layer (ADR 0032). Open the SSE connections once a project is selected.
  // The aggregate dashboard reflects live activity in two ways: the presence/feed
  // panel updates in place from the firehose, and arriving events throttle a
  // background refetch so the heatmaps/charts catch up without a manual reload.
  const liveEnabled = status !== "idle" && Boolean(apiKey);
  const lastRefetchRef = useRef(0);
  const detailOpenRef = useRef(false);
  detailOpenRef.current = detail != null;

  const onLiveEvent = useCallback(
    (event: LiveEvent) => {
      setLiveFeed((prev) => [event, ...prev].slice(0, LIVE_FEED_MAX));
      // Fan the event out to any registry panels that subscribed (ADR 0036).
      liveSubscribersRef.current.forEach((handler) => handler(event));
      // Live area tracking (ADR 0040): note the section the live avatar is in.
      // The backdrop shows the whole building, so we no longer swap geometry per
      // section; but on a real section change (rare, at boundary crossings) bump
      // the revision so the backdrop effect re-merges and picks up an area that
      // just became active. Skip while a session drill-down is open — that view
      // owns its own scope and renders the whole building already.
      if (!detailOpenRef.current && event.sceneId && event.sceneId !== liveSceneIdRef.current) {
        liveSceneIdRef.current = event.sceneId;
        setLiveSceneId(event.sceneId);
        setLiveRevision((r) => r + 1);
      }
      // Throttle the aggregate refetch and skip it while a session drill-down is
      // open (that view has its own scope and shouldn't be reset under the user).
      const nowTs = Date.now();
      if (detailOpenRef.current) return;
      if (nowTs - lastRefetchRef.current < LIVE_REFETCH_THROTTLE_MS) return;
      lastRefetchRef.current = nowTs;
      void load();
      setLiveRevision((r) => r + 1);
    },
    [load],
  );

  const { snapshot: livePresence, status: liveStatus } = useLivePresence(
    baseUrl,
    apiKey,
    liveEnabled,
  );
  useLiveStream(baseUrl, apiKey, liveEnabled, onLiveEvent);

  // 1s clock so the presence roster / feed relative times stay fresh.
  useEffect(() => {
    if (!liveEnabled) return;
    const t = setInterval(() => setLiveNow(Date.now()), 1_000);
    return () => clearInterval(t);
  }, [liveEnabled]);

  // Keep the Scene dropdown fresh while live. The heavy aggregate refetch is
  // throttled and skipped while a session drill-down is open (so the open view
  // isn't reset under the user), but the lightweight scene list should still pick
  // up areas the live visitor enters — otherwise the dropdown shows a stale
  // subset until the next full reload (ADR 0040).
  useEffect(() => {
    if (!liveEnabled) return;
    const api = new CollectorApi(baseUrl, apiKey);
    let cancelled = false;
    const tick = async () => {
      const range = resolveRange(filtersRef.current);
      const list = await api
        .scenes({ since: range.since, until: range.until, limit: 200 })
        .catch(() => null);
      if (!cancelled && list) setScenes(list);
    };
    const t = setInterval(() => void tick(), 5_000);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, [liveEnabled, baseUrl, apiKey]);

  // Fetch one session's metadata (scene, camera type, device). The session's
  // analytics panels self-fetch off the session context; the shell only needs
  // the metadata for the header and to hand to panels via `ctx.session`.
  const fetchSessionMeta = useCallback(
    async (id: string): Promise<SessionDetail> => {
      const api = new CollectorApi(baseUrl, apiKey);
      const meta = await api.sessionMeta(id).catch(() => null);
      return { id, meta };
    },
    [baseUrl, apiKey],
  );

  const openSession = useCallback(
    async (id: string) => {
      const pid = selectedIdRef.current;
      if (pid) pushPath(projectPath(pid, id));
      if (typeof window !== "undefined") window.scrollTo({ top: 0, behavior: "smooth" });
      setDetail({ id, meta: null });
      setDetailStatus("loading");
      setHiddenTypes(new Set());
      try {
        setDetail(await fetchSessionMeta(id));
        setDetailStatus("ready");
      } catch (err) {
        setDetailStatus("error");
        setError(
          err instanceof ApiError
            ? `${err.status}: ${err.message}`
            : err instanceof Error
              ? err.message
              : "Request failed.",
        );
      }
    },
    [fetchSessionMeta, projectPath, pushPath],
  );

  const closeSession = useCallback(() => {
    const pid = selectedIdRef.current;
    if (pid) pushPath(projectPath(pid));
    setDetail(null);
    setDetailStatus("idle");
    setHiddenTypes(new Set());
  }, [projectPath, pushPath]);

  // Switching projects in the selector picks a new API key but does NOT auto-load.
  // Clear the previously rendered panels (and any open session) so the stale data
  // doesn't masquerade as the new project — the empty state prompts a fresh Load.
  const selectProject = useCallback(
    (id: string) => {
      const next = projects.find((p) => p.id === id);
      setSelectedId(id);
      if (next) setApiKey(next.apiKey);
      setHasFirstPerson(false);
      setScenes([]);
      setStatus("idle");
      setError(null);
      setDetail(null);
      setDetailStatus("idle");
      setHiddenTypes(new Set());
    },
    [projects],
  );

  const toggleHiddenType = useCallback((type: string) => {
    setHiddenTypes((prev) => {
      const next = new Set(prev);
      if (next.has(type)) next.delete(type);
      else next.add(type);
      return next;
    });
  }, []);

  const setAllHidden = useCallback((hidden: boolean, types: string[]) => {
    setHiddenTypes(hidden ? new Set(types) : new Set());
  }, []);

  const brushRange = useCallback((since: number, until: number) => {
    setFilters((f) => {
      // Remember the preset that was active before zooming so resetting the
      // brush restores it rather than snapping back to the default window.
      if (f.window !== "custom") prevWindowRef.current = f.window;
      return { ...f, window: "custom", since, until };
    });
  }, []);

  const clearBrush = useCallback(() => {
    setFilters((f) => ({ ...f, window: prevWindowRef.current }));
  }, []);

  // Auto-load a deep-linked project once its API key has been selected. Keyed on
  // `projects` too: a deep link to the default project leaves `apiKey` unchanged
  // (it already equals the default key), so the registry load is the trigger.
  useEffect(() => {
    if (wantLoadRef.current && apiKey) {
      wantLoadRef.current = false;
      void load();
    }
  }, [projects, apiKey, load]);

  // Once the deep-linked project view is ready, open the requested session.
  useEffect(() => {
    if (status === "ready" && pendingSessionRef.current) {
      const sid = pendingSessionRef.current;
      pendingSessionRef.current = null;
      void openSession(sid);
    }
  }, [status, openSession]);

  // Reconcile state with the URL on browser back/forward navigation.
  useEffect(() => {
    const onPop = () => {
      const m = window.location.pathname.match(/^\/projects\/[^/]+(?:\/session\/([^/]+))?/);
      const sid = m?.[1] ? decodeURIComponent(m[1]) : null;
      if (sid) {
        if (detailRef.current?.id !== sid) void openSession(sid);
      } else if (detailRef.current) {
        closeSession();
      }
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, [openSession, closeSession]);

  const busy = status === "loading";

  // Registry-driven panels (ADR 0036): one CollectorApi + the resolved filter
  // params + the shared host context the overview and session PanelHosts pass to
  // each panel. `panelParams` recomputes on a live refetch so relative windows
  // advance; it is otherwise stable across renders so panels don't refetch on
  // every render.
  const panelApi = useMemo(() => new CollectorApi(baseUrl, apiKey), [baseUrl, apiKey]);
  const panelParams = useMemo(() => toQueryParams(filters), [filters, liveRevision]);
  const subscribeLive = useCallback((handler: (event: LiveEvent) => void) => {
    const set = liveSubscribersRef.current;
    set.add(handler);
    return () => {
      set.delete(handler);
    };
  }, []);
  const panelActions = useMemo(
    () => ({
      selectSession: (id: string) => void openSession(id),
      setTimeRange: (since: number, until: number) => brushRange(since, until),
      clearTimeRange: () => clearBrush(),
      setFilters: (patch: Partial<FilterState>) => setFilters((f) => ({ ...f, ...patch })),
    }),
    [openSession, brushRange, clearBrush],
  );
  const panelBase = {
    api: panelApi,
    baseUrl,
    apiKey,
    params: panelParams,
    filters,
    capabilities: { hasFirstPerson },
    actions: panelActions,
    live: {
      presence: livePresence,
      enabled: liveEnabled,
      subscribe: subscribeLive,
      sceneId: liveEnabled ? liveSceneId : undefined,
      status: liveStatus,
    },
    // Per-panel settings (ADR 0039) are injected per panel by the PanelHost; the
    // base context carries none. Panels without settings see an empty object.
    settings: {},
  };
  const overviewCtx: PanelContext = { ...panelBase, surface: "overview" };
  const sessionCtx: PanelContext | null = detail
    ? { ...panelBase, surface: "session", sessionId: detail.id, session: detail.meta }
    : null;

  // Runtime / remote panels (ADR 0041): discover and load panels from a
  // configured manifest at runtime, then merge them with the build-time
  // `builtinPanels`. Off unless `NEXT_PUBLIC_PANELS_MANIFEST_URL` is set, so the
  // default dashboard is unchanged. Load/merge failures are collected and shown
  // in a banner without breaking the grid.
  const remotePanels = useRemotePanels();
  const merged = useMemo(
    () => mergePanels(builtinPanels, remotePanels.panels),
    [remotePanels.panels],
  );
  const allPanels: PanelDefinition<unknown>[] = merged.panels;
  const panelLoadErrors: RemotePanelError[] = useMemo(
    () => [...remotePanels.errors, ...merged.errors],
    [remotePanels.errors, merged.errors],
  );

  // Surface the live-follow replay only when the open session is currently live
  // (present in the presence roster), so historical sessions aren't cluttered
  // with an idle "waiting for events" viewer.
  const detailIsLive = Boolean(
    detail && livePresence?.sessions.some((s) => s.sessionId === detail.id),
  );

  // The session-surface panels fetch once when a session opens. While the
  // session is live they keep streaming events the dashboard never re-queries,
  // so those panels go stale. When the open session stops being live, bump the
  // session revision once so every panel refetches and reflects the final data.
  const wasLiveRef = useRef(detailIsLive);
  useEffect(() => {
    const wasLive = wasLiveRef.current;
    wasLiveRef.current = detailIsLive;
    if (!wasLive || detailIsLive) return; // only on the live → ended transition
    if (!detailRef.current || detailStatus !== "ready") return;
    setSessionRevision((r) => r + 1);
  }, [detailIsLive, detailStatus]);

  // While the open session is live, its panels would otherwise stay frozen at
  // the values fetched when it opened. Bump the session revision once a second
  // so they refetch and visibly update as events stream in. The live replay
  // tails over its own SSE channel and is unaffected (its props — sessionId /
  // isLive — don't change here).
  useEffect(() => {
    if (!detailIsLive || detailStatus !== "ready") return;
    const timer = setInterval(() => setSessionRevision((r) => r + 1), 1_000);
    return () => clearInterval(timer);
  }, [detailIsLive, detailStatus]);

  return (
    <main className="mx-auto max-w-6xl px-6 py-8">
      <header className="mb-6 flex items-center gap-3">
        <img
          src={`${process.env.NEXT_PUBLIC_BASE_PATH ?? ""}/logo.svg`}
          alt="Uptimizr"
          width={36}
          height={36}
          className="h-9 w-9 shrink-0"
        />
        <div>
          <h1 className="font-display text-2xl font-bold text-fg-hi">Uptimizr</h1>
          <p className="text-sm text-fg-muted">Analytics for 3D scenes — open-source collector.</p>
        </div>
      </header>

      <form
        className="mb-6 flex flex-wrap items-end gap-3 rounded-xl border border-edge bg-panel p-4"
        onSubmit={(e) => {
          e.preventDefault();
          if (selectedId) pushPath(projectPath(selectedId));
          void load();
        }}
      >
        {projects.length > 0 ? (
          <label className="flex flex-col gap-1 text-xs text-fg-muted">
            Project
            <select
              className="min-w-56 rounded-md border border-edge bg-ink px-3 py-2 text-sm text-fg outline-none focus:border-saffron"
              value={selectedId}
              onChange={(e) => selectProject(e.target.value)}
            >
              {projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </label>
        ) : null}
        <label className="flex flex-1 flex-col gap-1 text-xs text-fg-muted">
          Collector URL
          <input
            className="min-w-56 rounded-md border border-edge bg-ink px-3 py-2 text-sm text-fg outline-none focus:border-saffron"
            value={baseUrl}
            onChange={(e) => setBaseUrl(e.target.value)}
            placeholder="http://localhost:4318"
          />
        </label>
        <label className="flex flex-1 flex-col gap-1 text-xs text-fg-muted">
          Project API key
          <input
            className="min-w-56 rounded-md border border-edge bg-ink px-3 py-2 text-sm text-fg outline-none focus:border-saffron"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            type="password"
            placeholder="utk_…"
          />
        </label>
        <button
          type="submit"
          disabled={status === "loading"}
          className="rounded-md bg-amber px-4 py-2 text-sm font-medium text-ink transition hover:bg-ember disabled:opacity-50"
        >
          {status === "loading" ? "Loading…" : "Load"}
        </button>
      </form>

      {status !== "idle" ? (
        <GlobalFilters filters={filters} scenes={scenes} onChange={setFilters} busy={busy} />
      ) : null}

      {error ? (
        <div className="mb-6 rounded-lg border border-red-900/60 bg-red-950/40 px-4 py-3 text-sm text-red-300">
          {error}
        </div>
      ) : null}

      {status === "idle" ? (
        projects.length > 0 ? (
          <SceneSelector
            projects={projects}
            playgroundUrl={DEFAULT_PLAYGROUND_URL}
            onView={viewProject}
          />
        ) : (
          <p className="text-sm text-fg-muted">
            Enter your collector URL and a project API key, then load to view analytics.
          </p>
        )
      ) : detail ? (
        <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
          {panelLoadErrors.length > 0 ? (
            <div className="lg:col-span-2">
              <RemotePanelErrors errors={panelLoadErrors} />
            </div>
          ) : null}
          <div className="lg:col-span-2 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-edge bg-panel p-4">
            <div>
              <p className="text-xs uppercase tracking-wide text-fg-muted">Session</p>
              <p className="font-mono text-sm text-fg">{detail.id}</p>
              <p className="mt-1 text-xs text-fg-muted">
                {detailStatus === "loading"
                  ? "Loading session…"
                  : [
                      detail.meta?.scene?.sceneId ? `scene: ${detail.meta.scene.sceneId}` : null,
                      detail.meta?.device?.gpu ? `gpu: ${detail.meta.device.gpu}` : null,
                      detail.meta?.startedAt ? `started: ${detail.meta.startedAt}` : null,
                    ]
                      .filter(Boolean)
                      .join("  ·  ") || "No session metadata."}
              </p>
            </div>
            <button
              type="button"
              onClick={closeSession}
              className="rounded-md border border-edge px-3 py-2 text-sm text-fg transition hover:border-amber hover:text-fg-hi"
            >
              ← All sessions
            </button>
          </div>
          <div className="lg:col-span-2">
            <Panel
              title={detailIsLive ? "Session replay · live" : "Session replay (birdview timeline)"}
              subtitle={
                detailIsLive
                  ? "Following this session live — new camera moves and interactions stream in and the timeline grows. Scrub back to review, then press ● LIVE to return to the edge."
                  : "Scrub the camera path and interaction rays; every click stays marked and glows as the playhead passes it. The color-coded strip marks when each event fired (click to seek)."
              }
            >
              <SessionReplayView
                api={panelApi}
                sessionId={detail.id}
                hiddenTypes={hiddenTypes}
                isLive={detailIsLive}
              />
            </Panel>
          </div>
          <div className="lg:col-span-2">
            <SessionInspector
              baseUrl={baseUrl}
              apiKey={apiKey}
              sessionId={detail.id}
              hiddenTypes={hiddenTypes}
              onToggleType={toggleHiddenType}
              onSetAllHidden={setAllHidden}
            />
          </div>
          {sessionCtx ? (
            <PanelHost
              panels={allPanels}
              ctx={sessionCtx}
              surface="session"
              revision={liveRevision + sessionRevision}
              exclude={["session-replay"]}
            />
          ) : null}
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
          {panelLoadErrors.length > 0 ? (
            <div className="lg:col-span-2">
              <RemotePanelErrors errors={panelLoadErrors} />
            </div>
          ) : null}
          <div className="lg:col-span-2">
            <AssistantDrawer collectorUrl={baseUrl} apiKey={apiKey} />
          </div>
          <div className="lg:col-span-2">
            <Panel
              title={LIVE_PRESENCE_TITLE}
              subtitle={LIVE_PRESENCE_SUBTITLE}
              help={LIVE_PRESENCE_HELP}
            >
              <LivePresenceView
                snapshot={livePresence}
                status={liveStatus}
                feed={liveFeed}
                now={liveNow}
                onSelectSession={openSession}
              />
            </Panel>
          </div>
          <PanelHost
            panels={allPanels}
            ctx={overviewCtx}
            surface="overview"
            revision={liveRevision}
            exclude={["live-presence"]}
          />
        </div>
      )}
    </main>
  );
}
