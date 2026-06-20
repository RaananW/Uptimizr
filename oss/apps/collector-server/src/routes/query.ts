import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import { Readable } from "node:stream";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { sceneProxySchema } from "@uptimizr/schema";
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

/** World heatmap params: a positive voxel `cellSize` (world units) instead of bins. */
const worldHeatmapQueryParams = z.object({
  since: z.coerce.number().int().optional(),
  until: z.coerce.number().int().optional(),
  cellSize: z.coerce.number().positive().max(1000).optional(),
  limit: z.coerce.number().int().positive().max(1000).optional(),
  scene: sceneFilter,
  source: sourceFilter,
  cameraMode: cameraModeFilter,
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
      const { cameraMode, ...rest } = req.query;
      return store.worldHeatmap(projectId, { ...rest, cameraType: cameraTypeForMode(cameraMode) });
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
      const { cameraMode, ...rest } = req.query;
      return store.gazeHeatmap(projectId, { ...rest, cameraType: cameraTypeForMode(cameraMode) });
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

  // FPS by device class (#82, ADR 0028 §2) — per-session median FPS attributed to
  // the `session_start.device` block (backend / mobile / GPU renderer).
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
