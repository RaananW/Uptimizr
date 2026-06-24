import {
  buildCameraDirectionHeatmap,
  buildCameraDistance,
  buildCameraGestures,
  buildCameraPositionHeatmap,
  buildCapabilityChanges,
  buildClickGazeRay,
  buildCompileStalls,
  buildDeadClicks,
  buildAggregateTrajectories,
  buildDistinctScenes,
  buildEventTypeCounts,
  buildFlowHeatmap,
  buildFpsHistogram,
  buildFrameTimePercentiles,
  buildFunnel,
  buildGazeHeatmap,
  buildHoverDwell,
  buildInteractionsBySource,
  buildJankRate,
  buildListSessions,
  buildMeshDwell,
  buildMeshInteractionKinds,
  buildNavigationStats,
  buildPerfByDevice,
  buildPerfByScene,
  buildPerfDistribution,
  buildPerfSummary,
  buildPointerHeatmap,
  buildRageClicks,
  buildRenderScaleTruth,
  buildResourcePercentiles,
  buildResourceSummary,
  buildSceneCoverage,
  buildSessionTrajectory,
  buildStabilityCounts,
  buildTimeseries,
  buildTopInputActions,
  buildTopMeshes,
  buildTopMeshesBySource,
  buildTopMeshesTrend,
  buildWorldHeatmap,
  buildXrAbandonment,
  buildXrRotationRate,
  buildXrSourceUsage,
  duckdbDialect,
  nodeSampleRowToEvent,
  type FunnelStepInput,
  type QuerySpec,
} from "@uptimizr/db/query";
import {
  anyEventSchema,
  funnelStepsSchema,
  sceneProxySchema,
  type AnyEvent,
} from "@uptimizr/schema";
import { DEMO_PROJECT_ID } from "./constants.js";
import type { WasmDb } from "./db.js";

/** A minimal HTTP request as forwarded from the service worker. */
export interface DemoRequest {
  method: string;
  /** Absolute or origin-relative URL. */
  url: string;
  body?: string;
}

/** A minimal HTTP response the service worker turns into a real `Response`. */
export interface DemoResponse {
  status: number;
  body: unknown;
  contentType?: string;
}

/** Superset of every builder option, all optional — see note in collectorStore. */
interface DemoOpts {
  since?: number;
  until?: number;
  bins?: number;
  limit?: number;
  cellSize?: number;
  bucket?: number;
  interval?: number;
  type?: string;
  scene?: string;
  source?: string;
  session?: string;
  cameraType?: string;
  minRepeats?: number;
  center?: [number, number, number];
  groupByOrigin?: boolean;
  originVoxel?: [number, number, number];
}

/** Map the dashboard camera-mode toggle to the stored `cameraType` (mirrors query.ts). */
function cameraTypeForMode(mode: string | null): string | undefined {
  if (mode === "first-person") return "free";
  if (mode === "viewer") return "arc-rotate";
  return undefined;
}

function num(sp: URLSearchParams, key: string): number | undefined {
  const raw = sp.get(key);
  if (raw === null || raw === "") return undefined;
  const n = Number(raw);
  return Number.isFinite(n) ? n : undefined;
}

function str(sp: URLSearchParams, key: string): string | undefined {
  return sp.get(key) ?? undefined;
}

/** Build the shared option bag from the query string (range + common filters). */
function readOpts(sp: URLSearchParams): DemoOpts {
  return {
    since: num(sp, "since"),
    until: num(sp, "until"),
    bins: num(sp, "bins"),
    limit: num(sp, "limit"),
    cellSize: num(sp, "cellSize"),
    bucket: num(sp, "bucket"),
    interval: num(sp, "interval"),
    type: str(sp, "type"),
    scene: str(sp, "scene"),
    source: str(sp, "source"),
    session: str(sp, "session"),
    cameraType: cameraTypeForMode(sp.get("cameraMode")),
    minRepeats: num(sp, "minRepeats"),
  };
}

function ok(body: unknown): DemoResponse {
  return { status: 200, body };
}

/**
 * Table of every read endpoint, mapping the route path to the dialect-agnostic
 * builder it runs (mirroring the collector's `query.ts` one-to-one). The opts
 * superset is structurally assignable to each builder's narrower option type
 * because every field is optional, so one bag drives them all.
 */
type BuilderRoute = (pid: string, opts: DemoOpts, sp: URLSearchParams) => QuerySpec;

/**
 * Read routes handled out-of-band in {@link handleRequest} rather than through
 * {@link READ_ROUTES} — the parameterized session/scene endpoints plus the static
 * scene-representation listing. Listed in the collector's `:param` literal form so
 * the route-parity test (`routeParity.test.ts`) can diff this demo's coverage
 * against the collector's `query.ts` one-to-one. Keep in sync with the handlers
 * below.
 */
export const DEMO_SPECIAL_GET_ROUTES = [
  "/api/v1/sessions/:sessionId/trajectory",
  "/api/v1/sessions/:id/events",
  "/api/v1/sessions/:id/meta",
  "/api/v1/scene-representations",
  "/api/v1/scenes/:sceneId/representation",
  "/api/v1/funnel",
] as const;

export const READ_ROUTES: Record<string, BuilderRoute> = {
  "/api/v1/sessions": (pid, o) => buildListSessions(pid, o, duckdbDialect),
  "/api/v1/heatmaps/pointer": (pid, o) => buildPointerHeatmap(pid, o, duckdbDialect),
  "/api/v1/heatmaps/world": (pid, o) => buildWorldHeatmap(pid, o, duckdbDialect),
  "/api/v1/heatmaps/gaze": (pid, o) => buildGazeHeatmap(pid, o, duckdbDialect),
  "/api/v1/heatmaps/camera": (pid, o) => buildCameraDirectionHeatmap(pid, o, duckdbDialect),
  "/api/v1/heatmaps/position": (pid, o) => buildCameraPositionHeatmap(pid, o, duckdbDialect),
  "/api/v1/heatmaps/click-rays": (pid, o) => buildClickGazeRay(pid, o, duckdbDialect),
  "/api/v1/heatmaps/flow": (pid, o, sp) =>
    buildFlowHeatmap(
      pid,
      {
        ...o,
        groupByOrigin: sp.get("groupByOrigin") === "true" || sp.get("groupByOrigin") === "1",
        originVoxel: parseVoxel(sp.get("originVoxel")),
      },
      duckdbDialect,
    ),
  "/api/v1/meshes/top": (pid, o) => buildTopMeshes(pid, o, duckdbDialect),
  "/api/v1/meshes/sources": (pid, o) => buildTopMeshesBySource(pid, o, duckdbDialect),
  "/api/v1/meshes/trend": (pid, o) => buildTopMeshesTrend(pid, o, duckdbDialect),
  "/api/v1/meshes/kinds": (pid, o) => buildMeshInteractionKinds(pid, o, duckdbDialect),
  "/api/v1/meshes/dwell": (pid, o) => buildMeshDwell(pid, o, duckdbDialect),
  "/api/v1/clicks/dead": (pid, o) => buildDeadClicks(pid, o, duckdbDialect),
  "/api/v1/clicks/rage": (pid, o) => buildRageClicks(pid, o, duckdbDialect),
  "/api/v1/hover/dwell": (pid, o) => buildHoverDwell(pid, o, duckdbDialect),
  "/api/v1/perf/compile-stalls": (pid, o) => buildCompileStalls(pid, o, duckdbDialect),
  "/api/v1/perf": (pid, o) => buildPerfSummary(pid, o, duckdbDialect),
  "/api/v1/perf/render-scale": (pid, o) => buildRenderScaleTruth(pid, o, duckdbDialect),
  "/api/v1/perf/resources": (pid, o) => buildResourceSummary(pid, o, duckdbDialect),
  "/api/v1/perf/distribution": (pid, o) => buildPerfDistribution(pid, o, duckdbDialect),
  "/api/v1/perf/fps-histogram": (pid, o) => buildFpsHistogram(pid, o, duckdbDialect),
  "/api/v1/perf/frame-time": (pid, o) => buildFrameTimePercentiles(pid, o, duckdbDialect),
  "/api/v1/perf/jank": (pid, o) => buildJankRate(pid, o, duckdbDialect),
  "/api/v1/perf/by-device": (pid, o) => buildPerfByDevice(pid, o, duckdbDialect),
  "/api/v1/perf/by-scene": (pid, o) => buildPerfByScene(pid, o, duckdbDialect),
  "/api/v1/perf/resource-percentiles": (pid, o) => buildResourcePercentiles(pid, o, duckdbDialect),
  "/api/v1/perf/stability": (pid, o) => buildStabilityCounts(pid, o, duckdbDialect),
  "/api/v1/capabilities": (pid, o) => buildCapabilityChanges(pid, o, duckdbDialect),
  "/api/v1/camera-gestures": (pid, o) => buildCameraGestures(pid, o, duckdbDialect),
  "/api/v1/coverage": (pid, o) => buildSceneCoverage(pid, o, duckdbDialect),
  "/api/v1/camera/distance": (pid, o, sp) =>
    buildCameraDistance(pid, { ...o, center: parseCenter(sp) }, duckdbDialect),
  "/api/v1/navigation": (pid, o) => buildNavigationStats(pid, o, duckdbDialect),
  "/api/v1/xr/rotation": (pid, o) => buildXrRotationRate(pid, o, duckdbDialect),
  "/api/v1/xr/sources": (pid, o) => buildXrSourceUsage(pid, o, duckdbDialect),
  "/api/v1/xr/abandonment": (pid, o) => buildXrAbandonment(pid, o, duckdbDialect),
  "/api/v1/interactions/sources": (pid, o) => buildInteractionsBySource(pid, o, duckdbDialect),
  "/api/v1/input-actions/top": (pid, o) => buildTopInputActions(pid, o, duckdbDialect),
  "/api/v1/scenes": (pid, o) => buildDistinctScenes(pid, o, duckdbDialect),
  "/api/v1/timeseries": (pid, o) => buildTimeseries(pid, o, duckdbDialect),
  "/api/v1/event-counts": (pid, o) => buildEventTypeCounts(pid, o, duckdbDialect),
  "/api/v1/paths": (pid, o) => buildAggregateTrajectories(pid, o, duckdbDialect),
};

function parseVoxel(raw: string | null): [number, number, number] | undefined {
  if (!raw) return undefined;
  const parts = raw.split(",").map(Number);
  return parts.length === 3 ? [parts[0]!, parts[1]!, parts[2]!] : undefined;
}

function parseCenter(sp: URLSearchParams): [number, number, number] | undefined {
  const x = num(sp, "centerX");
  const y = num(sp, "centerY");
  const z = num(sp, "centerZ");
  if (x == null && y == null && z == null) return undefined;
  return [x ?? 0, y ?? 0, z ?? 0];
}

/**
 * Route one forwarded request to the in-browser store. This is the in-page
 * analogue of the collector's Fastify routes: same paths, same query params,
 * same JSON responses — only the engine (DuckDB-Wasm) and the transport (a
 * service-worker message) differ. Auth is a no-op: the demo is single-tenant and
 * public, so any/empty `x-api-key` resolves to the one demo project.
 */
export async function handleRequest(db: WasmDb, req: DemoRequest): Promise<DemoResponse> {
  const url = new URL(req.url, "http://demo.local");
  const path = url.pathname;
  const sp = url.searchParams;
  const pid = DEMO_PROJECT_ID;

  if (path === "/health") return ok({ status: "ok" });

  if (req.method === "POST" && path === "/api/v1/collect") {
    return handleCollect(db, req.body);
  }

  const trajectory = path.match(/^\/api\/v1\/sessions\/([^/]+)\/trajectory$/);
  if (req.method === "GET" && trajectory) {
    const sessionId = decodeURIComponent(trajectory[1]!);
    const rows = await db.all(
      buildSessionTrajectory(pid, { ...readOpts(sp), session: sessionId }, duckdbDialect),
    );
    return ok(rows);
  }

  const sessionEvents = path.match(/^\/api\/v1\/sessions\/([^/]+)\/events$/);
  if (req.method === "GET" && sessionEvents) {
    return handleSessionEvents(db, decodeURIComponent(sessionEvents[1]!));
  }

  const sessionMeta = path.match(/^\/api\/v1\/sessions\/([^/]+)\/meta$/);
  if (req.method === "GET" && sessionMeta) {
    return handleSessionMeta(db, decodeURIComponent(sessionMeta[1]!));
  }

  // Scene registry (ADR 0014): the playground auto-registers its scene proxy so
  // world/gaze heatmaps and session replay can render the scene's geometry. The
  // demo persists it in the in-browser store exactly like the collector, then
  // serves it back (or 404s) so the dashboard sees identical behavior.
  if (path === "/api/v1/scene-representations") {
    return ok(await db.listSceneRepresentations());
  }
  const representation = path.match(/^\/api\/v1\/scenes\/([^/]+)\/representation$/);
  if (representation) {
    const sceneId = decodeURIComponent(representation[1]!);
    if (req.method === "PUT") {
      let body: { proxy?: unknown; label?: unknown };
      try {
        body = JSON.parse(req.body ?? "{}") as { proxy?: unknown; label?: unknown };
      } catch {
        return { status: 400, body: { error: "invalid JSON" } };
      }
      const result = sceneProxySchema.safeParse(body.proxy);
      if (!result.success) {
        return { status: 400, body: { error: "invalid scene proxy" } };
      }
      if (result.data.sceneId !== sceneId) {
        return { status: 400, body: { error: "proxy sceneId does not match path" } };
      }
      const label = typeof body.label === "string" ? body.label : null;
      await db.putSceneProxy(result.data, label);
      return ok(await db.getSceneRepresentation(sceneId));
    }
    if (req.method === "GET") {
      const stored = await db.getSceneRepresentation(sceneId);
      if (!stored) return { status: 404, body: { error: "scene representation not found" } };
      return ok(stored);
    }
  }

  if (req.method === "GET") {
    // Funnel (#78): `steps` is a JSON array validated against the shared schema,
    // mirroring the collector's `GET /api/v1/funnel` (400 on bad input). It is the
    // one read route whose body is too rich for the flat `readOpts` bag.
    if (path === "/api/v1/funnel") {
      let parsed: unknown;
      try {
        parsed = JSON.parse(sp.get("steps") ?? "");
      } catch {
        return { status: 400, body: { error: "steps must be a JSON array" } };
      }
      const result = funnelStepsSchema.safeParse(parsed);
      if (!result.success) {
        return { status: 400, body: { error: "invalid funnel steps" } };
      }
      const rows = await db.all(
        buildFunnel(
          pid,
          { ...readOpts(sp), steps: result.data as readonly FunnelStepInput[] },
          duckdbDialect,
        ),
      );
      return ok(rows);
    }

    const route = READ_ROUTES[path];
    if (route) {
      const rows = await db.all(route(pid, readOpts(sp), sp));
      return ok(rows);
    }
  }

  return { status: 404, body: { error: "not found" } };
}

/** Validate and ingest a collect batch, returning `{ accepted, rejected }`. */
async function handleCollect(db: WasmDb, rawBody: string | undefined): Promise<DemoResponse> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody ?? "{}");
  } catch {
    return { status: 400, body: { error: "invalid JSON" } };
  }
  const events = (parsed as { events?: unknown }).events;
  if (!Array.isArray(events)) {
    return { status: 400, body: { error: "missing events array" } };
  }
  const accepted: AnyEvent[] = [];
  let rejected = 0;
  for (const candidate of events) {
    const result = anyEventSchema.safeParse(candidate);
    // The demo is single-tenant: whatever project the embedded playground is
    // configured for, every event is folded into the one public demo project so
    // the dashboard (which reads `DEMO_PROJECT_ID`) sees it.
    if (result.success) accepted.push({ ...result.data, projectId: DEMO_PROJECT_ID });
    else rejected += 1;
  }
  if (accepted.length > 0) await db.insertEvents(accepted);
  return ok({ accepted: accepted.length, rejected });
}

/** Reconstruct a session's events from stored payloads + node samples, ts-ordered. */
async function handleSessionEvents(db: WasmDb, sessionId: string): Promise<DemoResponse> {
  const payloadRows = await db.all<{ payload: string; ts_ms: number }>({
    query: `SELECT payload, epoch_ms(ts) AS ts_ms FROM events
            WHERE project_id = $projectId AND session_id = $sessionId ORDER BY ts ASC`,
    query_params: { projectId: DEMO_PROJECT_ID, sessionId },
  });
  const nodeRows = await db.all<{
    ts_ms: number;
    sdk_version: string;
    scene_id: string;
    node_id: string;
    bone_id: string;
    child_path: string;
    position: number[];
    rotation: number[];
    scale: number[];
  }>({
    query: `SELECT epoch_ms(ts) AS ts_ms, sdk_version, scene_id, node_id, bone_id, child_path,
                   position, rotation, scale
            FROM node_samples
            WHERE project_id = $projectId AND session_id = $sessionId ORDER BY ts ASC`,
    query_params: { projectId: DEMO_PROJECT_ID, sessionId },
  });

  const events: AnyEvent[] = [];
  for (const row of payloadRows) {
    try {
      events.push(JSON.parse(row.payload) as AnyEvent);
    } catch {
      /* skip a corrupt payload */
    }
  }
  for (const row of nodeRows) {
    events.push(
      nodeSampleRowToEvent(
        {
          project_id: DEMO_PROJECT_ID,
          session_id: sessionId,
          sdk_version: row.sdk_version,
          scene_id: row.scene_id,
          node_id: row.node_id,
          bone_id: row.bone_id,
          child_path: row.child_path,
          position: row.position,
          rotation: row.rotation,
          scale: row.scale,
        },
        row.ts_ms,
      ),
    );
  }
  events.sort((a, b) => a.ts - b.ts);
  return ok(events);
}

/** Best-effort session descriptor from the session's `session_start` payload. */
async function handleSessionMeta(db: WasmDb, sessionId: string): Promise<DemoResponse> {
  const rows = await db.all<{ payload: string; started_ms: number }>({
    query: `SELECT payload, epoch_ms(ts) AS started_ms FROM events
            WHERE project_id = $projectId AND session_id = $sessionId AND event_type = 'session_start'
            ORDER BY ts ASC LIMIT 1`,
    query_params: { projectId: DEMO_PROJECT_ID, sessionId },
  });
  const first = rows[0];
  if (!first) return { status: 404, body: { error: "session not found" } };
  let payload: Record<string, unknown> = {};
  try {
    payload = JSON.parse(first.payload) as Record<string, unknown>;
  } catch {
    /* fall through with empty payload */
  }
  return ok({
    sessionId,
    startedAt: new Date(first.started_ms).toISOString(),
    device: payload.device,
    scene: payload.scene,
    user: payload.user,
  });
}
