"use client";

import dynamic from "next/dynamic";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  ApiError,
  CollectorApi,
  COLLECTOR_URL_IS_PINNED,
  DEFAULT_API_KEY,
  DEFAULT_COLLECTOR_URL,
  DEFAULT_PLAYGROUND_URL,
  type CameraDistanceBucket,
  type ClickRay,
  type CoverageVoxel,
  type DirectionBin,
  type EventTypeCount,
  type FlowLink,
  type HeatmapBin,
  type InteractionSource,
  type MeshCount,
  type NavigationStat,
  type PerfSummary,
  type PositionBin,
  type QueryParams,
  type SceneInfo,
  type SceneProxyMesh,
  type SessionMeta,
  type SessionSummary,
  type TimeseriesBucket,
  type WorldHeatmapBin,
} from "@/lib/api";
import {
  DEFAULT_FILTERS,
  pickInterval,
  resolveRange,
  toQueryParams,
  type FilterState,
  type TimeWindow,
} from "@/lib/filters";
import { parseTimestamp } from "@/lib/format";
import { useLivePresence, useLiveStream, type LiveEvent } from "@/lib/live";
import { CameraDirectionHeatmap } from "@/components/CameraDirectionHeatmap";
import { FloorPlanHeatmap } from "@/components/FloorPlanHeatmap";
import { GlobalFilters } from "@/components/GlobalFilters";
import { InputSourceBreakdown } from "@/components/InputSourceBreakdown";
import { PerfSummaryPanel } from "@/components/PerfSummaryPanel";
import { PerformanceSection, type PerformanceData } from "@/components/PerformanceSection";
import { PointerHeatmap } from "@/components/PointerHeatmap";
import { SceneHealth } from "@/components/SceneHealth";
import { SceneMetrics } from "@/components/SceneMetrics";
import { SceneSelector, type SceneMeta } from "@/components/SceneSelector";
import { SessionsTable } from "@/components/SessionsTable";
import { TopMeshes } from "@/components/TopMeshes";
import { TrajectoryView } from "@/components/TrajectoryView";
import { VolumeTimeseries } from "@/components/VolumeTimeseries";
import { SessionInspector } from "@/components/SessionInspector";
import { LivePresence } from "@/components/LivePresence";

// Babylon-backed panels load only in the browser (no SSR, lazy chunk).
const SessionReplay = dynamic(
  () => import("@/components/SessionReplay").then((m) => m.SessionReplay),
  { ssr: false },
);
const WorldHeatmap3D = dynamic(
  () => import("@/components/WorldHeatmap3D").then((m) => m.WorldHeatmap3D),
  { ssr: false },
);
const CameraDome3D = dynamic(
  () => import("@/components/CameraDome3D").then((m) => m.CameraDome3D),
  {
    ssr: false,
  },
);
const ClickRays3D = dynamic(() => import("@/components/ClickRays3D").then((m) => m.ClickRays3D), {
  ssr: false,
});
const FlowSankey3D = dynamic(
  () => import("@/components/FlowSankey3D").then((m) => m.FlowSankey3D),
  {
    ssr: false,
  },
);

const POINTER_BINS = 50;
const CAMERA_BINS = 36;
const WORLD_CELL_SIZE = 0.5;
const COVERAGE_CELL_SIZE = 1;
const DISTANCE_BUCKET_SIZE = 1;
const FLOOR_CELL_SIZE = 1;
/** Maximum rows kept in the in-memory live event feed (ADR 0032 §3). */
const LIVE_FEED_MAX = 30;
/** Minimum gap between live-triggered aggregate refetches (ms). */
const LIVE_REFETCH_THROTTLE_MS = 5_000;
interface Dashboard {
  sessions: SessionSummary[];
  pointer: HeatmapBin[];
  camera: DirectionBin[];
  meshes: MeshCount[];
  perf: PerfSummary | null;
  world: WorldHeatmapBin[];
  gaze: WorldHeatmapBin[];
  clickRays: ClickRay[];
  flowLinks: FlowLink[];
  /** Resolved base query the Flow panel re-issues per camera mode (§7.8 slice 4). */
  flowQuery: QueryParams;
  /** Whether the active range has first-person camera-position samples. */
  hasFirstPerson: boolean;
  proxyMeshes: SceneProxyMesh[];
  timeseries: TimeseriesBucket[];
  counts: EventTypeCount[];
  coverage: CoverageVoxel[];
  distance: CameraDistanceBucket[];
  navigation: NavigationStat[];
  sources: InteractionSource[];
  floorPlan: PositionBin[];
  performance: PerformanceData;
  intervalMs: number;
}

const EMPTY_PERFORMANCE: PerformanceData = {
  distribution: null,
  histogram: [],
  frameTime: null,
  jank: null,
  byDevice: [],
  byScene: [],
  resources: null,
  stability: null,
};

const EMPTY: Dashboard = {
  sessions: [],
  pointer: [],
  camera: [],
  meshes: [],
  perf: null,
  world: [],
  gaze: [],
  clickRays: [],
  flowLinks: [],
  flowQuery: {},
  hasFirstPerson: false,
  proxyMeshes: [],
  timeseries: [],
  counts: [],
  coverage: [],
  distance: [],
  navigation: [],
  sources: [],
  floorPlan: [],
  performance: EMPTY_PERFORMANCE,
  intervalMs: 3_600_000,
};

/** Per-session drill-down: the same analytics scoped to one session id. */
interface SessionDetail {
  id: string;
  meta: SessionMeta | null;
  pointer: HeatmapBin[];
  camera: DirectionBin[];
  meshes: MeshCount[];
  perf: PerfSummary | null;
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
  const [data, setData] = useState<Dashboard>(EMPTY);
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
        // Sessions first so an "all time" window can bound the time-series span.
        const sessions = await api.sessions({ ...params, source: undefined, limit: 100 });
        const until = range.until ?? Date.now();
        let since = range.since;
        if (since == null) {
          const earliest = sessions.reduce((min, s) => {
            const t = parseTimestamp(s.started_at);
            return Number.isFinite(t) ? Math.min(min, t) : min;
          }, Date.now());
          since = Number.isFinite(earliest) ? earliest : until - 86_400_000;
        }
        const intervalSec = pickInterval(Math.max(60_000, until - since));
        const intervalMs = intervalSec * 1000;

        const [
          pointer,
          camera,
          meshes,
          perf,
          world,
          gaze,
          clickRays,
          flowLinks,
          sceneList,
          timeseries,
          counts,
          coverage,
          distance,
          navigation,
          sources,
          floorPlan,
          performance,
        ] = await Promise.all([
          api.pointerHeatmap({ ...params, bins: POINTER_BINS }),
          api.cameraHeatmap({ ...params, source: undefined, bins: CAMERA_BINS }),
          api.topMeshes({ ...params, source: undefined, scene: undefined, limit: 25 }),
          api.perf({ ...params, source: undefined }),
          api.worldHeatmap({ ...params, cellSize: WORLD_CELL_SIZE }),
          api.gazeHeatmap({ ...params, source: undefined, cellSize: WORLD_CELL_SIZE }),
          api.clickRays({ ...params, cellSize: WORLD_CELL_SIZE }),
          // Position-aware flow (§7.8): group links by standpoint (camera-position)
          // voxel so the panel can gate/break-down by where the viewer stood. A
          // higher limit keeps enough (origin × direction × mesh) rows to populate
          // the standpoint selector; the panel still caps what it draws.
          api.flowHeatmap({ ...params, bins: CAMERA_BINS, limit: 400, groupByOrigin: true }),
          api.scenes({ since: range.since, until: range.until, limit: 200 }),
          api.timeseries({
            since: range.since,
            until: range.until,
            scene: params.scene,
            interval: intervalSec,
          }),
          api.eventCounts({ since: range.since, until: range.until, scene: params.scene }),
          api.coverage({ ...params, source: undefined, cellSize: COVERAGE_CELL_SIZE }),
          api.cameraDistance({ ...params, source: undefined, bucketSize: DISTANCE_BUCKET_SIZE }),
          api.navigation({ ...params, source: undefined }),
          api.interactionsBySource(params),
          // The floor-plan ("where visitors stand") is only meaningful for free /
          // first-person cameras: an arc-rotate camera's position orbits the model,
          // so blending it in would pollute the map. Always scope to first-person,
          // independent of the global camera-mode toggle (ADR 0026).
          api.cameraPositionHeatmap({
            ...params,
            source: undefined,
            cameraMode: "first-person",
            cellSize: FLOOR_CELL_SIZE,
          }),
          // Dedicated performance section (ADR 0028): per-session, device-aware
          // aggregates fetched as one wave and grouped into a single object.
          (async (): Promise<PerformanceData> => {
            const [
              distribution,
              histogram,
              frameTime,
              jank,
              byDevice,
              byScene,
              resources,
              stability,
            ] = await Promise.all([
              api.perfDistribution({ ...params, source: undefined }),
              api.fpsHistogram({ ...params, source: undefined }),
              api.frameTimePercentiles({ ...params, source: undefined }),
              api.jankRate({ ...params, source: undefined }),
              api.perfByDevice({ ...params, source: undefined }),
              // Always compare every scene, independent of the scene filter.
              api.perfByScene({ ...params, source: undefined, scene: undefined }),
              api.resourcePercentiles({ ...params, source: undefined }),
              api.stabilityCounts({ ...params, source: undefined }),
            ]);
            return {
              distribution,
              histogram,
              frameTime,
              jank,
              byDevice,
              byScene,
              resources,
              stability,
            };
          })(),
        ]);
        setScenes(sceneList);
        // The proxy backdrop needs a single scene to anchor the mesh geometry.
        // Use the active scene filter; otherwise, when the project has exactly
        // one scene, fall back to it so the 3D viewers (click rays, world
        // heatmap) render their mesh backdrop instead of leaving rays floating
        // in empty space when "All scenes" is selected.
        const backdropScene =
          params.scene ?? (sceneList.length === 1 ? sceneList[0]?.scene_id : undefined);
        const proxyMeshes = backdropScene
          ? ((await api.sceneRepresentation(backdropScene).catch(() => null))?.proxy?.meshes ?? [])
          : [];
        setData({
          sessions,
          pointer,
          camera,
          meshes,
          perf,
          world,
          gaze,
          clickRays,
          flowLinks,
          // The Flow panel owns the camera-mode dimension (§7.8 slice 4): give it
          // the resolved base query (no camera mode) to re-issue per walk/orbit/all,
          // and a data-driven first-person signal so it can default to walk. The
          // first-person floor-plan having any bins means walkable samples exist.
          flowQuery: {
            since: range.since,
            until: range.until,
            scene: params.scene,
            source: params.source,
          },
          hasFirstPerson: floorPlan.length > 0,
          proxyMeshes,
          timeseries,
          counts,
          coverage,
          distance,
          navigation,
          sources,
          floorPlan,
          performance,
          intervalMs,
        });
        setStatus("ready");
      } catch (err) {
        setData(EMPTY);
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
      // Throttle the aggregate refetch and skip it while a session drill-down is
      // open (that view has its own scope and shouldn't be reset under the user).
      const nowTs = Date.now();
      if (detailOpenRef.current) return;
      if (nowTs - lastRefetchRef.current < LIVE_REFETCH_THROTTLE_MS) return;
      lastRefetchRef.current = nowTs;
      void load();
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

  // Fetch the aggregate panels (heatmaps, top meshes, perf, meta) for one
  // session. Shared by the initial open and the live → ended refresh below.
  const fetchSessionPanels = useCallback(
    async (id: string): Promise<SessionDetail> => {
      const params = toQueryParams(filtersRef.current);
      const api = new CollectorApi(baseUrl, apiKey);
      const [pointer, camera, meshes, perf, meta] = await Promise.all([
        api.pointerHeatmap({ ...params, bins: POINTER_BINS, session: id }),
        api.cameraHeatmap({ ...params, source: undefined, bins: CAMERA_BINS, session: id }),
        api.topMeshes({ ...params, source: undefined, scene: undefined, limit: 25, session: id }),
        api.perf({ ...params, source: undefined, session: id }),
        api.sessionMeta(id).catch(() => null),
      ]);
      return { id, meta, pointer, camera, meshes, perf };
    },
    [baseUrl, apiKey],
  );

  const openSession = useCallback(
    async (id: string) => {
      const pid = selectedIdRef.current;
      if (pid) pushPath(projectPath(pid, id));
      if (typeof window !== "undefined") window.scrollTo({ top: 0, behavior: "smooth" });
      setDetail({ id, meta: null, pointer: [], camera: [], meshes: [], perf: null });
      setDetailStatus("loading");
      setHiddenTypes(new Set());
      try {
        setDetail(await fetchSessionPanels(id));
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
    [fetchSessionPanels, projectPath, pushPath],
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
      setData(EMPTY);
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

  // Surface the live-follow replay only when the open session is currently live
  // (present in the presence roster), so historical sessions aren't cluttered
  // with an idle "waiting for events" viewer.
  const detailIsLive = Boolean(
    detail && livePresence?.sessions.some((s) => s.sessionId === detail.id),
  );

  // The aggregate panels (heatmaps, top meshes, perf) are fetched once when a
  // session opens. While the session is live they keep streaming events the
  // dashboard never re-queries, so those panels go stale. When the open session
  // stops being live, re-fetch them once so every panel reflects the final data.
  const wasLiveRef = useRef(detailIsLive);
  useEffect(() => {
    const wasLive = wasLiveRef.current;
    wasLiveRef.current = detailIsLive;
    if (!wasLive || detailIsLive) return; // only on the live → ended transition
    const open = detailRef.current;
    if (!open || detailStatus !== "ready") return;
    const id = open.id;
    let cancelled = false;
    void (async () => {
      try {
        const next = await fetchSessionPanels(id);
        if (!cancelled && detailRef.current?.id === id) setDetail(next);
      } catch {
        // Keep the existing panels if the refresh fails; they're only stale.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [detailIsLive, detailStatus, fetchSessionPanels]);

  // While the open session is live, its aggregate panels (heatmaps, top meshes,
  // perf) would otherwise stay frozen at the values fetched when it opened. Poll
  // them once a second so the panels visibly update as events stream in. The
  // live replay tails over its own SSE channel and is unaffected (its props —
  // sessionId / isLive — don't change here).
  useEffect(() => {
    if (!detailIsLive || detailStatus !== "ready") return;
    const id = detailRef.current?.id;
    if (!id) return;
    let cancelled = false;
    const timer = setInterval(() => {
      void (async () => {
        try {
          const next = await fetchSessionPanels(id);
          if (!cancelled && detailRef.current?.id === id) setDetail(next);
        } catch {
          // Keep the existing panels if a refresh fails; they're only stale.
        }
      })();
    }, 1_000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [detailIsLive, detailStatus, fetchSessionPanels]);

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
            <SessionReplay
              baseUrl={baseUrl}
              apiKey={apiKey}
              sessionId={detail.id}
              hiddenTypes={hiddenTypes}
              isLive={detailIsLive}
            />
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
          <PerfSummaryPanel perf={detail.perf} />
          <TopMeshes meshes={detail.meshes} />
          <PointerHeatmap bins={detail.pointer} gridSize={POINTER_BINS} />
          <CameraDirectionHeatmap bins={detail.camera} gridSize={CAMERA_BINS} />
          {detail.meta?.scene?.cameraType === "free" ? (
            <TrajectoryView
              baseUrl={baseUrl}
              apiKey={apiKey}
              sessionId={detail.id}
              scene={detail.meta?.scene?.sceneId ?? filters.scene}
            />
          ) : null}
          <div className="lg:col-span-2">
            <CameraDome3D bins={detail.camera} gridSize={CAMERA_BINS} />
          </div>
          <div className="lg:col-span-2">
            <SessionsTable sessions={data.sessions} selectedId={detail.id} onSelect={openSession} />
          </div>
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
          <div className="lg:col-span-2">
            <LivePresence
              snapshot={livePresence}
              status={liveStatus}
              feed={liveFeed}
              now={liveNow}
              onSelectSession={openSession}
            />
          </div>
          <div className="lg:col-span-2">
            <VolumeTimeseries
              buckets={data.timeseries}
              intervalMs={data.intervalMs}
              onBrush={brushRange}
              brushed={filters.window === "custom"}
              onClear={clearBrush}
            />
          </div>
          <div className="lg:col-span-2">
            <SceneHealth counts={data.counts} perf={data.perf} />
          </div>
          <div className="lg:col-span-2">
            <SceneMetrics
              coverage={data.coverage}
              cellSize={COVERAGE_CELL_SIZE}
              distance={data.distance}
              bucketSize={DISTANCE_BUCKET_SIZE}
              navigation={data.navigation}
            />
          </div>
          <PerfSummaryPanel perf={data.perf} />
          <TopMeshes meshes={data.meshes} />
          <div className="lg:col-span-2">
            <PerformanceSection data={data.performance} />
          </div>
          <InputSourceBreakdown rows={data.sources} />
          <PointerHeatmap bins={data.pointer} gridSize={POINTER_BINS} />
          <CameraDirectionHeatmap bins={data.camera} gridSize={CAMERA_BINS} />
          {filters.cameraMode !== "viewer" ? (
            <FloorPlanHeatmap bins={data.floorPlan} cellSize={FLOOR_CELL_SIZE} />
          ) : null}
          <div className="lg:col-span-2">
            <CameraDome3D bins={data.camera} gridSize={CAMERA_BINS} />
          </div>
          <div className="lg:col-span-2">
            <WorldHeatmap3D
              voxels={data.world}
              cellSize={WORLD_CELL_SIZE}
              proxyMeshes={data.proxyMeshes}
            />
          </div>
          <div className="lg:col-span-2">
            <WorldHeatmap3D
              voxels={data.gaze}
              cellSize={WORLD_CELL_SIZE}
              proxyMeshes={data.proxyMeshes}
              title="Gaze heatmap (3D)"
              subtitle="Camera-pose gaze hit-points voxel-binned in world space — what viewers actually look at"
              legendTitle="Gaze density"
              legendLow="few looks"
              legendHigh="most looks"
              legendNote="Each marker is a voxel where the camera-forward (gaze) ray hit your scene. Enable gaze capture in the SDK to populate this."
              emptyLabel="No gaze hit-points in range. Enable gaze capture in the SDK."
            />
          </div>
          <div className="lg:col-span-2">
            <ClickRays3D
              rays={data.clickRays}
              cellSize={WORLD_CELL_SIZE}
              proxyMeshes={data.proxyMeshes}
            />
          </div>
          <div className="lg:col-span-2">
            <FlowSankey3D
              links={data.flowLinks}
              gridSize={CAMERA_BINS}
              proxyMeshes={data.proxyMeshes}
              maxLinks={80}
              baseUrl={baseUrl}
              apiKey={apiKey}
              flowQuery={data.flowQuery}
              hasFirstPerson={data.hasFirstPerson}
            />
          </div>
          <div className="lg:col-span-2">
            <SessionsTable sessions={data.sessions} onSelect={openSession} />
          </div>
        </div>
      )}
    </main>
  );
}
