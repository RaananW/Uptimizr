import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import { Readable } from "node:stream";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { sceneProxySchema, funnelStepsSchema } from "@uptimizr/schema";
import { defaultCellSizeForBounds, type WorldAabb } from "@uptimizr/db";
import type { CollectorConfig } from "../config.js";
import type { CollectorStore } from "../store.js";

interface Options {
  store: CollectorStore;
  config: CollectorConfig;
}

/** Developer-assigned scene/area filter (ADR 0010). */
const sceneFilter = z
  .string()
  .regex(/^[A-Za-z0-9._:-]{1,64}$/)
  .optional();

/** Input-source filter (ADR 0011): restrict a heatmap to one kind of pointer. */
const sourceFilter = z
  .enum(["mouse", "touch", "stylus", "pen", "xr-controller", "hand", "gaze", "transient", "other"])
  .optional();

/** Single-session filter: scope an aggregate to one session id. */
const sessionFilter = z.string().min(1).max(128).optional();

/**
 * Camera-mode filter (ADR 0026): the dashboard's high-level viewer/first-person
 * toggle. `viewer` selects orbit/arc-rotate sessions, `first-person` selects
 * free/walkable sessions. Translated to the stored `cameraType` via
 * {@link cameraTypeForMode} before it reaches the aggregation layer.
 */
const cameraModeFilter = z.enum(["viewer", "first-person"]).optional();

/** Map the dashboard camera-mode toggle to the stored `cameraType` value. */
function cameraTypeForMode(mode: "viewer" | "first-person" | undefined): string | undefined {
  if (mode === "first-person") return "free";
  if (mode === "viewer") return "arc-rotate";
  return undefined;
}

/**
 * World-space region filter (ADR 0040 §4): a `minX,minY,minZ,maxX,maxY,maxZ`
 * comma list naming an axis-aligned box to drill into. Validated to six finite
 * numbers with `max >= min` on every axis, then handed to the aggregation layer
 * as a {@link WorldAabb}. Omit for the whole scene.
 */
const regionFilter = z
  .string()
  .optional()
  .transform((val, ctx): WorldAabb | undefined => {
    if (val == null) return undefined;
    const parts = val.split(",").map((s) => Number(s.trim()));
    if (parts.length !== 6 || parts.some((n) => !Number.isFinite(n))) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "region must be 6 comma-separated finite numbers: minX,minY,minZ,maxX,maxY,maxZ",
      });
      return z.NEVER;
    }
    const [minX, minY, minZ, maxX, maxY, maxZ] = parts as [
      number,
      number,
      number,
      number,
      number,
      number,
    ];
    if (maxX < minX || maxY < minY || maxZ < minZ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "region max must be >= min on every axis",
      });
      return z.NEVER;
    }
    return [minX, minY, minZ, maxX, maxY, maxZ];
  });

/**
 * Resolve the effective voxel `cellSize` for a spatial heatmap (ADR 0040 §1).
 * When the caller pins a `cellSize` it wins. Otherwise the resolution is driven
 * by extent: a `region` drill-down sizes cells to the box, and a single selected
 * `scene` sizes them to its registered world bounds — so large scenes stay
 * legible instead of dissolving into a few coarse blocks. Returns `undefined`
 * when no extent is known, letting the aggregation fall back to its fixed default.
 */
async function resolveSpatialCellSize(
  store: CollectorStore,
  projectId: string,
  opts: { cellSize?: number; scene?: string; region?: WorldAabb },
): Promise<number | undefined> {
  if (opts.cellSize != null) return opts.cellSize;
  if (opts.region != null) return defaultCellSizeForBounds(opts.region) ?? undefined;
  if (opts.scene != null) {
    const rep = await store.getSceneRepresentation(projectId, opts.scene);
    if (rep?.bounds) return defaultCellSizeForBounds(rep.bounds) ?? undefined;
  }
  return undefined;
}

/** Shared time-range + binning query parameters. */
const rangeQuery = z.object({
  since: z.coerce.number().int().optional(),
  until: z.coerce.number().int().optional(),
  bins: z.coerce.number().int().positive().max(500).optional(),
  limit: z.coerce.number().int().positive().max(1000).optional(),
});

/** Sessions-list params: a time range, result cap, and camera-mode filter. */
const sessionsQueryParams = rangeQuery.extend({ cameraMode: cameraModeFilter });

/** Range params that also accept a single-session filter. */
const sessionScopedRangeQuery = rangeQuery.extend({ session: sessionFilter });

/** Bin-based heatmap params (camera) with optional scene + session filters. */
const heatmapQueryParams = rangeQuery.extend({ scene: sceneFilter, session: sessionFilter });

/** FPS-histogram params: range + scene/session filters plus an FPS `bucket` width. */
const fpsHistogramQueryParams = heatmapQueryParams.extend({
  bucket: z.coerce.number().int().positive().max(240).optional(),
});

/** Camera direction/position heatmap params: bins + scene/session + camera-mode. */
const cameraHeatmapQueryParams = heatmapQueryParams.extend({ cameraMode: cameraModeFilter });

/** Pointer heatmap params: scene + optional input-source + session filters. */
const pointerHeatmapQueryParams = heatmapQueryParams.extend({
  source: sourceFilter,
  cameraMode: cameraModeFilter,
});

/** Rage-click params: pointer filters + burst window (sec) and repeat threshold. */
const rageClickQueryParams = pointerHeatmapQueryParams.extend({
  interval: z.coerce.number().int().positive().max(60).optional(),
  minRepeats: z.coerce.number().int().min(2).max(100).optional(),
});

/** Mesh-trend params (#74): pointer filters + a `bucket` interval in seconds. */
const meshTrendQueryParams = pointerHeatmapQueryParams.extend({
  interval: z.coerce.number().int().positive().max(31_536_000).optional(),
});

/** World heatmap params: a positive voxel `cellSize` (world units) instead of bins. */
const worldHeatmapQueryParams = z.object({
  since: z.coerce.number().int().optional(),
  until: z.coerce.number().int().optional(),
  cellSize: z.coerce.number().positive().max(1000).optional(),
  limit: z.coerce.number().int().positive().max(1000).optional(),
  scene: sceneFilter,
  source: sourceFilter,
  cameraMode: cameraModeFilter,
  region: regionFilter,
});

/** World heatmap totals params (ADR 0040 §3): same filters as the world heatmap, no `limit`. */
const worldStatsQueryParams = z.object({
  since: z.coerce.number().int().optional(),
  until: z.coerce.number().int().optional(),
  cellSize: z.coerce.number().positive().max(1000).optional(),
  scene: sceneFilter,
  source: sourceFilter,
  cameraMode: cameraModeFilter,
  region: regionFilter,
});

/**
 * Gaze heatmap params (ADR 0030): a positive voxel `cellSize` plus scene/session
 * + camera-mode filters. Unlike the pointer world heatmap there is no `source`
 * (a camera-pose gaze hit has no input-source); a `session` scopes it to one visit.
 */
const gazeHeatmapQueryParams = z.object({
  since: z.coerce.number().int().optional(),
  until: z.coerce.number().int().optional(),
  cellSize: z.coerce.number().positive().max(1000).optional(),
  limit: z.coerce.number().int().positive().max(1000).optional(),
  scene: sceneFilter,
  session: sessionFilter,
  cameraMode: cameraModeFilter,
  region: regionFilter,
});

/** Gaze heatmap totals params (ADR 0040 §3): same filters as the gaze heatmap, no `limit`. */
const gazeStatsQueryParams = z.object({
  since: z.coerce.number().int().optional(),
  until: z.coerce.number().int().optional(),
  cellSize: z.coerce.number().positive().max(1000).optional(),
  scene: sceneFilter,
  session: sessionFilter,
  cameraMode: cameraModeFilter,
  region: regionFilter,
});

/**
 * Floor-plan camera-position heatmap params (ADR 0026): a ground-plane bin
 * `cellSize` (world units) plus scene/session/camera-mode filters and a cap.
 */
const cameraPositionQueryParams = z.object({
  since: z.coerce.number().int().optional(),
  until: z.coerce.number().int().optional(),
  cellSize: z.coerce.number().positive().max(1000).optional(),
  limit: z.coerce.number().int().positive().max(10000).optional(),
  scene: sceneFilter,
  session: sessionFilter,
  cameraMode: cameraModeFilter,
  region: regionFilter,
});

/**
 * Aggregate desire-line params (#73, ADR 0037): a ground-bin `cellSize` plus
 * scene + camera-mode filters and a generous point cap (poly-lines for *every*
 * session can run long). No single-session filter — this is the crowd view.
 */
const aggregatePathQueryParams = z.object({
  since: z.coerce.number().int().optional(),
  until: z.coerce.number().int().optional(),
  cellSize: z.coerce.number().positive().max(1000).optional(),
  limit: z.coerce.number().int().positive().max(50000).optional(),
  scene: sceneFilter,
  cameraMode: cameraModeFilter,
});

/** Session-trajectory params: a time range, scene filter, and point cap. */
const trajectoryQueryParams = z.object({
  since: z.coerce.number().int().optional(),
  until: z.coerce.number().int().optional(),
  limit: z.coerce.number().int().positive().max(10000).optional(),
  scene: sceneFilter,
});

/** Path param for a single session's trajectory. */
const sessionPathParams = z.object({
  sessionId: z.string().min(1).max(128),
});

/** Click-ray params: voxel `cellSize` + scene/source/session filters + result cap. */
const clickRayQueryParams = z.object({
  since: z.coerce.number().int().optional(),
  until: z.coerce.number().int().optional(),
  cellSize: z.coerce.number().positive().max(1000).optional(),
  limit: z.coerce.number().int().positive().max(1000).optional(),
  scene: sceneFilter,
  source: sourceFilter,
  session: sessionFilter,
});

/**
 * Flow params: camera-direction bins joined to clicked meshes (§7.5), plus the
 * optional position-aware dimension (§7.8): a standpoint voxel `cellSize`, a
 * `groupByOrigin` toggle, an `originVoxel` (`"vx,vy,vz"`) standpoint filter, and
 * the camera-mode filter that makes the panel walkable-scene aware (ADR 0026).
 */
const flowHeatmapQueryParams = heatmapQueryParams.extend({
  cameraMode: cameraModeFilter,
  cellSize: z.coerce.number().positive().max(1000).optional(),
  groupByOrigin: z.enum(["true", "false", "1", "0"]).optional(),
  originVoxel: z
    .string()
    .regex(/^-?\d+(\.\d+)?,-?\d+(\.\d+)?,-?\d+(\.\d+)?$/)
    .optional(),
});

/** Distinct-scenes params: a time range plus a result cap. */
const scenesQueryParams = z.object({
  since: z.coerce.number().int().optional(),
  until: z.coerce.number().int().optional(),
  limit: z.coerce.number().int().positive().max(1000).optional(),
});

/** Time-series params: range + scene + optional event-type filter + bucket interval (seconds). */
const timeseriesQueryParams = z.object({
  since: z.coerce.number().int().optional(),
  until: z.coerce.number().int().optional(),
  interval: z.coerce.number().int().positive().max(31_536_000).optional(),
  scene: sceneFilter,
  type: z
    .string()
    .regex(/^[a-z_]{1,40}$/)
    .optional(),
});

/** Event-type-counts params: range + optional scene filter. */
const eventCountsQueryParams = z.object({
  since: z.coerce.number().int().optional(),
  until: z.coerce.number().int().optional(),
  scene: sceneFilter,
});

/**
 * Funnel params (#78, ADR 0038): a time range, optional scene/camera-mode scope,
 * and `steps` — a JSON-encoded array of step predicates validated against
 * `funnelStepsSchema` in the handler (the structured input is too rich for a flat
 * query schema). The OSS dashboard has no authoring surface, so steps are passed
 * by the caller (CLI / hosted / ad-hoc), not stored.
 */
const funnelQueryParams = z.object({
  since: z.coerce.number().int().optional(),
  until: z.coerce.number().int().optional(),
  scene: sceneFilter,
  cameraMode: cameraModeFilter,
  steps: z.string().min(1).max(8192),
});

/** Scene-coverage params: voxel `cellSize` + scene/session filters + result cap. */
const coverageQueryParams = z.object({
  since: z.coerce.number().int().optional(),
  until: z.coerce.number().int().optional(),
  cellSize: z.coerce.number().positive().max(1000).optional(),
  limit: z.coerce.number().int().positive().max(10000).optional(),
  scene: sceneFilter,
  session: sessionFilter,
});

/** Camera-distance params: reference `center` (3 coords) + `bucketSize` + filters. */
const cameraDistanceQueryParams = z.object({
  since: z.coerce.number().int().optional(),
  until: z.coerce.number().int().optional(),
  centerX: z.coerce.number().optional(),
  centerY: z.coerce.number().optional(),
  centerZ: z.coerce.number().optional(),
  bucketSize: z.coerce.number().positive().max(1000).optional(),
  limit: z.coerce.number().int().positive().max(1000).optional(),
  scene: sceneFilter,
  session: sessionFilter,
});

/** Navigation-stats params: idle/active `moveThreshold` + scene/session filters. */
const navigationQueryParams = z.object({
  since: z.coerce.number().int().optional(),
  until: z.coerce.number().int().optional(),
  moveThreshold: z.coerce.number().nonnegative().max(1000).optional(),
  limit: z.coerce.number().int().positive().max(1000).optional(),
  scene: sceneFilter,
  session: sessionFilter,
});

/** XR rotation-rate params: `rapidTurn` (rad) threshold + scene/session filters. */
const xrRotationQueryParams = z.object({
  since: z.coerce.number().int().optional(),
  until: z.coerce.number().int().optional(),
  rapidTurn: z.coerce.number().nonnegative().max(Math.PI).optional(),
  limit: z.coerce.number().int().positive().max(1000).optional(),
  scene: sceneFilter,
  session: sessionFilter,
});

/** Path param for a single scene's representation. */
const sceneParams = z.object({
  sceneId: z.string().regex(/^[A-Za-z0-9._:-]{1,64}$/),
});

/** Body for registering a scene proxy: the proxy plus an optional display label. */
const putRepresentationBody = z.object({
  proxy: sceneProxySchema,
  label: z.string().max(200).optional(),
});

/**
 * Authenticate a read request with a project API key (`x-api-key`). Returns the
 * resolved project id, or sends a 401 and returns `null`. Reads are always scoped
 * to the authenticated project — any client-supplied project id is ignored.
 */
async function authProject(
  request: FastifyRequest,
  reply: FastifyReply,
  store: CollectorStore,
): Promise<string | null> {
  const key = request.headers["x-api-key"];
  if (typeof key !== "string" || key.length === 0) {
    await reply.code(401).send({ error: "missing api key" });
    return null;
  }
  const projectId = await store.resolveApiKey(key);
  if (!projectId) {
    await reply.code(401).send({ error: "invalid api key" });
    return null;
  }
  // Read endpoints require a `query`-capable key (ingest-only keys cannot read).
  if (projectId.capability !== "query") {
    await reply.code(403).send({ error: "api key not permitted to read" });
    return null;
  }
  return projectId.projectId;
}

/**
 * Query API. All aggregations are computed at query time (v1). Every route is
 * scoped to the authenticated project.
 */
export const queryRoutes: FastifyPluginAsync<Options> = async (app, { store, config }) => {
  const r = app.withTypeProvider<ZodTypeProvider>();

  r.get(
    "/api/v1/sessions",
    { schema: { querystring: sessionsQueryParams } },
    async (req, reply) => {
      const projectId = await authProject(req, reply, store);
      if (!projectId) return reply;
      const { cameraMode, ...rest } = req.query;
      return store.listSessions(projectId, { ...rest, cameraType: cameraTypeForMode(cameraMode) });
    },
  );

  r.get(
    "/api/v1/heatmaps/pointer",
    { schema: { querystring: pointerHeatmapQueryParams } },
    async (req, reply) => {
      const projectId = await authProject(req, reply, store);
      if (!projectId) return reply;
      const { cameraMode, ...rest } = req.query;
      return store.pointerHeatmap(projectId, {
        ...rest,
        cameraType: cameraTypeForMode(cameraMode),
      });
    },
  );

  r.get(
    "/api/v1/heatmaps/world",
    { schema: { querystring: worldHeatmapQueryParams } },
    async (req, reply) => {
      const projectId = await authProject(req, reply, store);
      if (!projectId) return reply;
      const { cameraMode, region, cellSize, ...rest } = req.query;
      const resolved = await resolveSpatialCellSize(store, projectId, {
        cellSize,
        scene: rest.scene,
        region,
      });
      return store.worldHeatmap(projectId, {
        ...rest,
        region,
        cellSize: resolved,
        cameraType: cameraTypeForMode(cameraMode),
      });
    },
  );

  // World heatmap totals (ADR 0040 §3) — true occupied-cell + hit counts behind
  // the truncated top-N voxels, so the viewer can report coverage/cold-spots and
  // "showing top N of M cells". Echoes the effective (possibly bounds-derived)
  // cellSize so the caller can label its own grid.
  r.get(
    "/api/v1/heatmaps/world/stats",
    { schema: { querystring: worldStatsQueryParams } },
    async (req, reply) => {
      const projectId = await authProject(req, reply, store);
      if (!projectId) return reply;
      const { cameraMode, region, cellSize, ...rest } = req.query;
      const resolved = await resolveSpatialCellSize(store, projectId, {
        cellSize,
        scene: rest.scene,
        region,
      });
      const stats = await store.worldHeatmapStats(projectId, {
        ...rest,
        region,
        cellSize: resolved,
        cameraType: cameraTypeForMode(cameraMode),
      });
      return { cellSize: resolved ?? 0.5, cells: stats.cells, hits: stats.hits };
    },
  );

  // World-space gaze heatmap (ADR 0030) — the "what did people actually look at"
  // sibling of the world (click) heatmap: voxel-binned `camera_sample` gaze hits.
  r.get(
    "/api/v1/heatmaps/gaze",
    { schema: { querystring: gazeHeatmapQueryParams } },
    async (req, reply) => {
      const projectId = await authProject(req, reply, store);
      if (!projectId) return reply;
      const { cameraMode, region, cellSize, ...rest } = req.query;
      const resolved = await resolveSpatialCellSize(store, projectId, {
        cellSize,
        scene: rest.scene,
        region,
      });
      return store.gazeHeatmap(projectId, {
        ...rest,
        region,
        cellSize: resolved,
        cameraType: cameraTypeForMode(cameraMode),
      });
    },
  );

  // Gaze heatmap totals (ADR 0040 §3) — gaze sibling of the world stats route.
  r.get(
    "/api/v1/heatmaps/gaze/stats",
    { schema: { querystring: gazeStatsQueryParams } },
    async (req, reply) => {
      const projectId = await authProject(req, reply, store);
      if (!projectId) return reply;
      const { cameraMode, region, cellSize, ...rest } = req.query;
      const resolved = await resolveSpatialCellSize(store, projectId, {
        cellSize,
        scene: rest.scene,
        region,
      });
      const stats = await store.gazeHeatmapStats(projectId, {
        ...rest,
        region,
        cellSize: resolved,
        cameraType: cameraTypeForMode(cameraMode),
      });
      return { cellSize: resolved ?? 0.5, cells: stats.cells, hits: stats.hits };
    },
  );

  r.get(
    "/api/v1/heatmaps/camera",
    { schema: { querystring: cameraHeatmapQueryParams } },
    async (req, reply) => {
      const projectId = await authProject(req, reply, store);
      if (!projectId) return reply;
      const { cameraMode, ...rest } = req.query;
      return store.cameraHeatmap(projectId, { ...rest, cameraType: cameraTypeForMode(cameraMode) });
    },
  );

  // Floor-plan camera-position heatmap (ADR 0026) — the first-person analog of
  // the 2D pointer heatmap: where visitors stand/dwell on the X/Z ground plane.
  r.get(
    "/api/v1/heatmaps/position",
    { schema: { querystring: cameraPositionQueryParams } },
    async (req, reply) => {
      const projectId = await authProject(req, reply, store);
      if (!projectId) return reply;
      const { cameraMode, ...rest } = req.query;
      return store.cameraPositionHeatmap(projectId, {
        ...rest,
        cameraType: cameraTypeForMode(cameraMode),
      });
    },
  );

  // One session's ordered walked path (ADR 0026) — camera positions, oldest first.
  r.get(
    "/api/v1/sessions/:sessionId/trajectory",
    { schema: { params: sessionPathParams, querystring: trajectoryQueryParams } },
    async (req, reply) => {
      const projectId = await authProject(req, reply, store);
      if (!projectId) return reply;
      return store.sessionTrajectory(projectId, req.params.sessionId, req.query);
    },
  );

  // Aggregate desire lines (#73, ADR 0037) — every session's camera path binned
  // onto the ground grid and returned as ordered, session-keyed points; the
  // dashboard overlays many low-opacity poly-lines into a crowd-level route map.
  r.get(
    "/api/v1/paths",
    { schema: { querystring: aggregatePathQueryParams } },
    async (req, reply) => {
      const projectId = await authProject(req, reply, store);
      if (!projectId) return reply;
      const { cameraMode, ...rest } = req.query;
      return store.aggregateTrajectories(projectId, {
        ...rest,
        cameraType: cameraTypeForMode(cameraMode),
      });
    },
  );

  // View-gated click rays (design §7.2/§7.3) — camera-origin → hit rays per voxel/mesh.
  r.get(
    "/api/v1/heatmaps/click-rays",
    { schema: { querystring: clickRayQueryParams } },
    async (req, reply) => {
      const projectId = await authProject(req, reply, store);
      if (!projectId) return reply;
      return store.clickGazeRays(projectId, req.query);
    },
  );

  // Aggregate gaze→mesh flow links (design §7.5): direction bins → clicked meshes.
  // Position-aware mode (§7.8): a standpoint voxel dimension for walkable scenes.
  r.get(
    "/api/v1/heatmaps/flow",
    { schema: { querystring: flowHeatmapQueryParams } },
    async (req, reply) => {
      const projectId = await authProject(req, reply, store);
      if (!projectId) return reply;
      const { cameraMode, groupByOrigin, originVoxel, ...rest } = req.query;
      return store.flowHeatmap(projectId, {
        ...rest,
        cameraType: cameraTypeForMode(cameraMode),
        groupByOrigin: groupByOrigin === "true" || groupByOrigin === "1",
        originVoxel: originVoxel
          ? (originVoxel.split(",").map(Number) as [number, number, number])
          : undefined,
      });
    },
  );

  r.get(
    "/api/v1/meshes/top",
    { schema: { querystring: sessionScopedRangeQuery } },
    async (req, reply) => {
      const projectId = await authProject(req, reply, store);
      if (!projectId) return reply;
      return store.topMeshes(projectId, req.query);
    },
  );

  // Per-mesh source split (#74) — the most-interacted-mesh tally broken out by
  // the input `source` that drove each interaction; the leaderboard reads both
  // rank (sum across sources) and the per-row breakdown from this one query.
  r.get(
    "/api/v1/meshes/sources",
    { schema: { querystring: pointerHeatmapQueryParams } },
    async (req, reply) => {
      const projectId = await authProject(req, reply, store);
      if (!projectId) return reply;
      return store.topMeshesBySource(projectId, req.query);
    },
  );

  // Per-mesh interaction trend (#74) — the most-interacted-mesh tally bucketed
  // into fixed `interval`-second windows so the leaderboard can draw a per-mesh
  // sparkline and a rising/falling delta over the active range.
  r.get(
    "/api/v1/meshes/trend",
    { schema: { querystring: meshTrendQueryParams } },
    async (req, reply) => {
      const projectId = await authProject(req, reply, store);
      if (!projectId) return reply;
      return store.topMeshesTrend(projectId, req.query);
    },
  );

  // Object dwell ranking (#37) — per-mesh attention from `mesh_visibility`
  // summaries (total visible/centered time, peak screen fraction).
  r.get(
    "/api/v1/meshes/dwell",
    { schema: { querystring: heatmapQueryParams } },
    async (req, reply) => {
      const projectId = await authProject(req, reply, store);
      if (!projectId) return reply;
      return store.meshDwell(projectId, req.query);
    },
  );

  // Interaction-kind breakdown (#72, ADR 0023) — per-mesh counts of each
  // interaction kind (hover / pick / click / drag / …) from `mesh_interaction`
  // events; how an audience acts on objects, not just which ones draw attention.
  r.get(
    "/api/v1/meshes/kinds",
    { schema: { querystring: pointerHeatmapQueryParams } },
    async (req, reply) => {
      const projectId = await authProject(req, reply, store);
      if (!projectId) return reply;
      return store.meshInteractionKinds(projectId, req.query);
    },
  );

  // Dead-click rate (#46) — total clicks vs. clicks that hit empty space; a 3D
  // discoverability signal. The consumer derives the rate from the two counts.
  r.get(
    "/api/v1/clicks/dead",
    { schema: { querystring: pointerHeatmapQueryParams } },
    async (req, reply) => {
      const projectId = await authProject(req, reply, store);
      if (!projectId) return reply;
      return store.deadClicks(projectId, req.query);
    },
  );

  // Rage clicks (#47) — rapid repeated clicks on the same mesh within a short
  // window; a frustration signal derived from the click stream.
  r.get(
    "/api/v1/clicks/rage",
    { schema: { querystring: rageClickQueryParams } },
    async (req, reply) => {
      const projectId = await authProject(req, reply, store);
      if (!projectId) return reply;
      return store.rageClicks(projectId, req.query);
    },
  );

  // Hover hesitation (#48) — per-mesh dwell spent hovering an object without
  // clicking it; flags things that look interactive but aren't.
  r.get(
    "/api/v1/hover/dwell",
    { schema: { querystring: pointerHeatmapQueryParams } },
    async (req, reply) => {
      const projectId = await authProject(req, reply, store);
      if (!projectId) return reply;
      return store.hoverDwell(projectId, req.query);
    },
  );

  // Compile stalls (#42) — per-phase shader/pipeline compilation hitches; the
  // felt first-interaction jank that `frame_perf` averages away.
  r.get(
    "/api/v1/perf/compile-stalls",
    { schema: { querystring: heatmapQueryParams } },
    async (req, reply) => {
      const projectId = await authProject(req, reply, store);
      if (!projectId) return reply;
      return store.compileStalls(projectId, req.query);
    },
  );

  r.get(
    "/api/v1/perf",
    { schema: { querystring: sessionScopedRangeQuery } },
    async (req, reply) => {
      const projectId = await authProject(req, reply, store);
      if (!projectId) return reply;
      return store.perfSummary(projectId, req.query);
    },
  );

  // Render-scale truth (#71, ADR 0021) — the FPS headline paired with the
  // resolution the engine actually rendered at, so "good FPS" can be read against
  // the render scale an adaptive renderer bought it with.
  r.get(
    "/api/v1/perf/render-scale",
    { schema: { querystring: sessionScopedRangeQuery } },
    async (req, reply) => {
      const projectId = await authProject(req, reply, store);
      if (!projectId) return reply;
      return store.renderScaleTruth(projectId, req.query);
    },
  );

  // Resource footprint (#44) — GPU / memory cost summary (avg + peak texture/
  // geometry bytes, triangles/vertices, JS heap) the scene asked of the device.
  r.get(
    "/api/v1/perf/resources",
    { schema: { querystring: sessionScopedRangeQuery } },
    async (req, reply) => {
      const projectId = await authProject(req, reply, store);
      if (!projectId) return reply;
      return store.resourceSummary(projectId, req.query);
    },
  );

  // FPS distribution (#81, ADR 0028 §1) — per-session p05/p50/p95 FPS summarized
  // across sessions (median-of-medians); the distribution-honest headline that
  // replaces the volume-chart mean.
  r.get(
    "/api/v1/perf/distribution",
    { schema: { querystring: heatmapQueryParams } },
    async (req, reply) => {
      const projectId = await authProject(req, reply, store);
      if (!projectId) return reply;
      return store.perfDistribution(projectId, req.query);
    },
  );

  // FPS histogram (#81, ADR 0028 §1) — per-session median FPS bucketed into
  // `bucket`-wide bins; one session = one data point.
  r.get(
    "/api/v1/perf/fps-histogram",
    { schema: { querystring: fpsHistogramQueryParams } },
    async (req, reply) => {
      const projectId = await authProject(req, reply, store);
      if (!projectId) return reply;
      return store.fpsHistogram(projectId, req.query);
    },
  );

  // Frame-time percentiles (#81, ADR 0028 §1) — per-session median frame time and
  // worst-window p95 (ms), summarized across sessions.
  r.get(
    "/api/v1/perf/frame-time",
    { schema: { querystring: heatmapQueryParams } },
    async (req, reply) => {
      const projectId = await authProject(req, reply, store);
      if (!projectId) return reply;
      return store.frameTimePercentiles(projectId, req.query);
    },
  );

  // Jank rate (#81, ADR 0028 §1) — per-session long-frames-per-window rate,
  // reported as the median and worst-decile session.
  r.get(
    "/api/v1/perf/jank",
    { schema: { querystring: heatmapQueryParams } },
    async (req, reply) => {
      const projectId = await authProject(req, reply, store);
      if (!projectId) return reply;
      return store.jankRate(projectId, req.query);
    },
  );

  // FPS by device class (#82, ADR 0028 §2; #11, ADR 0041) — per-session median FPS
  // attributed to the `session_start.device` block (backend / mobile / GPU
  // renderer) plus the coarse browser/OS derived from the User-Agent at ingestion.
  r.get(
    "/api/v1/perf/by-device",
    { schema: { querystring: heatmapQueryParams } },
    async (req, reply) => {
      const projectId = await authProject(req, reply, store);
      if (!projectId) return reply;
      return store.perfByDevice(projectId, req.query);
    },
  );

  // FPS by scene (#82, ADR 0028 §1) — per-session median FPS grouped by scene.
  r.get(
    "/api/v1/perf/by-scene",
    { schema: { querystring: heatmapQueryParams } },
    async (req, reply) => {
      const projectId = await authProject(req, reply, store);
      if (!projectId) return reply;
      return store.perfByScene(projectId, req.query);
    },
  );

  // Resource-footprint percentiles (#83, ADR 0028 §1) — per-session p50/p95 of JS
  // heap, texture bytes, and triangle count, summarized across sessions.
  r.get(
    "/api/v1/perf/resource-percentiles",
    { schema: { querystring: heatmapQueryParams } },
    async (req, reply) => {
      const projectId = await authProject(req, reply, store);
      if (!projectId) return reply;
      return store.resourcePercentiles(projectId, req.query);
    },
  );

  // Stability incidents (#83) — context-loss and compile-stall counts over the
  // range; the hard failures `frame_perf` cannot show.
  r.get(
    "/api/v1/perf/stability",
    { schema: { querystring: heatmapQueryParams } },
    async (req, reply) => {
      const projectId = await authProject(req, reply, store);
      if (!projectId) return reply;
      return store.stabilityCounts(projectId, req.query);
    },
  );

  // Opt-in engine diagnostics (#16, ADR 0021 part 2) — `graphics_diagnostic`
  // incident counts crossed by (severity, category, backend) over the range,
  // folding discrete markers and per-session rollups into the same counters.
  // Capture is off by default, so an empty result is the common (clean) case.
  r.get(
    "/api/v1/graphics-diagnostics",
    { schema: { querystring: heatmapQueryParams } },
    async (req, reply) => {
      const projectId = await authProject(req, reply, store);
      if (!projectId) return reply;
      return store.graphicsDiagnosticCounts(projectId, req.query);
    },
  );

  // Capability changes (#49) — per-transition fallback/recovery counts (e.g. how
  // many sessions fell back WebGPU→WebGL2); explains perf / visual-fidelity
  // variance across the user base. App-reported via reportCapabilityChange.
  r.get(
    "/api/v1/capabilities",
    { schema: { querystring: heatmapQueryParams } },
    async (req, reply) => {
      const projectId = await authProject(req, reply, store);
      if (!projectId) return reply;
      return store.capabilityChanges(projectId, req.query);
    },
  );

  // Camera gestures (ADR 0025) — per-kind navigation breakdown (orbit / pan /
  // dolly / zoom / roll / fly) separating deliberate viewpoint movement from
  // object selection; reveals how an audience explores the scene.
  r.get(
    "/api/v1/camera-gestures",
    { schema: { querystring: pointerHeatmapQueryParams } },
    async (req, reply) => {
      const projectId = await authProject(req, reply, store);
      if (!projectId) return reply;
      return store.cameraGestures(projectId, req.query);
    },
  );

  // Scene coverage / dead zones (derived, scene-metrics §B) — occupied
  // camera-position voxels; coverage % is layered in against the scene AABB.
  r.get(
    "/api/v1/coverage",
    { schema: { querystring: coverageQueryParams } },
    async (req, reply) => {
      const projectId = await authProject(req, reply, store);
      if (!projectId) return reply;
      return store.sceneCoverage(projectId, req.query);
    },
  );

  // Camera distance / zoom distribution (derived, scene-metrics §B) — histogram of
  // camera-to-center distance. The center defaults to the origin when omitted.
  r.get(
    "/api/v1/camera/distance",
    { schema: { querystring: cameraDistanceQueryParams } },
    async (req, reply) => {
      const projectId = await authProject(req, reply, store);
      if (!projectId) return reply;
      const { centerX, centerY, centerZ, ...rest } = req.query;
      const center =
        centerX != null || centerY != null || centerZ != null
          ? ([centerX ?? 0, centerY ?? 0, centerZ ?? 0] as const)
          : undefined;
      return store.cameraDistance(projectId, { ...rest, center });
    },
  );

  // Navigation effort / friction (derived, scene-metrics §B) — per-session travel
  // distance with active-vs-idle segmentation.
  r.get(
    "/api/v1/navigation",
    { schema: { querystring: navigationQueryParams } },
    async (req, reply) => {
      const projectId = await authProject(req, reply, store);
      if (!projectId) return reply;
      return store.navigationStats(projectId, req.query);
    },
  );

  // XR motion-sickness proxy (#50, scene-metrics §F) — per-session head/view
  // rotation rate over the camera pose stream; rapid rotation flags discomfort.
  r.get(
    "/api/v1/xr/rotation",
    { schema: { querystring: xrRotationQueryParams } },
    async (req, reply) => {
      const projectId = await authProject(req, reply, store);
      if (!projectId) return reply;
      return store.xrRotationRate(projectId, req.query);
    },
  );

  // XR input-source usage (#50, scene-metrics §F) — hand vs. controller (vs.
  // gaze) split read from `source` on the interaction events.
  r.get(
    "/api/v1/xr/sources",
    { schema: { querystring: heatmapQueryParams } },
    async (req, reply) => {
      const projectId = await authProject(req, reply, store);
      if (!projectId) return reply;
      return store.xrSourceUsage(projectId, req.query);
    },
  );

  // XR session abandonment (#50, scene-metrics §F) — per XR session, its time
  // bounds and event/interaction counts; a short span signals headset drop-off.
  r.get(
    "/api/v1/xr/abandonment",
    { schema: { querystring: heatmapQueryParams } },
    async (req, reply) => {
      const projectId = await authProject(req, reply, store);
      if (!projectId) return reply;
      return store.xrAbandonment(projectId, req.query);
    },
  );

  // Input-source breakdown (ADR 0011) — per (event_type, source), how many
  // interactions came from each input source (mouse / touch / xr-controller /
  // hand / …) and across how many sessions. Turns `source` into an insight.
  r.get(
    "/api/v1/interactions/sources",
    { schema: { querystring: pointerHeatmapQueryParams } },
    async (req, reply) => {
      const projectId = await authProject(req, reply, store);
      if (!projectId) return reply;
      return store.interactionsBySource(projectId, req.query);
    },
  );

  // Most-used shortcuts / actions (#75, ADR 0023) — rank `input_action` events by
  // their app-level `action` label, split by `source` (keyboard / gamepad / …).
  // Pairs with the input-source breakdown for the input-modality panel.
  r.get(
    "/api/v1/input-actions/top",
    { schema: { querystring: pointerHeatmapQueryParams } },
    async (req, reply) => {
      const projectId = await authProject(req, reply, store);
      if (!projectId) return reply;
      return store.topInputActions(projectId, req.query);
    },
  );

  // Distinct scenes for the project (ADR 0010) — powers the scene selector.
  r.get("/api/v1/scenes", { schema: { querystring: scenesQueryParams } }, async (req, reply) => {
    const projectId = await authProject(req, reply, store);
    if (!projectId) return reply;
    return store.scenes(projectId, req.query);
  });

  // Event-volume time-series (the 4th dimension) — bucketed event counts + FPS.
  r.get(
    "/api/v1/timeseries",
    { schema: { querystring: timeseriesQueryParams } },
    async (req, reply) => {
      const projectId = await authProject(req, reply, store);
      if (!projectId) return reply;
      return store.timeseries(projectId, req.query);
    },
  );

  // Per-event-type counts over the range — powers the scene health panel.
  r.get(
    "/api/v1/event-counts",
    { schema: { querystring: eventCountsQueryParams } },
    async (req, reply) => {
      const projectId = await authProject(req, reply, store);
      if (!projectId) return reply;
      return store.eventTypeCounts(projectId, req.query);
    },
  );

  // Single-project configurator funnel (#78, ADR 0038) — ordered, per-session
  // step-reach with the drop-off between steps. `steps` is a JSON-encoded array
  // of step predicates, validated against the shared `funnelStepsSchema`; the
  // OSS dashboard is a passive viewer, so steps are supplied by the caller
  // (CLI / hosted), never authored or persisted here.
  r.get("/api/v1/funnel", { schema: { querystring: funnelQueryParams } }, async (req, reply) => {
    const projectId = await authProject(req, reply, store);
    if (!projectId) return reply;
    let parsed: unknown;
    try {
      parsed = JSON.parse(req.query.steps);
    } catch {
      return reply.code(400).send({ error: "steps must be a JSON array" });
    }
    const result = funnelStepsSchema.safeParse(parsed);
    if (!result.success) {
      return reply.code(400).send({ error: "invalid funnel steps", details: result.error.issues });
    }
    const { since, until, scene, cameraMode } = req.query;
    return store.funnel(projectId, {
      since,
      until,
      scene,
      cameraType: cameraTypeForMode(cameraMode),
      steps: result.data,
    });
  });

  // Ordered session timeline for replay — gated by raw-session retention (ADR 0003).
  // Negotiates NDJSON (`Accept: application/x-ndjson` or `?format=ndjson`): when
  // requested, events stream one-per-line from ClickHouse with bounded server
  // memory (ADR 0015); otherwise the buffered JSON array stays the default.
  r.get(
    "/api/v1/sessions/:id/events",
    {
      schema: {
        params: z.object({ id: z.string().min(1) }),
        querystring: z.object({ format: z.enum(["json", "ndjson"]).optional() }),
      },
    },
    async (req, reply) => {
      const projectId = await authProject(req, reply, store);
      if (!projectId) return reply;
      if (!config.enableRawSessionRetention) {
        return reply.code(403).send({ error: "raw session retention is disabled" });
      }
      const accept = req.headers.accept ?? "";
      const wantsNdjson = req.query.format === "ndjson" || accept.includes("application/x-ndjson");
      if (!wantsNdjson) {
        return store.getSessionEvents(projectId, req.params.id);
      }
      // Stream NDJSON: serialize each event as its own line. Returning a Readable
      // lets Fastify pipe it directly, bypassing whole-body serialization.
      const lines = (async function* () {
        for await (const event of store.streamSessionEvents(projectId, req.params.id)) {
          yield `${JSON.stringify(event)}\n`;
        }
      })();
      reply.header("content-type", "application/x-ndjson; charset=utf-8");
      return reply.send(Readable.from(lines, { objectMode: false }));
    },
  );

  // Coarse session descriptor (device/scene/anonymized user). Not raw data, so it
  // is not gated by raw-session retention.
  r.get(
    "/api/v1/sessions/:id/meta",
    { schema: { params: z.object({ id: z.string().min(1) }) } },
    async (req, reply) => {
      const projectId = await authProject(req, reply, store);
      if (!projectId) return reply;
      const meta = await store.getSessionMeta(projectId, req.params.id);
      if (!meta) return reply.code(404).send({ error: "session not found" });
      return meta;
    },
  );

  // --- Spatial scene registry (ADR 0010 / 0014) ----------------------------

  // List the project's registered scene representations (summaries, no proxy blob).
  r.get("/api/v1/scene-representations", async (req, reply) => {
    const projectId = await authProject(req, reply, store);
    if (!projectId) return reply;
    return store.listSceneRepresentations(projectId);
  });

  // Register/replace a scene's proxy geometry. The path scene id must match the
  // proxy's own `sceneId` (the proxy is the source of truth for the geometry).
  r.put(
    "/api/v1/scenes/:sceneId/representation",
    { schema: { params: sceneParams, body: putRepresentationBody } },
    async (req, reply) => {
      const projectId = await authProject(req, reply, store);
      if (!projectId) return reply;
      if (req.body.proxy.sceneId !== req.params.sceneId) {
        return reply.code(400).send({ error: "proxy sceneId does not match path" });
      }
      return store.putSceneProxy(projectId, req.body.proxy, req.body.label);
    },
  );

  // Fetch one scene's representation (including the proxy blob), or 404.
  r.get(
    "/api/v1/scenes/:sceneId/representation",
    { schema: { params: sceneParams } },
    async (req, reply) => {
      const projectId = await authProject(req, reply, store);
      if (!projectId) return reply;
      const representation = await store.getSceneRepresentation(projectId, req.params.sceneId);
      if (!representation) return reply.code(404).send({ error: "scene representation not found" });
      return representation;
    },
  );
};
