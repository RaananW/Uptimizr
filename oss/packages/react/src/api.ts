// Typed client for the collector's query API (`@uptimizr/collector-server`).
//
// This is the single source of the query client and its response types: the
// standalone dashboard and any app embedding `@uptimizr/react` panels both read
// the collector over HTTP through this class, authenticated with a project API
// key. The browser never talks to ClickHouse/Postgres directly.
//
// Response shapes mirror the row types returned by `@uptimizr/db` query
// builders. They are intentionally additive: new fields can appear without
// breaking existing readers.

export interface SessionSummary {
  session_id: string;
  visitor_id: string;
  events: number;
  started_at: string;
  ended_at: string;
}

/** A single bin of the 2D pointer heatmap grid. */
export interface HeatmapBin {
  gx: number;
  gy: number;
  count: number;
}

/** A single bin of the camera view-direction heatmap (spherical angles). */
export interface DirectionBin {
  azimuth_bin: number;
  elevation_bin: number;
  count: number;
}

export interface MeshCount {
  mesh: string;
  count: number;
}

/** A single voxel of the world-space (3D) pointer heatmap. */
export interface WorldHeatmapBin {
  vx: number;
  vy: number;
  vz: number;
  count: number;
}

/**
 * One cell of the top-down "floor plan" camera-position heatmap (ADR 0026):
 * `camera_sample` world positions binned on the X/Z ground plane. `avg_y` is
 * the mean eye height in the cell; `count` is the number of samples.
 */
export interface PositionBin {
  gx: number;
  gz: number;
  avg_y: number;
  count: number;
}

/** One ordered point of a session's walked path (ADR 0026), oldest first. */
export interface TrajectoryPoint {
  ts: number;
  x: number;
  y: number;
  z: number;
}

/**
 * A view-gated click ray (design §7.2/§7.3): an aggregated `pointer_click`
 * correlated to the nearest preceding `camera_sample`. Carries the camera
 * origin voxel (for view-gating), the averaged origin/hit world points (the ray
 * endpoints), the clicked `mesh`, and a hit `count`.
 */
export interface ClickRay {
  camVoxel: [number, number, number];
  origin: [number, number, number];
  hitVoxel: [number, number, number];
  hit: [number, number, number];
  mesh: string;
  count: number;
}

/** One aggregate flow link from a camera-direction bin to a clicked mesh. */
export interface FlowLink {
  azimuth_bin: number;
  elevation_bin: number;
  mesh: string;
  count: number;
  /**
   * Standpoint voxel — the click-time camera-position cell. Present only in the
   * position-aware mode (§7.8), i.e. when `groupByOrigin`/`originVoxel` is set.
   */
  originVoxel?: [number, number, number];
  /** Averaged standpoint world point for the voxel (position-aware mode, §7.8). */
  origin?: [number, number, number];
}

/** A distinct developer-assigned scene with activity (ADR 0010). */
export interface SceneInfo {
  scene_id: string;
  events: number;
  last_seen: string;
}

/** Axis-aligned bounding box `[minX, minY, minZ, maxX, maxY, maxZ]`. */
export type Aabb = [number, number, number, number, number, number];

/** A single mesh proxy (world-space AABB) from a registered scene (ADR 0014). */
export interface SceneProxyMesh {
  name: string;
  aabb: Aabb;
  /**
   * Slash-joined named ancestor chain (e.g. `"npc/npc-body"`), when the mesh has
   * a fully-named hierarchy (ADR 0033). Lets viewers match a proxy mesh to a
   * tracked moving actor so it can be drawn as a live marker instead of a box.
   */
  path?: string;
}

/**
 * A registered scene representation (proxy geometry) used as a backdrop under
 * the world heatmap so hotspots read against the developer's actual scene.
 */
export interface SceneRepresentation {
  sceneId: string;
  label: string | null;
  kind: "none" | "proxy" | "asset";
  upAxis: "y" | "z";
  unitScale: number;
  bounds: Aabb | null;
  proxy: { meshes: SceneProxyMesh[] } | null;
  contentHash: string | null;
}

/** One bucket of the event-volume time-series (the 4th dimension). */
export interface TimeseriesBucket {
  /** Start of the bucket as epoch milliseconds. */
  bucket: number;
  events: number;
  avg_fps: number;
}

/** Per-event-type count over the active range. */
export interface EventTypeCount {
  event_type: string;
  count: number;
}

/** An occupied camera-position voxel (scene coverage / dead zones, #38). */
export interface CoverageVoxel {
  vx: number;
  vy: number;
  vz: number;
  count: number;
}

/** One bucket of the camera-to-center distance histogram (zoom, #39). */
export interface CameraDistanceBucket {
  bucket: number;
  count: number;
}

/** Per-session navigation effort / friction summary (#40). */
export interface NavigationStat {
  session_id: string;
  segments: number;
  total_distance: number;
  active_segments: number;
  active_distance: number;
}

/**
 * Per-kind camera-navigation gesture summary from `camera_gesture` events
 * (ADR 0025): the orbit / pan / dolly / zoom / roll / fly / navigate breakdown
 * with per-kind counts and durations. Powers the navigation-style mix panel.
 */
export interface CameraGestureStat {
  /** Gesture class (`orbit` / `pan` / `dolly` / `zoom` / `roll` / `fly` / `navigate`). */
  kind: string;
  /** Number of gestures of this kind. */
  gestures: number;
  /** Total time spent in this gesture kind, in ms. */
  total_ms: number;
  /** Average gesture duration, in ms. */
  avg_ms: number;
  /** Longest single gesture, in ms. */
  max_ms: number;
}

/** One `(event_type, source)` row of the input-source breakdown (ADR 0011). */
export interface InteractionSource {
  event_type: string;
  source: string;
  count: number;
  sessions: number;
}

/** Input-source vocabulary for the pointer/world heatmap filter (ADR 0011). */
export type InputSource =
  | "mouse"
  | "touch"
  | "stylus"
  | "pen"
  | "xr-controller"
  | "hand"
  | "gaze"
  | "transient"
  | "other";

export interface PerfSummary {
  samples: number;
  avg_fps: number;
  min_fps: number;
  p50_fps: number;
}

/** Per-session-then-aggregate FPS percentiles (ADR 0028 §1). */
export interface PerfDistribution {
  sessions: number;
  samples: number;
  p05_fps: number;
  p50_fps: number;
  p95_fps: number;
}

/** One bin of the per-session-median FPS histogram (ADR 0028 §1). */
export interface FpsHistogramBin {
  bucket: number;
  sessions: number;
}

/** Per-session-then-aggregate frame-time percentiles, in ms (ADR 0028 §1). */
export interface FrameTimePercentiles {
  sessions: number;
  samples: number;
  p50_ms: number;
  p95_ms: number;
}

/** Per-session-then-aggregate jank rate (ADR 0028 §1). */
export interface JankRate {
  sessions: number;
  total_long_frames: number;
  median_rate: number;
  worst_decile_rate: number;
}

/** FPS segmented by device class from `session_start.device` (ADR 0028 §2). */
export interface PerfByDevice {
  engine: string;
  is_mobile: string;
  renderer: string;
  sessions: number;
  samples: number;
  p50_fps: number;
}

/** FPS segmented by scene, per-session-then-aggregate (ADR 0028 §1). */
export interface PerfByScene {
  scene_id: string;
  sessions: number;
  samples: number;
  p50_fps: number;
}

/** Per-session-then-aggregate GPU/memory footprint percentiles (ADR 0028 §1). */
export interface ResourcePercentiles {
  sessions: number;
  samples: number;
  p50_js_heap_bytes: number;
  p95_js_heap_bytes: number;
  p50_texture_bytes: number;
  p95_texture_bytes: number;
  p50_triangles: number;
  p95_triangles: number;
}

/** Stability-incident counts (context losses, compile stalls). */
export interface StabilityCounts {
  context_losses: number;
  compile_stalls: number;
  incidents: number;
}

/** Coarse per-session descriptor (from the session's `session_start` event). */
export interface SessionMeta {
  sessionId: string;
  startedAt?: string;
  device?: {
    gpu?: string;
    renderer?: string;
    screen?: { width: number; height: number; dpr?: number };
    [key: string]: unknown;
  };
  scene?: { sceneId?: string; [key: string]: unknown };
  user?: Record<string, unknown>;
}

/** Coarse, non-identifying recency bucket for a live session (ADR 0032 §3a). */
export type ActivityLevel = "active" | "recent" | "idle";

/** A single non-identifying live roster entry (ADR 0032 §3a). */
export interface PresenceRosterItem {
  sessionId: string;
  sceneId: string;
  /** Server receive time of the session's first seen event (epoch ms). */
  startedAt: number;
  /** Server receive time of the session's most recent event (epoch ms). */
  lastSeen: number;
  /** Coarse recency bucket derived from `lastSeen`. */
  activity: ActivityLevel;
}

/** Aggregate live snapshot for a project, pushed over SSE (ADR 0032 §3). */
export interface PresenceSnapshot {
  /** Distinct live sessions within the window. */
  activeSessions: number;
  /** Distinct live visitors within the window. */
  activeVisitors: number;
  /** Non-identifying roster, most-recently-active first. */
  sessions: PresenceRosterItem[];
}

/** A short-lived live-stream auth token minted from a project API key (ADR 0032 §7). */
export interface LiveToken {
  token: string;
  /** Token expiry as epoch milliseconds. */
  expiresAt: number;
}

/** Shared time-range + binning query parameters. */
export interface QueryParams {
  since?: number;
  until?: number;
  bins?: number;
  limit?: number;
  /** Scope an aggregate to a single session id. */
  session?: string;
  /** Restrict to one developer-assigned scene (ADR 0010). */
  scene?: string;
  /** Restrict a pointer/world heatmap to one input source (ADR 0011). */
  source?: InputSource;
  /** Restrict to one camera mode: viewer (orbit) or first-person (walkable) (ADR 0026). */
  cameraMode?: "viewer" | "first-person";
  /** World-heatmap voxel size in world units. */
  cellSize?: number;
  /** §7.8 position-aware flow: also group links by standpoint (camera-position) voxel. */
  groupByOrigin?: boolean;
  /** §7.8 position-aware flow: restrict to clicks made from one standpoint voxel `[vx, vy, vz]`. */
  originVoxel?: [number, number, number];
  /** Time-series bucket width in seconds. */
  interval?: number;
  /** Time-series: restrict the volume to a single event type. */
  type?: string;
  /** Camera-distance histogram: world-space center the distance is measured from. */
  centerX?: number;
  centerY?: number;
  centerZ?: number;
  /** Camera-distance histogram bucket width in world units. */
  bucketSize?: number;
  /** Navigation: minimum per-sample travel (world units) counted as active movement. */
  moveThreshold?: number;
  /** FPS histogram bin width (frames per second). */
  bucket?: number;
}

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

/**
 * Thin, dependency-free client over the collector query API. Construct one per
 * `(baseUrl, apiKey)` pair; methods map one-to-one to query endpoints.
 */
export class CollectorApi {
  constructor(
    private readonly baseUrl: string,
    private readonly apiKey: string,
  ) {}

  private async get<T>(path: string, params: QueryParams = {}): Promise<T> {
    const url = new URL(path, ensureTrailingSlash(this.baseUrl));
    for (const [key, value] of Object.entries(params)) {
      if (value != null) url.searchParams.set(key, String(value));
    }
    const res = await fetch(url, {
      headers: { "x-api-key": this.apiKey },
      cache: "no-store",
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new ApiError(body || res.statusText, res.status);
    }
    return (await res.json()) as T;
  }

  sessions(params?: QueryParams): Promise<SessionSummary[]> {
    return this.get<SessionSummary[]>("api/v1/sessions", params).then((rows) =>
      rows.map((r) => ({ ...r, events: Number(r.events) })),
    );
  }

  pointerHeatmap(params?: QueryParams): Promise<HeatmapBin[]> {
    return this.get<HeatmapBin[]>("api/v1/heatmaps/pointer", params);
  }

  cameraHeatmap(params?: QueryParams): Promise<DirectionBin[]> {
    return this.get<DirectionBin[]>("api/v1/heatmaps/camera", params);
  }

  topMeshes(params?: QueryParams): Promise<MeshCount[]> {
    return this.get<MeshCount[]>("api/v1/meshes/top", params).then((rows) =>
      rows.map((r) => ({ ...r, count: Number(r.count) })),
    );
  }

  perf(params?: QueryParams): Promise<PerfSummary> {
    // ClickHouse returns count()/aggregate columns as JSON strings (and NULL for
    // the fps stats when there are no samples). Coerce to numbers so the empty
    // guard (`samples === 0`) and number formatting behave correctly.
    return this.get<Record<string, unknown>>("api/v1/perf", params).then((raw) => ({
      samples: Number(raw.samples ?? 0),
      avg_fps: Number(raw.avg_fps ?? 0),
      min_fps: Number(raw.min_fps ?? 0),
      p50_fps: Number(raw.p50_fps ?? 0),
    }));
  }

  /** Per-session FPS distribution: p05/p50/p95 summarized across sessions (#81). */
  perfDistribution(params?: QueryParams): Promise<PerfDistribution> {
    return this.get<Record<string, unknown>[]>("api/v1/perf/distribution", params).then((rows) => {
      const r = rows[0] ?? {};
      return {
        sessions: Number(r.sessions ?? 0),
        samples: Number(r.samples ?? 0),
        p05_fps: Number(r.p05_fps ?? 0),
        p50_fps: Number(r.p50_fps ?? 0),
        p95_fps: Number(r.p95_fps ?? 0),
      };
    });
  }

  /** Histogram of per-session median FPS, bucketed into `bucket`-wide bins (#81). */
  fpsHistogram(params?: QueryParams): Promise<FpsHistogramBin[]> {
    return this.get<Record<string, unknown>[]>("api/v1/perf/fps-histogram", params).then((rows) =>
      rows.map((r) => ({ bucket: Number(r.bucket ?? 0), sessions: Number(r.sessions ?? 0) })),
    );
  }

  /** Per-session frame-time percentiles in ms: typical (p50) and worst (p95) (#81). */
  frameTimePercentiles(params?: QueryParams): Promise<FrameTimePercentiles> {
    return this.get<Record<string, unknown>[]>("api/v1/perf/frame-time", params).then((rows) => {
      const r = rows[0] ?? {};
      return {
        sessions: Number(r.sessions ?? 0),
        samples: Number(r.samples ?? 0),
        p50_ms: Number(r.p50_ms ?? 0),
        p95_ms: Number(r.p95_ms ?? 0),
      };
    });
  }

  /** Per-session jank rate: median and worst-decile long-frames-per-window (#81). */
  jankRate(params?: QueryParams): Promise<JankRate> {
    return this.get<Record<string, unknown>[]>("api/v1/perf/jank", params).then((rows) => {
      const r = rows[0] ?? {};
      return {
        sessions: Number(r.sessions ?? 0),
        total_long_frames: Number(r.total_long_frames ?? 0),
        median_rate: Number(r.median_rate ?? 0),
        worst_decile_rate: Number(r.worst_decile_rate ?? 0),
      };
    });
  }

  /** FPS segmented by device class (backend / mobile / GPU renderer) (#82). */
  perfByDevice(params?: QueryParams): Promise<PerfByDevice[]> {
    return this.get<Record<string, unknown>[]>("api/v1/perf/by-device", params).then((rows) =>
      rows.map((r) => ({
        engine: String(r.engine ?? ""),
        is_mobile: String(r.is_mobile ?? ""),
        renderer: String(r.renderer ?? ""),
        sessions: Number(r.sessions ?? 0),
        samples: Number(r.samples ?? 0),
        p50_fps: Number(r.p50_fps ?? 0),
      })),
    );
  }

  /** FPS segmented by scene (#82). */
  perfByScene(params?: QueryParams): Promise<PerfByScene[]> {
    return this.get<Record<string, unknown>[]>("api/v1/perf/by-scene", params).then((rows) =>
      rows.map((r) => ({
        scene_id: String(r.scene_id ?? ""),
        sessions: Number(r.sessions ?? 0),
        samples: Number(r.samples ?? 0),
        p50_fps: Number(r.p50_fps ?? 0),
      })),
    );
  }

  /** Per-session GPU/memory footprint percentiles (#83). */
  resourcePercentiles(params?: QueryParams): Promise<ResourcePercentiles> {
    return this.get<Record<string, unknown>[]>("api/v1/perf/resource-percentiles", params).then(
      (rows) => {
        const r = rows[0] ?? {};
        return {
          sessions: Number(r.sessions ?? 0),
          samples: Number(r.samples ?? 0),
          p50_js_heap_bytes: Number(r.p50_js_heap_bytes ?? 0),
          p95_js_heap_bytes: Number(r.p95_js_heap_bytes ?? 0),
          p50_texture_bytes: Number(r.p50_texture_bytes ?? 0),
          p95_texture_bytes: Number(r.p95_texture_bytes ?? 0),
          p50_triangles: Number(r.p50_triangles ?? 0),
          p95_triangles: Number(r.p95_triangles ?? 0),
        };
      },
    );
  }

  /** Stability-incident counts: context losses + compile stalls (#83). */
  stabilityCounts(params?: QueryParams): Promise<StabilityCounts> {
    return this.get<Record<string, unknown>[]>("api/v1/perf/stability", params).then((rows) => {
      const r = rows[0] ?? {};
      return {
        context_losses: Number(r.context_losses ?? 0),
        compile_stalls: Number(r.compile_stalls ?? 0),
        incidents: Number(r.incidents ?? 0),
      };
    });
  }

  /** World-space (3D) pointer heatmap voxels. */
  worldHeatmap(params?: QueryParams): Promise<WorldHeatmapBin[]> {
    return this.get<WorldHeatmapBin[]>("api/v1/heatmaps/world", params).then((rows) =>
      rows.map((r) => ({
        vx: Number(r.vx),
        vy: Number(r.vy),
        vz: Number(r.vz),
        count: Number(r.count),
      })),
    );
  }

  /** World-space (3D) gaze heatmap voxels — camera-pose surface hits (ADR 0030). */
  gazeHeatmap(params?: QueryParams): Promise<WorldHeatmapBin[]> {
    return this.get<WorldHeatmapBin[]>("api/v1/heatmaps/gaze", params).then((rows) =>
      rows.map((r) => ({
        vx: Number(r.vx),
        vy: Number(r.vy),
        vz: Number(r.vz),
        count: Number(r.count),
      })),
    );
  }

  /** Top-down floor-plan camera-position heatmap: where visitors stand (ADR 0026). */
  cameraPositionHeatmap(params?: QueryParams): Promise<PositionBin[]> {
    return this.get<Record<string, unknown>[]>("api/v1/heatmaps/position", params).then((rows) =>
      rows.map((r) => ({
        gx: Number(r.gx),
        gz: Number(r.gz),
        avg_y: Number(r.avg_y ?? 0),
        count: Number(r.count ?? 0),
      })),
    );
  }

  /** One session's ordered walked path: camera positions, oldest first (ADR 0026). */
  sessionTrajectory(id: string, params?: QueryParams): Promise<TrajectoryPoint[]> {
    return this.get<Record<string, unknown>[]>(
      `api/v1/sessions/${encodeURIComponent(id)}/trajectory`,
      params,
    ).then((rows) =>
      rows.map((r) => ({
        ts: Number(r.ts),
        x: Number(r.x),
        y: Number(r.y),
        z: Number(r.z),
      })),
    );
  }

  /** View-gated click rays: camera-origin → hit, per voxel and clicked mesh. */
  clickRays(params?: QueryParams): Promise<ClickRay[]> {
    return this.get<Record<string, unknown>[]>("api/v1/heatmaps/click-rays", params).then((rows) =>
      rows.map(
        (r): ClickRay => ({
          camVoxel: [Number(r.cam_vx), Number(r.cam_vy), Number(r.cam_vz)],
          origin: [Number(r.origin_x), Number(r.origin_y), Number(r.origin_z)],
          hitVoxel: [Number(r.hit_vx), Number(r.hit_vy), Number(r.hit_vz)],
          hit: [Number(r.hit_x), Number(r.hit_y), Number(r.hit_z)],
          mesh: String(r.mesh ?? ""),
          count: Number(r.count),
        }),
      ),
    );
  }

  /**
   * Aggregate gaze→mesh flow links for no-timeline directional analysis (§7.5).
   * In position-aware mode (§7.8) each link also carries its standpoint voxel.
   */
  flowHeatmap(params?: QueryParams): Promise<FlowLink[]> {
    return this.get<Record<string, unknown>[]>("api/v1/heatmaps/flow", params).then((rows) =>
      rows.map((r) => {
        const link: FlowLink = {
          azimuth_bin: Number(r.azimuth_bin),
          elevation_bin: Number(r.elevation_bin),
          mesh: String(r.mesh ?? ""),
          count: Number(r.count),
        };
        if (r.origin_vx != null) {
          link.originVoxel = [Number(r.origin_vx), Number(r.origin_vy), Number(r.origin_vz)];
          link.origin = [Number(r.origin_x), Number(r.origin_y), Number(r.origin_z)];
        }
        return link;
      }),
    );
  }

  /** Distinct scenes (+ activity) for the scene selector (ADR 0010). */
  scenes(params?: QueryParams): Promise<SceneInfo[]> {
    return this.get<SceneInfo[]>("api/v1/scenes", params).then((rows) =>
      rows.map((r) => ({ ...r, events: Number(r.events) })),
    );
  }

  /** Event-volume time-series, bucketed by interval (the 4th dimension). */
  timeseries(params?: QueryParams): Promise<TimeseriesBucket[]> {
    return this.get<Record<string, unknown>[]>("api/v1/timeseries", params).then((rows) =>
      rows.map((r) => ({
        bucket: Number(r.bucket),
        events: Number(r.events ?? 0),
        avg_fps: Number(r.avg_fps ?? 0),
      })),
    );
  }

  /** Per-event-type counts over the active range (powers the health panel). */
  eventCounts(params?: QueryParams): Promise<EventTypeCount[]> {
    return this.get<Record<string, unknown>[]>("api/v1/event-counts", params).then((rows) =>
      rows.map((r) => ({ event_type: String(r.event_type), count: Number(r.count ?? 0) })),
    );
  }

  /** Occupied camera-position voxels for scene coverage / dead-zone analysis (#38). */
  coverage(params?: QueryParams): Promise<CoverageVoxel[]> {
    return this.get<Record<string, unknown>[]>("api/v1/coverage", params).then((rows) =>
      rows.map((r) => ({
        vx: Number(r.vx),
        vy: Number(r.vy),
        vz: Number(r.vz),
        count: Number(r.count ?? 0),
      })),
    );
  }

  /** Camera-to-center distance histogram for zoom / distance distribution (#39). */
  cameraDistance(params?: QueryParams): Promise<CameraDistanceBucket[]> {
    return this.get<Record<string, unknown>[]>("api/v1/camera/distance", params).then((rows) =>
      rows.map((r) => ({ bucket: Number(r.bucket), count: Number(r.count ?? 0) })),
    );
  }

  /** Per-session navigation effort / friction (#40). */
  navigation(params?: QueryParams): Promise<NavigationStat[]> {
    return this.get<Record<string, unknown>[]>("api/v1/navigation", params).then((rows) =>
      rows.map((r) => ({
        session_id: String(r.session_id ?? ""),
        segments: Number(r.segments ?? 0),
        total_distance: Number(r.total_distance ?? 0),
        active_segments: Number(r.active_segments ?? 0),
        active_distance: Number(r.active_distance ?? 0),
      })),
    );
  }

  /**
   * Per-kind camera-navigation gesture breakdown from `camera_gesture` events
   * (ADR 0025): orbit / pan / dolly / zoom / roll / fly / navigate, each with a
   * count and duration stats. Drives the navigation-style mix panel.
   */
  cameraGestures(params?: QueryParams): Promise<CameraGestureStat[]> {
    return this.get<Record<string, unknown>[]>("api/v1/camera-gestures", params).then((rows) =>
      rows.map((r) => ({
        kind: String(r.kind ?? ""),
        gestures: Number(r.gestures ?? 0),
        total_ms: Number(r.total_ms ?? 0),
        avg_ms: Number(r.avg_ms ?? 0),
        max_ms: Number(r.max_ms ?? 0),
      })),
    );
  }

  /** Input-source breakdown: per `(event_type, source)` interaction counts (ADR 0011). */
  interactionsBySource(params?: QueryParams): Promise<InteractionSource[]> {
    return this.get<Record<string, unknown>[]>("api/v1/interactions/sources", params).then((rows) =>
      rows.map((r) => ({
        event_type: String(r.event_type ?? ""),
        source: String(r.source ?? ""),
        count: Number(r.count ?? 0),
        sessions: Number(r.sessions ?? 0),
      })),
    );
  }

  /** Coarse descriptor for a single session (device/scene/user). */
  sessionMeta(id: string): Promise<SessionMeta> {
    return this.get<SessionMeta>(`api/v1/sessions/${encodeURIComponent(id)}/meta`);
  }

  /**
   * Registered proxy geometry for a scene (ADR 0014), or `null` when the scene
   * has never been registered. Powers the 3D heatmap backdrop.
   */
  async sceneRepresentation(sceneId: string): Promise<SceneRepresentation | null> {
    try {
      return await this.get<SceneRepresentation>(
        `api/v1/scenes/${encodeURIComponent(sceneId)}/representation`,
      );
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) return null;
      throw err;
    }
  }

  /**
   * Exchange the project API key for a short-lived live token (ADR 0032 §7).
   * `EventSource` cannot send headers, so the live SSE endpoints authenticate
   * with this token as a `?token=` query param instead of the API key.
   */
  async liveToken(): Promise<LiveToken> {
    const url = new URL("api/v1/live/token", ensureTrailingSlash(this.baseUrl));
    const res = await fetch(url, {
      method: "POST",
      headers: { "x-api-key": this.apiKey },
      cache: "no-store",
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new ApiError(body || res.statusText, res.status);
    }
    return (await res.json()) as LiveToken;
  }

  /** SSE URL for the aggregate presence roster (ADR 0032 §3). */
  livePresenceUrl(token: string): string {
    const url = new URL("api/v1/live/presence", ensureTrailingSlash(this.baseUrl));
    url.searchParams.set("token", token);
    return url.toString();
  }

  /**
   * SSE URL for the project event firehose (ADR 0032 §3). `types` optionally
   * restricts the stream to a comma-separated event-type allow-list.
   */
  liveStreamUrl(token: string, types?: readonly string[]): string {
    const url = new URL("api/v1/live/stream", ensureTrailingSlash(this.baseUrl));
    url.searchParams.set("token", token);
    if (types && types.length > 0) url.searchParams.set("types", types.join(","));
    return url.toString();
  }

  /** SSE URL for a single session's live-follow tail (ADR 0032 §3, gated by retention). */
  liveSessionUrl(token: string, sessionId: string): string {
    const url = new URL(
      `api/v1/live/sessions/${encodeURIComponent(sessionId)}`,
      ensureTrailingSlash(this.baseUrl),
    );
    url.searchParams.set("token", token);
    return url.toString();
  }
}

function ensureTrailingSlash(url: string): string {
  return url.endsWith("/") ? url : `${url}/`;
}
