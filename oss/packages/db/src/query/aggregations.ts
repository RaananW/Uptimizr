/**
 * Dialect-agnostic analytics aggregations (ADR 0020).
 *
 * Each builder describes an aggregation once and renders it through a
 * {@link Dialect}, returning a {@link QuerySpec}. ClickHouse-specific syntax is
 * confined to the dialect; the query *logic* lives here and is shared by every
 * engine (DuckDB for OSS, single-tenant ClickHouse for the scale tier).
 *
 * Invariant: no multi-tenant concepts here. Filtering is by `project_id` and the
 * optional scene/source/session dimensions only.
 */

import {
  ParamBag,
  cameraModeClause,
  dayRangeClause,
  rangeClause,
  regionClause,
  sceneClause,
  sessionClause,
  sourceClause,
  type Dialect,
} from "./dialect.js";
import type {
  QuerySpec,
  CameraModeOptions,
  FunnelOptions,
  FunnelStepInput,
  RangeOptions,
  RegionOptions,
  SceneOptions,
  SessionOptions,
  SourceOptions,
  TimeseriesOptions,
  WorldAabb,
} from "./types.js";

/** World/gaze voxel coordinates derive from the raycast `hit_point` vector. */
const HIT_POINT_COLS = { x: "hit_point[1]", y: "hit_point[2]", z: "hit_point[3]" } as const;
/** Floor-plan cells derive from the camera `position` vector (Y is height). */
const POSITION_COLS = { x: "position[1]", y: "position[2]", z: "position[3]" } as const;

/**
 * Bounds-driven default voxel size (ADR 0040 §1). Picks a `cellSize` so the
 * longest axis of `bounds` spans roughly `targetCells` cells, keeping spatial
 * resolution proportional to scene extent instead of a fixed world-unit default
 * that dissolves large scenes into a few coarse blocks. Returns `null` for a
 * missing or degenerate (zero/negative longest-axis) box so the caller can fall
 * back to its fixed default.
 */
export function defaultCellSizeForBounds(
  bounds: WorldAabb | null | undefined,
  targetCells = 64,
): number | null {
  if (bounds == null) return null;
  const [minX, minY, minZ, maxX, maxY, maxZ] = bounds;
  const longest = Math.max(maxX - minX, maxY - minY, maxZ - minZ);
  if (!Number.isFinite(longest) || longest <= 0 || targetCells <= 0) return null;
  return longest / targetCells;
}

/** List sessions for a project with event counts and time bounds. */
export function buildListSessions(
  projectId: string,
  opts: RangeOptions & CameraModeOptions & { limit?: number },
  d: Dialect,
): QuerySpec {
  const bag = new ParamBag(d);
  const pid = bag.add("projectId", "string", projectId);
  const range = rangeClause(bag, opts);
  const cameraMode = cameraModeClause(bag, d, projectId, opts);
  const limit = bag.add("limit", "u32", opts.limit ?? 100);
  return {
    query: `
      SELECT
        session_id,
        ${d.anyValue("visitor_id")} AS visitor_id,
        count() AS events,
        min(ts) AS started_at,
        max(ts) AS ended_at
      FROM events
      WHERE project_id = ${pid}${range}${cameraMode}
      GROUP BY session_id
      ORDER BY started_at DESC
      LIMIT ${limit}
    `,
    query_params: bag.values,
  };
}

/**
 * 2D pointer heatmap: bin normalized screen positions into a `bins x bins` grid.
 * Covers `pointer_move` and `pointer_click`.
 */
export function buildPointerHeatmap(
  projectId: string,
  opts: RangeOptions &
    SceneOptions &
    SourceOptions &
    SessionOptions &
    CameraModeOptions & { bins?: number },
  d: Dialect,
): QuerySpec {
  const bag = new ParamBag(d);
  const pid = bag.add("projectId", "string", projectId);
  const bins = bag.add("bins", "u32", opts.bins ?? 50);
  const range = rangeClause(bag, opts);
  const scene = sceneClause(bag, opts);
  const source = sourceClause(bag, opts);
  const session = sessionClause(bag, opts);
  const cameraMode = cameraModeClause(bag, d, projectId, opts);
  return {
    query: `
      SELECT
        floor(screen[1] * ${bins}) AS gx,
        floor(screen[2] * ${bins}) AS gy,
        count() AS count
      FROM events
      WHERE project_id = ${pid}
        AND event_type IN ('pointer_move', 'pointer_click')
        AND length(screen) = 2${range}${scene}${source}${session}${cameraMode}
      GROUP BY gx, gy
      ORDER BY count DESC
    `,
    query_params: bag.values,
  };
}

/**
 * World-space (3D) pointer heatmap: voxel-bin the raycast hit points of pointer
 * events into a uniform grid of `cellSize`-sized cubes. Results are capped to the
 * busiest `limit` voxels.
 */
export function buildWorldHeatmap(
  projectId: string,
  opts: RangeOptions &
    SceneOptions &
    SourceOptions &
    RegionOptions &
    CameraModeOptions & { cellSize?: number; limit?: number },
  d: Dialect,
): QuerySpec {
  const bag = new ParamBag(d);
  const pid = bag.add("projectId", "string", projectId);
  const cellSize = bag.add("cellSize", "f64", opts.cellSize ?? 0.5);
  const range = rangeClause(bag, opts);
  const scene = sceneClause(bag, opts);
  const source = sourceClause(bag, opts);
  const cameraMode = cameraModeClause(bag, d, projectId, opts);
  const region = regionClause(bag, opts, HIT_POINT_COLS);
  const limit = bag.add("limit", "u32", opts.limit ?? 1000);
  return {
    query: `
      SELECT
        floor(hit_point[1] / ${cellSize}) AS vx,
        floor(hit_point[2] / ${cellSize}) AS vy,
        floor(hit_point[3] / ${cellSize}) AS vz,
        count() AS count
      FROM events
      WHERE project_id = ${pid}
        AND event_type IN ('pointer_move', 'pointer_click')
        AND length(hit_point) = 3${range}${scene}${source}${cameraMode}${region}
      GROUP BY vx, vy, vz
      ORDER BY count DESC
      LIMIT ${limit}
    `,
    query_params: bag.values,
  };
}

/**
 * Scene-wide totals for the world (pointer) heatmap (ADR 0040 §3): the true count
 * of occupied voxels and total hits, computed with no `LIMIT` so the viewer can
 * report "showing top N of M cells" and reason about cold spots/coverage. Shares
 * every filter (including {@link RegionOptions.region}) with {@link buildWorldHeatmap}.
 * Uses a grouped sub-select so the dialect needs no `COUNT(DISTINCT tuple)`.
 */
export function buildWorldHeatmapStats(
  projectId: string,
  opts: RangeOptions &
    SceneOptions &
    SourceOptions &
    RegionOptions &
    CameraModeOptions & { cellSize?: number },
  d: Dialect,
): QuerySpec {
  const bag = new ParamBag(d);
  const pid = bag.add("projectId", "string", projectId);
  const cellSize = bag.add("cellSize", "f64", opts.cellSize ?? 0.5);
  const range = rangeClause(bag, opts);
  const scene = sceneClause(bag, opts);
  const source = sourceClause(bag, opts);
  const cameraMode = cameraModeClause(bag, d, projectId, opts);
  const region = regionClause(bag, opts, HIT_POINT_COLS);
  return {
    query: `
      SELECT count() AS cells, coalesce(sum(c), 0) AS hits
      FROM (
        SELECT
          floor(hit_point[1] / ${cellSize}) AS vx,
          floor(hit_point[2] / ${cellSize}) AS vy,
          floor(hit_point[3] / ${cellSize}) AS vz,
          count() AS c
        FROM events
        WHERE project_id = ${pid}
          AND event_type IN ('pointer_move', 'pointer_click')
          AND length(hit_point) = 3${range}${scene}${source}${cameraMode}${region}
        GROUP BY vx, vy, vz
      ) t
    `,
    query_params: bag.values,
  };
}

/**
 * World-space (3D) gaze heatmap (ADR 0030): voxel-bin the camera-pose gaze
 * surface hits (`camera_sample.hitPoint`) into the same uniform grid as the
 * pointer world heatmap. This is the "what did people actually look at" map — it
 * lands on real geometry and serves orbit/viewer, first-person, and XR scenes
 * alike. Distinct from the click-driven world heatmap (looked-at vs clicked) and
 * from the abstract direction sphere (surface vs angle). Results are capped to
 * the busiest `limit` voxels; an optional `session` scopes it to one visit
 * (ADR 0010 §1a). Gaze has no pointer input-source, so there is no `source` filter.
 */
export function buildGazeHeatmap(
  projectId: string,
  opts: RangeOptions &
    SceneOptions &
    SessionOptions &
    RegionOptions &
    CameraModeOptions & { cellSize?: number; limit?: number },
  d: Dialect,
): QuerySpec {
  const bag = new ParamBag(d);
  const pid = bag.add("projectId", "string", projectId);
  const cellSize = bag.add("cellSize", "f64", opts.cellSize ?? 0.5);
  const range = rangeClause(bag, opts);
  const scene = sceneClause(bag, opts);
  const session = sessionClause(bag, opts);
  const cameraMode = cameraModeClause(bag, d, projectId, opts);
  const region = regionClause(bag, opts, HIT_POINT_COLS);
  const limit = bag.add("limit", "u32", opts.limit ?? 1000);
  return {
    query: `
      SELECT
        floor(hit_point[1] / ${cellSize}) AS vx,
        floor(hit_point[2] / ${cellSize}) AS vy,
        floor(hit_point[3] / ${cellSize}) AS vz,
        count() AS count
      FROM events
      WHERE project_id = ${pid}
        AND event_type = 'camera_sample'
        AND length(hit_point) = 3${range}${scene}${session}${cameraMode}${region}
      GROUP BY vx, vy, vz
      ORDER BY count DESC
      LIMIT ${limit}
    `,
    query_params: bag.values,
  };
}

/**
 * Scene-wide totals for the gaze heatmap (ADR 0040 §3): the true occupied-voxel
 * and hit counts behind the truncated top-N gaze voxels, with no `LIMIT`. Shares
 * every filter (including {@link RegionOptions.region}) with {@link buildGazeHeatmap}.
 */
export function buildGazeHeatmapStats(
  projectId: string,
  opts: RangeOptions &
    SceneOptions &
    SessionOptions &
    RegionOptions &
    CameraModeOptions & { cellSize?: number },
  d: Dialect,
): QuerySpec {
  const bag = new ParamBag(d);
  const pid = bag.add("projectId", "string", projectId);
  const cellSize = bag.add("cellSize", "f64", opts.cellSize ?? 0.5);
  const range = rangeClause(bag, opts);
  const scene = sceneClause(bag, opts);
  const session = sessionClause(bag, opts);
  const cameraMode = cameraModeClause(bag, d, projectId, opts);
  const region = regionClause(bag, opts, HIT_POINT_COLS);
  return {
    query: `
      SELECT count() AS cells, coalesce(sum(c), 0) AS hits
      FROM (
        SELECT
          floor(hit_point[1] / ${cellSize}) AS vx,
          floor(hit_point[2] / ${cellSize}) AS vy,
          floor(hit_point[3] / ${cellSize}) AS vz,
          count() AS c
        FROM events
        WHERE project_id = ${pid}
          AND event_type = 'camera_sample'
          AND length(hit_point) = 3${range}${scene}${session}${cameraMode}${region}
        GROUP BY vx, vy, vz
      ) t
    `,
    query_params: bag.values,
  };
}

/**
 * View-direction heatmap: bin camera forward vectors by spherical angles.
 * `azimuth = atan2(z, x)`, `elevation = asin(y / |v|)`, each bucketed into `bins`.
 */
export function buildCameraDirectionHeatmap(
  projectId: string,
  opts: RangeOptions & SceneOptions & SessionOptions & CameraModeOptions & { bins?: number },
  d: Dialect,
): QuerySpec {
  const bag = new ParamBag(d);
  const pid = bag.add("projectId", "string", projectId);
  const bins = bag.add("bins", "u32", opts.bins ?? 36);
  const range = rangeClause(bag, opts);
  const scene = sceneClause(bag, opts);
  const session = sessionClause(bag, opts);
  const cameraMode = cameraModeClause(bag, d, projectId, opts);
  return {
    query: `
      SELECT
        floor((atan2(direction[3], direction[1]) + pi()) / (2 * pi()) * ${bins}) AS azimuth_bin,
        floor((asin(direction[2] / greatest(${d.vectorNorm("direction")}, 1e-6)) + pi() / 2) / pi() * ${bins}) AS elevation_bin,
        count() AS count
      FROM events
      WHERE project_id = ${pid}
        AND event_type = 'camera_sample'
        AND length(direction) = 3${range}${scene}${session}${cameraMode}
      GROUP BY azimuth_bin, elevation_bin
      ORDER BY count DESC
    `,
    query_params: bag.values,
  };
}

/**
 * Top-down "floor plan" camera-position heatmap (ADR 0026): bin `camera_sample`
 * world positions onto the X/Z ground plane in `cellSize`-sized cells, tracking the
 * mean height per cell. For first-person (`cameraType: "free"`) sessions this is
 * the "where do visitors walk / dwell" map; capped to the busiest `limit` cells.
 */
export function buildCameraPositionHeatmap(
  projectId: string,
  opts: RangeOptions &
    SceneOptions &
    SessionOptions &
    RegionOptions &
    CameraModeOptions & { cellSize?: number; limit?: number },
  d: Dialect,
): QuerySpec {
  const bag = new ParamBag(d);
  const pid = bag.add("projectId", "string", projectId);
  const cellSize = bag.add("cellSize", "f64", opts.cellSize ?? 1);
  const range = rangeClause(bag, opts);
  const scene = sceneClause(bag, opts);
  const session = sessionClause(bag, opts);
  const cameraMode = cameraModeClause(bag, d, projectId, opts);
  const region = regionClause(bag, opts, POSITION_COLS);
  const limit = bag.add("limit", "u32", opts.limit ?? 2000);
  return {
    query: `
      SELECT
        floor(position[1] / ${cellSize}) AS gx,
        floor(position[3] / ${cellSize}) AS gz,
        avg(position[2]) AS avg_y,
        count() AS count
      FROM events
      WHERE project_id = ${pid}
        AND event_type = 'camera_sample'
        AND length(position) = 3${range}${scene}${session}${cameraMode}${region}
      GROUP BY gx, gz
      ORDER BY count DESC
      LIMIT ${limit}
    `,
    query_params: bag.values,
  };
}

/**
 * A single session's walked path (ADR 0026): the ordered `camera_sample` world
 * positions for one session, oldest first. Drives the dashboard's trajectory view
 * (a poly-line over the floor plan). Capped to `limit` points.
 */
export function buildSessionTrajectory(
  projectId: string,
  opts: RangeOptions & SceneOptions & { session: string; limit?: number },
  d: Dialect,
): QuerySpec {
  const bag = new ParamBag(d);
  const pid = bag.add("projectId", "string", projectId);
  const session = bag.add("session", "string", opts.session);
  const range = rangeClause(bag, opts);
  const scene = sceneClause(bag, opts);
  const limit = bag.add("limit", "u32", opts.limit ?? 5000);
  return {
    query: `
      SELECT
        ${d.epochMs("ts")} AS ts,
        position[1] AS x,
        position[2] AS y,
        position[3] AS z
      FROM events
      WHERE project_id = ${pid}
        AND session_id = ${session}
        AND event_type = 'camera_sample'
        AND length(position) = 3${range}${scene}
      ORDER BY ts ASC
      LIMIT ${limit}
    `,
    query_params: bag.values,
  };
}

/**
 * Aggregate desire lines (#73): the *crowd* analog of a single session's
 * trajectory. Every session's `camera_sample` path is binned onto the X/Z ground
 * grid (`cellSize` world units) and returned as ordered points keyed by
 * `session_id`, oldest first. Overlaying many low-opacity poly-lines lets the
 * common routes self-reinforce into "desire lines" — the paths visitors actually
 * walk, vs. the ones the level designer intended (ADR 0037).
 *
 * Binning in SQL caps cardinality and removes sub-cell jitter; the consumer
 * dedupes consecutive identical cells and draws one poly-line per session. The
 * row cap (`limit`) is a volume guard for busy projects.
 */
export function buildAggregateTrajectories(
  projectId: string,
  opts: RangeOptions & SceneOptions & CameraModeOptions & { cellSize?: number; limit?: number },
  d: Dialect,
): QuerySpec {
  const bag = new ParamBag(d);
  const pid = bag.add("projectId", "string", projectId);
  const range = rangeClause(bag, opts);
  const scene = sceneClause(bag, opts);
  const cameraMode = cameraModeClause(bag, d, projectId, opts);
  const cellSize = bag.add("cellSize", "f64", opts.cellSize ?? 1);
  const limit = bag.add("limit", "u32", opts.limit ?? 20000);
  return {
    query: `
      SELECT
        session_id,
        ${d.epochMs("ts")} AS ts,
        floor(position[1] / ${cellSize}) AS gx,
        floor(position[3] / ${cellSize}) AS gz
      FROM events
      WHERE project_id = ${pid}
        AND event_type = 'camera_sample'
        AND length(position) = 3${range}${scene}${cameraMode}
      ORDER BY session_id ASC, ts ASC
      LIMIT ${limit}
    `,
    query_params: bag.values,
  };
}

/**
 * Click ↔ gaze correlation: aggregate each `pointer_click` into a ray from an
 * origin voxel to a hit voxel, where the voxel size matches the world heatmap so
 * origins and hits share the same grid.
 *
 * Origin selection (ADR 0011 — source-agnostic): pose-enabled sources (XR
 * controllers, hands, gaze) carry their own world-space pointing ray, so when a
 * click has a `ray.origin` we use it verbatim — the controller/hand/gaze is the
 * true pointing origin, not the headset/camera. Flat pointers (mouse, touch,
 * stylus) have no native ray, so they fall back to the nearest preceding
 * `camera_sample` in the same session (the historical view-gated behavior). The
 * camera join is therefore a LEFT join so pose clicks survive even in sessions
 * that never emit a `camera_sample`; rows with neither a ray nor a camera origin
 * are dropped.
 */
export function buildClickGazeRay(
  projectId: string,
  opts: RangeOptions &
    SceneOptions &
    SourceOptions &
    SessionOptions & {
      cellSize?: number;
      limit?: number;
    },
  d: Dialect,
): QuerySpec {
  const bag = new ParamBag(d);
  const pid = bag.add("projectId", "string", projectId);
  const cellSize = bag.add("cellSize", "f64", opts.cellSize ?? 0.5);
  const range = rangeClause(bag, opts);
  const scene = sceneClause(bag, opts);
  const source = sourceClause(bag, opts);
  const session = sessionClause(bag, opts);
  return {
    query: `
      SELECT
        floor(j.ox / ${cellSize}) AS cam_vx,
        floor(j.oy / ${cellSize}) AS cam_vy,
        floor(j.oz / ${cellSize}) AS cam_vz,
        avg(j.ox) AS origin_x,
        avg(j.oy) AS origin_y,
        avg(j.oz) AS origin_z,
        floor(j.hx / ${cellSize}) AS hit_vx,
        floor(j.hy / ${cellSize}) AS hit_vy,
        floor(j.hz / ${cellSize}) AS hit_vz,
        avg(j.hx) AS hit_x,
        avg(j.hy) AS hit_y,
        avg(j.hz) AS hit_z,
        j.mesh AS mesh,
        count() AS count
      FROM (
        SELECT
          c.hx AS hx, c.hy AS hy, c.hz AS hz, c.mesh AS mesh,
          CASE WHEN c.has_ray THEN c.rox WHEN m.cam_present = 1 THEN m.px END AS ox,
          CASE WHEN c.has_ray THEN c.roy WHEN m.cam_present = 1 THEN m.py END AS oy,
          CASE WHEN c.has_ray THEN c.roz WHEN m.cam_present = 1 THEN m.pz END AS oz
        FROM (
          SELECT session_id, ts,
            hit_point[1] AS hx, hit_point[2] AS hy, hit_point[3] AS hz, mesh,
            length(ray_origin) = 3 AS has_ray,
            ray_origin[1] AS rox, ray_origin[2] AS roy, ray_origin[3] AS roz
          FROM events
          WHERE project_id = ${pid}
            AND event_type = 'pointer_click'
            AND length(hit_point) = 3${range}${scene}${source}${session}
        ) AS c
        ${d.asofLeftJoin} (
          SELECT session_id, ts, 1 AS cam_present,
            position[1] AS px, position[2] AS py, position[3] AS pz
          FROM events
          WHERE project_id = ${pid}
            AND event_type = 'camera_sample'
            AND length(position) = 3${range}${scene}${session}
        ) AS m
        ON c.session_id = m.session_id AND c.ts >= m.ts
      ) AS j
      WHERE j.ox IS NOT NULL
      GROUP BY cam_vx, cam_vy, cam_vz, hit_vx, hit_vy, hit_vz, mesh
      ORDER BY count DESC
      LIMIT ${bag.add("limit", "u32", opts.limit ?? 500)}
    `,
    query_params: bag.values,
  };
}

/**
 * Aggregate gaze→mesh flow links: ASOF-join each `pointer_click` to the nearest
 * preceding `camera_sample` in the same session, then group by
 * `(direction-bin, mesh)`. Each row is one weighted link from a direction bin to
 * a clicked mesh.
 *
 * Position-aware mode (design §7.8): when `groupByOrigin` is set or an
 * `originVoxel` filter is given, the click-time camera **position** is restored
 * as a source dimension — rows additionally carry the standpoint voxel
 * (`origin_v*`) and its averaged world point (`origin_*`). The standpoint origin
 * prefers the click's own ray origin for pose sources (ADR 0011), falling back
 * to the joined `camera_sample` position. Omitting both options reproduces the
 * §7.5 direction-only links unchanged.
 */
export function buildFlowHeatmap(
  projectId: string,
  opts: RangeOptions &
    SceneOptions &
    SessionOptions &
    CameraModeOptions & {
      bins?: number;
      limit?: number;
      /** Standpoint voxel edge (world units) for position-aware mode (§7.8). */
      cellSize?: number;
      /** Group links by standpoint voxel in addition to direction + mesh (§7.8). */
      groupByOrigin?: boolean;
      /** Restrict to clicks whose standpoint falls in this voxel (§7.8). */
      originVoxel?: readonly [number, number, number];
    },
  d: Dialect,
): QuerySpec {
  const bag = new ParamBag(d);
  const pid = bag.add("projectId", "string", projectId);
  const bins = bag.add("bins", "u32", opts.bins ?? 24);
  const range = rangeClause(bag, opts);
  const scene = sceneClause(bag, opts);
  const session = sessionClause(bag, opts);
  const cameraMode = cameraModeClause(bag, d, projectId, opts);
  const limit = bag.add("limit", "u32", opts.limit ?? 150);

  // §7.8 is opt-in: only restructure the query when a position dimension is asked
  // for, so the default §7.5 flow renders byte-for-byte as before.
  const positionAware = opts.groupByOrigin === true || opts.originVoxel != null;
  if (!positionAware) {
    return {
      query: `
      SELECT
        floor((atan2(m.dz, m.dx) + pi()) / (2 * pi()) * ${bins}) AS azimuth_bin,
        floor((asin(m.dy / greatest(sqrt(m.dx * m.dx + m.dy * m.dy + m.dz * m.dz), 1e-6)) + pi() / 2) / pi() * ${bins}) AS elevation_bin,
        c.mesh AS mesh,
        count() AS count
      FROM (
        SELECT session_id, ts, mesh
        FROM events
        WHERE project_id = ${pid}
          AND event_type = 'pointer_click'
          AND mesh != ''${range}${scene}${session}${cameraMode}
      ) AS c
      ${d.asofInnerJoin} (
        SELECT session_id, ts, direction[1] AS dx, direction[2] AS dy, direction[3] AS dz
        FROM events
        WHERE project_id = ${pid}
          AND event_type = 'camera_sample'
          AND length(direction) = 3${range}${scene}${session}${cameraMode}
      ) AS m
      ON c.session_id = m.session_id AND c.ts >= m.ts
      GROUP BY azimuth_bin, elevation_bin, mesh
      ORDER BY count DESC
      LIMIT ${limit}
    `,
      query_params: bag.values,
    };
  }

  const cellSize = bag.add("cellSize", "f64", opts.cellSize ?? 0.5);
  let originFilter = "";
  if (opts.originVoxel != null) {
    const ovx = bag.add("originVx", "f64", opts.originVoxel[0]);
    const ovy = bag.add("originVy", "f64", opts.originVoxel[1]);
    const ovz = bag.add("originVz", "f64", opts.originVoxel[2]);
    originFilter = `
      WHERE floor(j.ox / ${cellSize}) = ${ovx}
        AND floor(j.oy / ${cellSize}) = ${ovy}
        AND floor(j.oz / ${cellSize}) = ${ovz}`;
  }
  return {
    query: `
      SELECT
        floor((atan2(j.dz, j.dx) + pi()) / (2 * pi()) * ${bins}) AS azimuth_bin,
        floor((asin(j.dy / greatest(sqrt(j.dx * j.dx + j.dy * j.dy + j.dz * j.dz), 1e-6)) + pi() / 2) / pi() * ${bins}) AS elevation_bin,
        floor(j.ox / ${cellSize}) AS origin_vx,
        floor(j.oy / ${cellSize}) AS origin_vy,
        floor(j.oz / ${cellSize}) AS origin_vz,
        avg(j.ox) AS origin_x,
        avg(j.oy) AS origin_y,
        avg(j.oz) AS origin_z,
        j.mesh AS mesh,
        count() AS count
      FROM (
        SELECT
          c.mesh AS mesh,
          m.dx AS dx, m.dy AS dy, m.dz AS dz,
          CASE WHEN c.has_ray THEN c.rox ELSE m.px END AS ox,
          CASE WHEN c.has_ray THEN c.roy ELSE m.py END AS oy,
          CASE WHEN c.has_ray THEN c.roz ELSE m.pz END AS oz
        FROM (
          SELECT session_id, ts, mesh,
            length(ray_origin) = 3 AS has_ray,
            ray_origin[1] AS rox, ray_origin[2] AS roy, ray_origin[3] AS roz
          FROM events
          WHERE project_id = ${pid}
            AND event_type = 'pointer_click'
            AND mesh != ''${range}${scene}${session}${cameraMode}
        ) AS c
        ${d.asofInnerJoin} (
          SELECT session_id, ts,
            position[1] AS px, position[2] AS py, position[3] AS pz,
            direction[1] AS dx, direction[2] AS dy, direction[3] AS dz
          FROM events
          WHERE project_id = ${pid}
            AND event_type = 'camera_sample'
            AND length(direction) = 3
            AND length(position) = 3${range}${scene}${session}${cameraMode}
        ) AS m
        ON c.session_id = m.session_id AND c.ts >= m.ts
      ) AS j${originFilter}
      GROUP BY azimuth_bin, elevation_bin, origin_vx, origin_vy, origin_vz, mesh
      ORDER BY count DESC
      LIMIT ${limit}
    `,
    query_params: bag.values,
  };
}

/** Most-interacted meshes (from `mesh_interaction` and pointer hits). */
export function buildTopMeshes(
  projectId: string,
  opts: RangeOptions & SessionOptions & { limit?: number },
  d: Dialect,
): QuerySpec {
  const bag = new ParamBag(d);
  const pid = bag.add("projectId", "string", projectId);
  const range = rangeClause(bag, opts);
  const session = sessionClause(bag, opts);
  const limit = bag.add("limit", "u32", opts.limit ?? 25);
  return {
    query: `
      SELECT mesh, count() AS count
      FROM events
      WHERE project_id = ${pid} AND mesh != ''${range}${session}
      GROUP BY mesh
      ORDER BY count DESC
      LIMIT ${limit}
    `,
    query_params: bag.values,
  };
}

/**
 * Per-mesh source split (#74): the most-interacted-mesh tally broken out by the
 * input `source` that drove each interaction (mouse / touch / xr-controller /
 * hand / …). Scoped to **active** interactions — `mesh_interaction` (hover / pick
 * / click / drag) and `pointer_click` — so passive `camera_sample` gaze hits do
 * NOT inflate popularity (this is the deliberate difference from
 * {@link buildTopMeshes}, which counts every mesh-referencing event). Summing a
 * mesh's rows gives its leaderboard total; ranked by count.
 */
export function buildTopMeshesBySource(
  projectId: string,
  opts: RangeOptions & SceneOptions & SourceOptions & SessionOptions & { limit?: number },
  d: Dialect,
): QuerySpec {
  const bag = new ParamBag(d);
  const pid = bag.add("projectId", "string", projectId);
  const range = rangeClause(bag, opts);
  const scene = sceneClause(bag, opts);
  const source = sourceClause(bag, opts);
  const session = sessionClause(bag, opts);
  const limit = bag.add("limit", "u32", opts.limit ?? 200);
  return {
    query: `
      SELECT mesh, source, count() AS count
      FROM events
      WHERE project_id = ${pid}
        AND event_type IN ('mesh_interaction', 'pointer_click')
        AND mesh != ''${range}${scene}${source}${session}
      GROUP BY mesh, source
      ORDER BY count DESC
      LIMIT ${limit}
    `,
    query_params: bag.values,
  };
}

/**
 * Per-mesh interaction trend (#74): the active-interaction tally bucketed into
 * fixed `interval`-second time windows, so the leaderboard can draw a per-mesh
 * sparkline and a rising/falling delta over the active range. Scoped to the same
 * `mesh_interaction` + `pointer_click` events as {@link buildTopMeshesBySource}
 * (passive gaze excluded). Each row is a `(mesh, bucket)` count; the consumer
 * orders buckets per mesh and compares the recent half against the earlier half.
 * Ordered oldest bucket first for drawing.
 */
export function buildTopMeshesTrend(
  projectId: string,
  opts: RangeOptions &
    SceneOptions &
    SourceOptions &
    SessionOptions & { interval?: number; limit?: number },
  d: Dialect,
): QuerySpec {
  const bag = new ParamBag(d);
  const pid = bag.add("projectId", "string", projectId);
  const interval = bag.add("interval", "u32", opts.interval ?? 3600);
  const range = rangeClause(bag, opts);
  const scene = sceneClause(bag, opts);
  const source = sourceClause(bag, opts);
  const session = sessionClause(bag, opts);
  const limit = bag.add("limit", "u32", opts.limit ?? 2000);
  return {
    query: `
      SELECT
        mesh,
        ${d.timeBucketMs("ts", interval)} AS bucket,
        count() AS count
      FROM events
      WHERE project_id = ${pid}
        AND event_type IN ('mesh_interaction', 'pointer_click')
        AND mesh != ''${range}${scene}${source}${session}
      GROUP BY mesh, bucket
      ORDER BY bucket ASC
      LIMIT ${limit}
    `,
    query_params: bag.values,
  };
}

/**
 * Per-object attention / dwell from `mesh_visibility` summaries (#37). Sums the
 * bucketed on-screen and gaze-centred time per mesh and tracks the peak screen
 * fraction, ranked by total dwell. The 3D analog of time-on-element.
 */
export function buildMeshDwell(
  projectId: string,
  opts: RangeOptions & SceneOptions & SessionOptions & { limit?: number },
  d: Dialect,
): QuerySpec {
  const bag = new ParamBag(d);
  const pid = bag.add("projectId", "string", projectId);
  const range = rangeClause(bag, opts);
  const scene = sceneClause(bag, opts);
  const session = sessionClause(bag, opts);
  const limit = bag.add("limit", "u32", opts.limit ?? 25);
  return {
    query: `
      SELECT
        mesh,
        sum(visible_ms) AS visible_ms,
        sum(centered_ms) AS centered_ms,
        max(screen_fraction) AS max_screen_fraction,
        count() AS samples
      FROM events
      WHERE project_id = ${pid} AND event_type = 'mesh_visibility' AND mesh != ''${range}${scene}${session}
      GROUP BY mesh
      ORDER BY sum(visible_ms) DESC
      LIMIT ${limit}
    `,
    query_params: bag.values,
  };
}

/**
 * Interaction-kind breakdown (#72): per-mesh counts of each interaction *kind*
 * (hover / pick / click / drag / select / squeeze / grab / release / teleport)
 * from `mesh_interaction` events (ADR 0023). The dwell ranking says *which*
 * objects draw attention; this says *how* people act on them — separating a mesh
 * that's merely hovered from one that's actually picked or dragged. The kind is
 * carried in the engine-neutral `name` column (events.ts maps
 * `mesh_interaction.kind` → `name`). Ranked by count, capped to `limit`.
 */
export function buildMeshInteractionKinds(
  projectId: string,
  opts: RangeOptions & SceneOptions & SourceOptions & SessionOptions & { limit?: number },
  d: Dialect,
): QuerySpec {
  const bag = new ParamBag(d);
  const pid = bag.add("projectId", "string", projectId);
  const range = rangeClause(bag, opts);
  const scene = sceneClause(bag, opts);
  const source = sourceClause(bag, opts);
  const session = sessionClause(bag, opts);
  const limit = bag.add("limit", "u32", opts.limit ?? 100);
  return {
    query: `
      SELECT
        mesh,
        name AS kind,
        count() AS count
      FROM events
      WHERE project_id = ${pid} AND event_type = 'mesh_interaction' AND mesh != ''${range}${scene}${source}${session}
      GROUP BY mesh, name
      ORDER BY count DESC
      LIMIT ${limit}
    `,
    query_params: bag.values,
  };
}

/**
 * Dead-click rate (#46): of all `pointer_click` events, how many hit nothing
 * (the hit-test missed, so `mesh` is empty / no `hitMesh`). A high dead-click
 * rate is a 3D discoverability problem — users click where they expect something
 * interactive and get no response. Reuses `inputSourceShape` filters (ADR 0011).
 */
export function buildDeadClicks(
  projectId: string,
  opts: RangeOptions & SceneOptions & SourceOptions & SessionOptions,
  d: Dialect,
): QuerySpec {
  const bag = new ParamBag(d);
  const pid = bag.add("projectId", "string", projectId);
  const range = rangeClause(bag, opts);
  const scene = sceneClause(bag, opts);
  const source = sourceClause(bag, opts);
  const session = sessionClause(bag, opts);
  return {
    query: `
      SELECT
        count() AS total_clicks,
        sum(CASE WHEN mesh = '' THEN 1 ELSE 0 END) AS dead_clicks
      FROM events
      WHERE project_id = ${pid} AND event_type = 'pointer_click'${range}${scene}${source}${session}
    `,
    query_params: bag.values,
  };
}

/**
 * Rage clicks (#47): rapid repeated clicks on the same mesh — a frustration
 * signal ("I keep clicking this and nothing happens"). Derived purely from the
 * `pointer_click` stream: clicks are bucketed into fixed `interval`-second
 * windows per `(session, mesh)`, and a bucket with at least `minRepeats` clicks
 * is reported as a rage cluster, ranked by burst size. Only clicks that hit a
 * mesh count here; rapid clicks on empty space are the dead-click signal (#46).
 * Reuses `inputSourceShape` filters (ADR 0011).
 */
export function buildRageClicks(
  projectId: string,
  opts: RangeOptions &
    SceneOptions &
    SourceOptions &
    SessionOptions & { interval?: number; minRepeats?: number; limit?: number },
  d: Dialect,
): QuerySpec {
  const bag = new ParamBag(d);
  const pid = bag.add("projectId", "string", projectId);
  const interval = bag.add("interval", "u32", opts.interval ?? 2);
  const range = rangeClause(bag, opts);
  const scene = sceneClause(bag, opts);
  const source = sourceClause(bag, opts);
  const session = sessionClause(bag, opts);
  const minRepeats = bag.add("minRepeats", "u32", opts.minRepeats ?? 3);
  const limit = bag.add("limit", "u32", opts.limit ?? 100);
  return {
    query: `
      SELECT
        session_id,
        mesh,
        ${d.timeBucketMs("ts", interval)} AS bucket,
        count() AS clicks
      FROM events
      WHERE project_id = ${pid} AND event_type = 'pointer_click' AND mesh != ''${range}${scene}${source}${session}
      GROUP BY session_id, mesh, bucket
      HAVING count() >= ${minRepeats}
      ORDER BY clicks DESC
      LIMIT ${limit}
    `,
    query_params: bag.values,
  };
}

/**
 * Hover hesitation from `hover_dwell` summaries (#48): per mesh, the total time
 * visitors lingered on an object *without clicking it*, the number of hesitation
 * episodes, and the longest single hover. High dwell with few interactions flags
 * objects that look interactive but aren't — or aren't obviously clickable. The
 * connector emits one bucketed episode per hover (its `dwellMs` is stored in the
 * shared `visible_ms` column). Reuses `inputSourceShape` filters (ADR 0011).
 */
export function buildHoverDwell(
  projectId: string,
  opts: RangeOptions & SceneOptions & SourceOptions & SessionOptions & { limit?: number },
  d: Dialect,
): QuerySpec {
  const bag = new ParamBag(d);
  const pid = bag.add("projectId", "string", projectId);
  const range = rangeClause(bag, opts);
  const scene = sceneClause(bag, opts);
  const source = sourceClause(bag, opts);
  const session = sessionClause(bag, opts);
  const limit = bag.add("limit", "u32", opts.limit ?? 25);
  return {
    query: `
      SELECT
        mesh,
        sum(visible_ms) AS dwell_ms,
        max(visible_ms) AS max_dwell_ms,
        count() AS episodes
      FROM events
      WHERE project_id = ${pid} AND event_type = 'hover_dwell' AND mesh != ''${range}${scene}${source}${session}
      GROUP BY mesh
      ORDER BY dwell_ms DESC
      LIMIT ${limit}
    `,
    query_params: bag.values,
  };
}

/**
 * Shader / pipeline compile stalls (#42, design §C): per phase, the number of
 * compile hitches and their total / average / worst main-thread duration.
 * Compilation is the #1 source of first-interaction jank, so this surfaces the
 * felt cost that `frame_perf` averages away. The connector emits one
 * `compile_stall` per compile; its `durationMs` is stored in the shared
 * `visible_ms` column and its coarse `phase` label in the `name` column.
 */
export function buildCompileStalls(
  projectId: string,
  opts: RangeOptions & SceneOptions & SessionOptions & { limit?: number },
  d: Dialect,
): QuerySpec {
  const bag = new ParamBag(d);
  const pid = bag.add("projectId", "string", projectId);
  const range = rangeClause(bag, opts);
  const scene = sceneClause(bag, opts);
  const session = sessionClause(bag, opts);
  const limit = bag.add("limit", "u32", opts.limit ?? 25);
  return {
    query: `
      SELECT
        name AS phase,
        count() AS stalls,
        sum(visible_ms) AS total_ms,
        avg(visible_ms) AS avg_ms,
        max(visible_ms) AS max_ms
      FROM events
      WHERE project_id = ${pid} AND event_type = 'compile_stall'${range}${scene}${session}
      GROUP BY name
      ORDER BY total_ms DESC
      LIMIT ${limit}
    `,
    query_params: bag.values,
  };
}

/**
 * GPU / memory footprint summary from `resource_sample` samples (#44, design §C).
 * Reports the average and peak of each footprint metric over the range — the
 * actual cost the scene asked of the device (vs. `session_start.device` caps).
 * Unreported metrics are stored as `0`; `NULLIF(..., 0)` keeps those out of the
 * averages so a metric one engine omits doesn't dilute another's.
 */
export function buildResourceSummary(
  projectId: string,
  opts: RangeOptions & SessionOptions,
  d: Dialect,
): QuerySpec {
  const bag = new ParamBag(d);
  const pid = bag.add("projectId", "string", projectId);
  const range = rangeClause(bag, opts);
  const session = sessionClause(bag, opts);
  return {
    query: `
      SELECT
        count() AS samples,
        avg(NULLIF(js_heap_bytes, 0)) AS avg_js_heap_bytes,
        max(js_heap_bytes) AS max_js_heap_bytes,
        avg(NULLIF(triangles, 0)) AS avg_triangles,
        max(triangles) AS max_triangles,
        avg(NULLIF(vertices, 0)) AS avg_vertices,
        max(vertices) AS max_vertices,
        avg(NULLIF(texture_bytes, 0)) AS avg_texture_bytes,
        max(texture_bytes) AS max_texture_bytes,
        avg(NULLIF(geometry_bytes, 0)) AS avg_geometry_bytes,
        max(geometry_bytes) AS max_geometry_bytes
      FROM events
      WHERE project_id = ${pid} AND event_type = 'resource_sample'${range}${session}
    `,
    query_params: bag.values,
  };
}

/**
 * GPU/memory footprint **percentiles**, computed per-session then aggregated
 * (ADR 0028 §1), from `resource_sample`. Reports a typical (p50) and a peak
 * (p95) value per session for JS heap, texture bytes, and triangle count, then
 * summarizes each as the median across sessions — so a single heavy session does
 * not set the headline footprint. Unreported metrics (stored `0`) are excluded
 * via `nullIf`. Complements {@link buildResourceSummary}'s pooled avg/max with a
 * distribution-honest view.
 */
export function buildResourcePercentiles(
  projectId: string,
  opts: RangeOptions & SceneOptions & SessionOptions,
  d: Dialect,
): QuerySpec {
  const bag = new ParamBag(d);
  const pid = bag.add("projectId", "string", projectId);
  const range = rangeClause(bag, opts);
  const scene = sceneClause(bag, opts);
  const session = sessionClause(bag, opts);
  return {
    query: `
      SELECT
        count() AS sessions,
        sum(s_samples) AS samples,
        ${d.quantile("s_heap_p50", 0.5)} AS p50_js_heap_bytes,
        ${d.quantile("s_heap_p95", 0.5)} AS p95_js_heap_bytes,
        ${d.quantile("s_tex_p50", 0.5)} AS p50_texture_bytes,
        ${d.quantile("s_tex_p95", 0.5)} AS p95_texture_bytes,
        ${d.quantile("s_tri_p50", 0.5)} AS p50_triangles,
        ${d.quantile("s_tri_p95", 0.5)} AS p95_triangles
      FROM (
        SELECT
          session_id,
          count() AS s_samples,
          ${d.quantile("nullIf(js_heap_bytes, 0)", 0.5)} AS s_heap_p50,
          ${d.quantile("nullIf(js_heap_bytes, 0)", 0.95)} AS s_heap_p95,
          ${d.quantile("nullIf(texture_bytes, 0)", 0.5)} AS s_tex_p50,
          ${d.quantile("nullIf(texture_bytes, 0)", 0.95)} AS s_tex_p95,
          ${d.quantile("nullIf(triangles, 0)", 0.5)} AS s_tri_p50,
          ${d.quantile("nullIf(triangles, 0)", 0.95)} AS s_tri_p95
        FROM events
        WHERE project_id = ${pid} AND event_type = 'resource_sample'${range}${scene}${session}
        GROUP BY session_id
      ) per_session
    `,
    query_params: bag.values,
  };
}

/**
 * Stability-incident counts over the range: WebGL/WebGPU context losses
 * (`context_lost`) and shader/pipeline compile stalls (`compile_stall`), plus the
 * total incident count. These are the hard failures `frame_perf` cannot show — a
 * context loss blanks the canvas, a compile stall freezes first interaction. An
 * empty range reports `0` (not NULL) via `coalesce`.
 */
export function buildStabilityCounts(
  projectId: string,
  opts: RangeOptions & SceneOptions & SessionOptions,
  d: Dialect,
): QuerySpec {
  const bag = new ParamBag(d);
  const pid = bag.add("projectId", "string", projectId);
  const range = rangeClause(bag, opts);
  const scene = sceneClause(bag, opts);
  const session = sessionClause(bag, opts);
  return {
    query: `
      SELECT
        coalesce(sum(CASE WHEN event_type = 'context_lost' THEN 1 ELSE 0 END), 0) AS context_losses,
        coalesce(sum(CASE WHEN event_type = 'compile_stall' THEN 1 ELSE 0 END), 0) AS compile_stalls,
        count() AS incidents
      FROM events
      WHERE project_id = ${pid} AND event_type IN ('context_lost', 'compile_stall')${range}${scene}${session}
    `,
    query_params: bag.values,
  };
}

/**
 * Capability / fidelity transitions from `capability_change` (#49, design §E):
 * per (kind, from, to), how many times the app reported that fallback or
 * recovery. Explains perf / visual-fidelity variance across the user base (e.g.
 * how many sessions fell back WebGPU→WebGL2). `kind` is carried by the shared
 * `name` column; the capability tokens live in `cap_from` / `cap_to`.
 */
export function buildCapabilityChanges(
  projectId: string,
  opts: RangeOptions & SceneOptions & SessionOptions & { limit?: number },
  d: Dialect,
): QuerySpec {
  const bag = new ParamBag(d);
  const pid = bag.add("projectId", "string", projectId);
  const range = rangeClause(bag, opts);
  const scene = sceneClause(bag, opts);
  const session = sessionClause(bag, opts);
  const limit = bag.add("limit", "u32", opts.limit ?? 50);
  return {
    query: `
      SELECT
        name AS kind,
        cap_from AS "from",
        cap_to AS "to",
        count() AS changes
      FROM events
      WHERE project_id = ${pid} AND event_type = 'capability_change'${range}${scene}${session}
      GROUP BY name, cap_from, cap_to
      ORDER BY changes DESC
      LIMIT ${limit}
    `,
    query_params: bag.values,
  };
}

/**
 * Camera-navigation gesture breakdown from `camera_gesture` (ADR 0025): per
 * gesture `kind` (orbit / pan / dolly / zoom / roll / fly / navigate), how often
 * users moved the viewpoint and how long each gesture lasted. This separates
 * deliberate navigation intent from object selection (a click that doesn't move
 * the camera emits no gesture), revealing how an audience explores a scene. The
 * gesture `kind` is carried by the shared `name` column and its `durationMs` by
 * the shared `visible_ms` column.
 */
export function buildCameraGestures(
  projectId: string,
  opts: RangeOptions & SceneOptions & SourceOptions & SessionOptions & { limit?: number },
  d: Dialect,
): QuerySpec {
  const bag = new ParamBag(d);
  const pid = bag.add("projectId", "string", projectId);
  const range = rangeClause(bag, opts);
  const scene = sceneClause(bag, opts);
  const source = sourceClause(bag, opts);
  const session = sessionClause(bag, opts);
  const limit = bag.add("limit", "u32", opts.limit ?? 25);
  return {
    query: `
      SELECT
        name AS kind,
        count() AS gestures,
        sum(visible_ms) AS total_ms,
        avg(visible_ms) AS avg_ms,
        max(visible_ms) AS max_ms
      FROM events
      WHERE project_id = ${pid} AND event_type = 'camera_gesture'${range}${scene}${source}${session}
      GROUP BY name
      ORDER BY gestures DESC
      LIMIT ${limit}
    `,
    query_params: bag.values,
  };
}

/** Aggregate rendering-performance summary from `frame_perf` samples. */
export function buildPerfSummary(
  projectId: string,
  opts: RangeOptions & SessionOptions,
  d: Dialect,
): QuerySpec {
  const bag = new ParamBag(d);
  const pid = bag.add("projectId", "string", projectId);
  const range = rangeClause(bag, opts);
  const session = sessionClause(bag, opts);
  return {
    query: `
      SELECT
        count() AS samples,
        avg(fps) AS avg_fps,
        min(fps) AS min_fps,
        ${d.quantile("fps", 0.5)} AS p50_fps
      FROM events
      WHERE project_id = ${pid} AND event_type = 'frame_perf'${range}${session}
    `,
    query_params: bag.values,
  };
}

/**
 * Render-scale truth (#71): pairs the FPS headline with the **resolution** the
 * engine actually rendered at. A scene can report a healthy frame rate only
 * because an adaptive renderer quietly dropped `render_scale` below 1 — so a
 * "good FPS" number is only honest alongside the render scale that bought it.
 *
 * From `frame_perf` samples (ADR 0021): average + median FPS, average + median
 * `render_scale` (the 0 sentinel for "not reported" is excluded via NULLIF), and
 * the counts needed to derive the *downscaled share* — the fraction of reported
 * samples that rendered below native resolution. The share is derived consumer-
 * side from `downscaled_samples / scale_samples` to keep it integer-exact across
 * engines.
 */
export function buildRenderScaleTruth(
  projectId: string,
  opts: RangeOptions & SessionOptions,
  d: Dialect,
): QuerySpec {
  const bag = new ParamBag(d);
  const pid = bag.add("projectId", "string", projectId);
  const range = rangeClause(bag, opts);
  const session = sessionClause(bag, opts);
  return {
    query: `
      SELECT
        count() AS samples,
        avg(fps) AS avg_fps,
        ${d.quantile("fps", 0.5)} AS p50_fps,
        avg(NULLIF(render_scale, 0)) AS avg_render_scale,
        ${d.quantile("nullIf(render_scale, 0)", 0.5)} AS p50_render_scale,
        sum(CASE WHEN render_scale > 0 AND render_scale < 1 THEN 1 ELSE 0 END) AS downscaled_samples,
        sum(CASE WHEN render_scale > 0 THEN 1 ELSE 0 END) AS scale_samples
      FROM events
      WHERE project_id = ${pid} AND event_type = 'frame_perf'${range}${session}
    `,
    query_params: bag.values,
  };
}

/**
 * FPS distribution, computed **per-session then aggregated** (ADR 0028 §1). Each
 * session contributes its own p05/p50/p95 FPS, so neither long sessions nor
 * high-frame-rate devices dominate the headline; the reported percentiles are
 * the median across sessions of each per-session percentile ("median-of-medians").
 * `sessions` is the number of contributing sessions and `samples` the total
 * `frame_perf` sample count.
 */
export function buildPerfDistribution(
  projectId: string,
  opts: RangeOptions & SceneOptions & SessionOptions,
  d: Dialect,
): QuerySpec {
  const bag = new ParamBag(d);
  const pid = bag.add("projectId", "string", projectId);
  const range = rangeClause(bag, opts);
  const scene = sceneClause(bag, opts);
  const session = sessionClause(bag, opts);
  return {
    query: `
      SELECT
        count() AS sessions,
        sum(s_samples) AS samples,
        ${d.quantile("s_p05", 0.5)} AS p05_fps,
        ${d.quantile("s_p50", 0.5)} AS p50_fps,
        ${d.quantile("s_p95", 0.5)} AS p95_fps
      FROM (
        SELECT
          session_id,
          count() AS s_samples,
          ${d.quantile("fps", 0.05)} AS s_p05,
          ${d.quantile("fps", 0.5)} AS s_p50,
          ${d.quantile("fps", 0.95)} AS s_p95
        FROM events
        WHERE project_id = ${pid} AND event_type = 'frame_perf'${range}${scene}${session}
        GROUP BY session_id
      ) per_session
    `,
    query_params: bag.values,
  };
}

/**
 * Histogram of **per-session median FPS** (ADR 0028 §1). One session contributes
 * a single data point — its median FPS — bucketed into `bucket`-wide FPS bins
 * (default 10). `bucket` is the inclusive lower bound of each bin and `sessions`
 * the number of sessions whose median FPS falls in it. Plotting session medians
 * rather than raw samples keeps the shape honest about how many *experiences*
 * were smooth, instead of letting a few chatty sessions skew the curve.
 */
export function buildFpsHistogram(
  projectId: string,
  opts: RangeOptions & SceneOptions & SessionOptions & { bucket?: number },
  d: Dialect,
): QuerySpec {
  const bag = new ParamBag(d);
  const pid = bag.add("projectId", "string", projectId);
  const range = rangeClause(bag, opts);
  const scene = sceneClause(bag, opts);
  const session = sessionClause(bag, opts);
  const bucket = bag.add("bucket", "u32", opts.bucket ?? 10);
  return {
    query: `
      SELECT
        floor(s_p50 / ${bucket}) * ${bucket} AS bucket,
        count() AS sessions
      FROM (
        SELECT
          session_id,
          ${d.quantile("fps", 0.5)} AS s_p50
        FROM events
        WHERE project_id = ${pid} AND event_type = 'frame_perf'${range}${scene}${session}
        GROUP BY session_id
      ) per_session
      GROUP BY bucket
      ORDER BY bucket ASC
    `,
    query_params: bag.values,
  };
}

/**
 * Frame-time percentiles in milliseconds, computed **per-session then
 * aggregated** (ADR 0028 §1). `p50_ms` is the median across sessions of each
 * session's median `frame_time_ms` (the typical frame cost); `p95_ms` is the
 * median across sessions of each session's worst-window `frame_time_p95_ms` —
 * the SDK already reports a per-window p95, so the tail is read from that
 * promoted column rather than re-derived from window means. Zero-valued detail
 * (unreported by older samples / non-`frame_perf` rows) is ignored via `nullIf`.
 */
export function buildFrameTimePercentiles(
  projectId: string,
  opts: RangeOptions & SceneOptions & SessionOptions,
  d: Dialect,
): QuerySpec {
  const bag = new ParamBag(d);
  const pid = bag.add("projectId", "string", projectId);
  const range = rangeClause(bag, opts);
  const scene = sceneClause(bag, opts);
  const session = sessionClause(bag, opts);
  return {
    query: `
      SELECT
        count() AS sessions,
        sum(s_samples) AS samples,
        ${d.quantile("s_p50", 0.5)} AS p50_ms,
        ${d.quantile("s_p95", 0.5)} AS p95_ms
      FROM (
        SELECT
          session_id,
          count() AS s_samples,
          ${d.quantile("nullIf(frame_time_ms, 0)", 0.5)} AS s_p50,
          max(nullIf(frame_time_p95_ms, 0)) AS s_p95
        FROM events
        WHERE project_id = ${pid} AND event_type = 'frame_perf'${range}${scene}${session}
        GROUP BY session_id
      ) per_session
    `,
    query_params: bag.values,
  };
}

/**
 * Jank rate, computed **per-session then aggregated** (ADR 0028 §1). Each
 * session's rate is its total `long_frames` divided by its `frame_perf` sample
 * windows; the headline is the median session rate plus the worst-decile (p90)
 * session rate, so a handful of janky sessions surface instead of being averaged
 * away. `total_long_frames` is the raw jank count and `sessions` the number of
 * contributing sessions.
 */
export function buildJankRate(
  projectId: string,
  opts: RangeOptions & SceneOptions & SessionOptions,
  d: Dialect,
): QuerySpec {
  const bag = new ParamBag(d);
  const pid = bag.add("projectId", "string", projectId);
  const range = rangeClause(bag, opts);
  const scene = sceneClause(bag, opts);
  const session = sessionClause(bag, opts);
  return {
    query: `
      SELECT
        count() AS sessions,
        sum(s_long) AS total_long_frames,
        ${d.quantile("s_rate", 0.5)} AS median_rate,
        ${d.quantile("s_rate", 0.9)} AS worst_decile_rate
      FROM (
        SELECT
          session_id,
          sum(long_frames) AS s_long,
          sum(long_frames) * 1.0 / count() AS s_rate
        FROM events
        WHERE project_id = ${pid} AND event_type = 'frame_perf'${range}${scene}${session}
        GROUP BY session_id
      ) per_session
    `,
    query_params: bag.values,
  };
}

/**
 * FPS segmented by device class, computed **per-session then aggregated** (ADR
 * 0028 §2). Each session's median FPS is attributed to the graphics backend,
 * mobile flag, and GPU `renderer` recorded in its `session_start.device` block —
 * data already on the wire, so there is no SDK or schema change. Device fields
 * are read from the `session_start` payload JSON (they are not promoted columns)
 * and `coalesce`d to `''` when a session never reported them. `p50_fps` is the
 * median across sessions in the group of each session's median FPS.
 */
export function buildPerfByDevice(
  projectId: string,
  opts: RangeOptions & SceneOptions & SessionOptions,
  d: Dialect,
): QuerySpec {
  const bag = new ParamBag(d);
  const pid = bag.add("projectId", "string", projectId);
  const range = rangeClause(bag, opts);
  const scene = sceneClause(bag, opts);
  const session = sessionClause(bag, opts);
  const engine = d.jsonText("payload", "device", "engine");
  const isMobile = d.jsonText("payload", "device", "isMobile");
  const renderer = d.jsonText("payload", "device", "renderer");
  return {
    query: `
      WITH session_device AS (
        SELECT
          session_id,
          ${engine} AS engine,
          ${isMobile} AS is_mobile,
          ${renderer} AS renderer
        FROM events
        WHERE project_id = ${pid} AND event_type = 'session_start'
      ),
      session_perf AS (
        SELECT
          session_id,
          count() AS s_samples,
          ${d.quantile("fps", 0.5)} AS s_p50
        FROM events
        WHERE project_id = ${pid} AND event_type = 'frame_perf'${range}${scene}${session}
        GROUP BY session_id
      )
      SELECT
        coalesce(dev.engine, '') AS engine,
        coalesce(dev.is_mobile, '') AS is_mobile,
        coalesce(dev.renderer, '') AS renderer,
        count() AS sessions,
        sum(perf.s_samples) AS samples,
        ${d.quantile("perf.s_p50", 0.5)} AS p50_fps
      FROM session_perf perf
      LEFT JOIN session_device dev ON dev.session_id = perf.session_id
      GROUP BY engine, is_mobile, renderer
      ORDER BY sessions DESC
    `,
    query_params: bag.values,
  };
}

/**
 * FPS segmented by scene, computed **per-session then aggregated** (ADR 0028 §1).
 * Each session's median FPS is attributed to its scene (a session renders one
 * scene); `p50_fps` is the median across the scene's sessions of each session's
 * median FPS, so neither long sessions nor a busy scene's traffic skews the
 * comparison between scenes.
 */
export function buildPerfByScene(
  projectId: string,
  opts: RangeOptions & SceneOptions & SessionOptions,
  d: Dialect,
): QuerySpec {
  const bag = new ParamBag(d);
  const pid = bag.add("projectId", "string", projectId);
  const range = rangeClause(bag, opts);
  const scene = sceneClause(bag, opts);
  const session = sessionClause(bag, opts);
  return {
    query: `
      SELECT
        scene_id,
        count() AS sessions,
        sum(s_samples) AS samples,
        ${d.quantile("s_p50", 0.5)} AS p50_fps
      FROM (
        SELECT
          session_id,
          ${d.anyValue("scene_id")} AS scene_id,
          count() AS s_samples,
          ${d.quantile("fps", 0.5)} AS s_p50
        FROM events
        WHERE project_id = ${pid} AND event_type = 'frame_perf'${range}${scene}${session}
        GROUP BY session_id
      ) per_session
      GROUP BY scene_id
      ORDER BY sessions DESC
    `,
    query_params: bag.values,
  };
}

/**
 * Daily rendering-performance trend, read from the `perf_daily` materialized
 * view (migration 0003/0004). Aggregate states are merged with `-Merge`.
 */
export function buildPerfDaily(
  projectId: string,
  opts: RangeOptions & { limit?: number },
  d: Dialect,
): QuerySpec {
  const bag = new ParamBag(d);
  const pid = bag.add("projectId", "string", projectId);
  const range = dayRangeClause(bag, d, opts);
  const limit = bag.add("limit", "u32", opts.limit ?? 30);
  return {
    query: `
      SELECT
        ${d.toText("day")} AS day,
        ${d.countMerge("samples_state")} AS samples,
        ${d.avgMerge("avg_fps_state")} AS avg_fps,
        min(min_fps) AS min_fps,
        ${d.quantileMerge("p50_fps_state", 0.5)} AS p50_fps
      FROM perf_daily
      WHERE project_id = ${pid}${range}
      GROUP BY day
      ORDER BY day DESC
      LIMIT ${limit}
    `,
    query_params: bag.values,
  };
}

/**
 * Daily event-count trend per event type, read from the `events_daily`
 * materialized view (migration 0005/0006). SummingMergeTree counts are summed.
 */
export function buildEventsDaily(
  projectId: string,
  opts: RangeOptions & { limit?: number },
  d: Dialect,
): QuerySpec {
  const bag = new ParamBag(d);
  const pid = bag.add("projectId", "string", projectId);
  const range = dayRangeClause(bag, d, opts);
  const limit = bag.add("limit", "u32", opts.limit ?? 200);
  return {
    query: `
      SELECT
        ${d.toText("day")} AS day,
        event_type,
        sum(events) AS events
      FROM events_daily
      WHERE project_id = ${pid}${range}
      GROUP BY day, event_type
      ORDER BY day DESC, sum(events) DESC
      LIMIT ${limit}
    `,
    query_params: bag.values,
  };
}

/**
 * Distinct developer-assigned scenes for a project (ADR 0010), with an event
 * `count` and the most recent activity `last_seen`. Time-range aware.
 */
export function buildDistinctScenes(
  projectId: string,
  opts: RangeOptions & { limit?: number },
  d: Dialect,
): QuerySpec {
  const bag = new ParamBag(d);
  const pid = bag.add("projectId", "string", projectId);
  const range = rangeClause(bag, opts);
  const limit = bag.add("limit", "u32", opts.limit ?? 200);
  return {
    query: `
      SELECT
        scene_id,
        count() AS events,
        max(ts) AS last_seen
      FROM events
      WHERE project_id = ${pid}${range}
      GROUP BY scene_id
      ORDER BY events DESC
      LIMIT ${limit}
    `,
    query_params: bag.values,
  };
}

/**
 * Event-volume time-series: bucket events into fixed `interval`-second windows
 * and return the per-bucket count plus the average FPS of any `frame_perf`
 * samples in that bucket. Optionally scoped to one scene and/or event type.
 */
export function buildTimeseries(
  projectId: string,
  opts: RangeOptions & SceneOptions & TimeseriesOptions,
  d: Dialect,
): QuerySpec {
  const bag = new ParamBag(d);
  const pid = bag.add("projectId", "string", projectId);
  const interval = bag.add("interval", "u32", opts.interval ?? 3600);
  const range = rangeClause(bag, opts);
  const scene = sceneClause(bag, opts);
  const type =
    opts.type != null && opts.type.length > 0
      ? ` AND event_type = ${bag.add("type", "string", opts.type)}`
      : "";
  return {
    query: `
      SELECT
        ${d.timeBucketMs("ts", interval)} AS bucket,
        count() AS events,
        ${d.avgIf("fps", "event_type = 'frame_perf'")} AS avg_fps
      FROM events
      WHERE project_id = ${pid}${range}${scene}${type}
      GROUP BY bucket
      ORDER BY bucket ASC
    `,
    query_params: bag.values,
  };
}

/**
 * Per-event-type counts over the range (optionally one scene). Powers the scene
 * health panel — error rate, context-loss incidents, focus/visibility gaps, etc.
 */
export function buildEventTypeCounts(
  projectId: string,
  opts: RangeOptions & SceneOptions,
  d: Dialect,
): QuerySpec {
  const bag = new ParamBag(d);
  const pid = bag.add("projectId", "string", projectId);
  const range = rangeClause(bag, opts);
  const scene = sceneClause(bag, opts);
  return {
    query: `
      SELECT event_type, count() AS count
      FROM events
      WHERE project_id = ${pid}${range}${scene}
      GROUP BY event_type
      ORDER BY count DESC
    `,
    query_params: bag.values,
  };
}

/**
 * Scene coverage / dead zones (derived, ADR — scene-metrics §B): voxel-bin the
 * camera *position* of `camera_sample` into a uniform grid of `cellSize`-sized
 * cubes. Each row is an occupied voxel with its visit `count`. Exploration
 * completeness ("saw 40% of the scene") and never-visited regions are computed by
 * the consumer against the scene AABB voxel count — the AABB lives in the scene
 * registry, not the events table, so it is layered in at presentation time.
 */
export function buildSceneCoverage(
  projectId: string,
  opts: RangeOptions & SceneOptions & SessionOptions & { cellSize?: number; limit?: number },
  d: Dialect,
): QuerySpec {
  const bag = new ParamBag(d);
  const pid = bag.add("projectId", "string", projectId);
  const cellSize = bag.add("cellSize", "f64", opts.cellSize ?? 1);
  const range = rangeClause(bag, opts);
  const scene = sceneClause(bag, opts);
  const session = sessionClause(bag, opts);
  const limit = bag.add("limit", "u32", opts.limit ?? 5000);
  return {
    query: `
      SELECT
        floor(position[1] / ${cellSize}) AS vx,
        floor(position[2] / ${cellSize}) AS vy,
        floor(position[3] / ${cellSize}) AS vz,
        count() AS count
      FROM events
      WHERE project_id = ${pid}
        AND event_type = 'camera_sample'
        AND length(position) = 3${range}${scene}${session}
      GROUP BY vx, vy, vz
      ORDER BY count DESC
      LIMIT ${limit}
    `,
    query_params: bag.values,
  };
}

/**
 * Camera distance / zoom distribution (derived, scene-metrics §B): histogram the
 * distance from the camera *position* of each `camera_sample` to a reference
 * `center` (the scene-AABB center, passed in world units; defaults to the
 * origin), bucketed into `bucketSize`-wide bins. A proxy for engagement intensity
 * — how close visitors get to the subject.
 */
export function buildCameraDistance(
  projectId: string,
  opts: RangeOptions &
    SceneOptions &
    SessionOptions & {
      center?: readonly [number, number, number];
      bucketSize?: number;
      limit?: number;
    },
  d: Dialect,
): QuerySpec {
  const bag = new ParamBag(d);
  const pid = bag.add("projectId", "string", projectId);
  const [cx0, cy0, cz0] = opts.center ?? [0, 0, 0];
  const cx = bag.add("centerX", "f64", cx0);
  const cy = bag.add("centerY", "f64", cy0);
  const cz = bag.add("centerZ", "f64", cz0);
  const bucketSize = bag.add("bucketSize", "f64", opts.bucketSize ?? 1);
  const range = rangeClause(bag, opts);
  const scene = sceneClause(bag, opts);
  const session = sessionClause(bag, opts);
  const limit = bag.add("limit", "u32", opts.limit ?? 1000);
  return {
    query: `
      SELECT
        floor(sqrt(
          (position[1] - ${cx}) * (position[1] - ${cx}) +
          (position[2] - ${cy}) * (position[2] - ${cy}) +
          (position[3] - ${cz}) * (position[3] - ${cz})
        ) / ${bucketSize}) AS bucket,
        count() AS count
      FROM events
      WHERE project_id = ${pid}
        AND event_type = 'camera_sample'
        AND length(position) = 3${range}${scene}${session}
      GROUP BY bucket
      ORDER BY bucket ASC
      LIMIT ${limit}
    `,
    query_params: bag.values,
  };
}

/**
 * Navigation effort / friction (derived, scene-metrics §B): per session, ASOF
 * self-join each `camera_sample` to the immediately preceding one and accumulate
 * the inter-sample travel distance. `total_distance` is the path length; segments
 * whose distance clears `moveThreshold` count as *active* (the rest are idle
 * dwell), so a high segment count with low active distance flags a "stuck" / lost
 * visitor. World units throughout.
 */
export function buildNavigationStats(
  projectId: string,
  opts: RangeOptions & SceneOptions & SessionOptions & { moveThreshold?: number; limit?: number },
  d: Dialect,
): QuerySpec {
  const bag = new ParamBag(d);
  const pid = bag.add("projectId", "string", projectId);
  const moveThreshold = bag.add("moveThreshold", "f64", opts.moveThreshold ?? 0.05);
  const range = rangeClause(bag, opts);
  const scene = sceneClause(bag, opts);
  const session = sessionClause(bag, opts);
  const limit = bag.add("limit", "u32", opts.limit ?? 500);
  const sampleSelect = `
        SELECT session_id, ts, position[1] AS px, position[2] AS py, position[3] AS pz
        FROM events
        WHERE project_id = ${pid}
          AND event_type = 'camera_sample'
          AND length(position) = 3${range}${scene}${session}`;
  return {
    query: `
      SELECT
        session_id,
        count() AS segments,
        sum(dist) AS total_distance,
        sum(CASE WHEN dist >= ${moveThreshold} THEN 1 ELSE 0 END) AS active_segments,
        sum(CASE WHEN dist >= ${moveThreshold} THEN dist ELSE 0 END) AS active_distance
      FROM (
        SELECT
          c.session_id AS session_id,
          sqrt(
            (c.px - m.px) * (c.px - m.px) +
            (c.py - m.py) * (c.py - m.py) +
            (c.pz - m.pz) * (c.pz - m.pz)
          ) AS dist
        FROM (${sampleSelect}
        ) AS c
        ${d.asofInnerJoin} (${sampleSelect}
        ) AS m
        ON c.session_id = m.session_id AND c.ts > m.ts
      ) AS seg
      GROUP BY session_id
      ORDER BY total_distance DESC
      LIMIT ${limit}
    `,
    query_params: bag.values,
  };
}

/** XR input sources that distinguish hand-tracking, controllers and gaze. */
const XR_SOURCES = "('xr-controller', 'hand', 'gaze', 'transient')";

/**
 * Event types that carry the shared input-source vocabulary (ADR 0011) — i.e.
 * the interactions actually *triggered by* an input source. Restricting to these
 * keeps non-interaction events (`camera_sample`, `frame_perf`, …), whose `source`
 * column is the realized `'mouse'` default, out of the source breakdown.
 */
const INPUT_SOURCE_EVENT_TYPES =
  "('pointer_move', 'pointer_click', 'pointer_down', 'pointer_up', " +
  "'mesh_interaction', 'hover_dwell', 'camera_gesture', 'input_action')";

/**
 * Input-source breakdown (ADR 0011): for every interaction event that carries an
 * input source, how many fired per `(event_type, source)`, and how many distinct
 * sessions used that pairing. This turns `source` from a filter-only dimension
 * into an actual insight — e.g. how many `mesh_interaction`s came from an
 * `xr-controller` vs a `mouse`, or whether `pointer_click`s skew to `touch`.
 * Honors the same scene/source/session filters as the rest of the surface.
 */
export function buildInteractionsBySource(
  projectId: string,
  opts: RangeOptions & SceneOptions & SourceOptions & SessionOptions & { limit?: number },
  d: Dialect,
): QuerySpec {
  const bag = new ParamBag(d);
  const pid = bag.add("projectId", "string", projectId);
  const range = rangeClause(bag, opts);
  const scene = sceneClause(bag, opts);
  const source = sourceClause(bag, opts);
  const session = sessionClause(bag, opts);
  const limit = bag.add("limit", "u32", opts.limit ?? 100);
  return {
    query: `
      SELECT
        event_type,
        source,
        count() AS count,
        count(DISTINCT session_id) AS sessions
      FROM events
      WHERE project_id = ${pid}
        AND event_type IN ${INPUT_SOURCE_EVENT_TYPES}${range}${scene}${source}${session}
      GROUP BY event_type, source
      ORDER BY count DESC
      LIMIT ${limit}
    `,
    query_params: bag.values,
  };
}

/**
 * Most-used shortcuts / actions (#75, ADR 0023): rank the discrete `input_action`
 * events (keyboard chords, gamepad buttons) by their app-level `action` label,
 * split by `source` (keyboard / gamepad / …). The action label is carried in the
 * engine-neutral `name` column (events.ts maps `input_action.action` → `name`),
 * so a connector's semantic binding — `"rotate-left"`, `"next-camera"` — surfaces
 * as a leaderboard. Pairs with {@link buildInteractionsBySource} (the modality
 * share) to answer "which keys/buttons do people actually press". Ranked by count.
 */
export function buildTopInputActions(
  projectId: string,
  opts: RangeOptions & SceneOptions & SourceOptions & SessionOptions & { limit?: number },
  d: Dialect,
): QuerySpec {
  const bag = new ParamBag(d);
  const pid = bag.add("projectId", "string", projectId);
  const range = rangeClause(bag, opts);
  const scene = sceneClause(bag, opts);
  const source = sourceClause(bag, opts);
  const session = sessionClause(bag, opts);
  const limit = bag.add("limit", "u32", opts.limit ?? 100);
  return {
    query: `
      SELECT
        name AS action,
        source,
        count() AS count
      FROM events
      WHERE project_id = ${pid} AND event_type = 'input_action' AND name != ''${range}${scene}${source}${session}
      GROUP BY name, source
      ORDER BY count DESC
      LIMIT ${limit}
    `,
    query_params: bag.values,
  };
}

/**
 * XR motion-sickness proxy (derived, scene-metrics §F): per session, the
 * head/view rotation *rate* over the `camera_sample` pose stream. Each sample is
 * ASOF self-joined to its immediate predecessor and the angle between the two
 * (normalized) view directions is accumulated — `total_turn_rad` is the angular
 * path, `max_turn_rad` the worst single jerk, and `rapid_segments` counts steps
 * whose turn clears `rapidTurn` (rad). The pose cadence is fixed by the sampling
 * profile, so the per-sample angular delta is a discomfort proxy: rapid view
 * rotation correlates with simulator sickness, most acutely in a headset.
 */
export function buildXrRotationRate(
  projectId: string,
  opts: RangeOptions & SceneOptions & SessionOptions & { rapidTurn?: number; limit?: number },
  d: Dialect,
): QuerySpec {
  const bag = new ParamBag(d);
  const pid = bag.add("projectId", "string", projectId);
  const rapidTurn = bag.add("rapidTurn", "f64", opts.rapidTurn ?? 0.5);
  const range = rangeClause(bag, opts);
  const scene = sceneClause(bag, opts);
  const session = sessionClause(bag, opts);
  const limit = bag.add("limit", "u32", opts.limit ?? 500);
  const sampleSelect = `
        SELECT session_id, ts, direction[1] AS dx, direction[2] AS dy, direction[3] AS dz
        FROM events
        WHERE project_id = ${pid}
          AND event_type = 'camera_sample'
          AND length(direction) = 3${range}${scene}${session}`;
  return {
    query: `
      SELECT
        session_id,
        count() AS samples,
        avg(turn) AS avg_turn_rad,
        max(turn) AS max_turn_rad,
        sum(turn) AS total_turn_rad,
        sum(CASE WHEN turn >= ${rapidTurn} THEN 1 ELSE 0 END) AS rapid_segments
      FROM (
        SELECT
          c.session_id AS session_id,
          acos(least(1, greatest(-1,
            (c.dx * m.dx + c.dy * m.dy + c.dz * m.dz) /
            (sqrt(c.dx * c.dx + c.dy * c.dy + c.dz * c.dz) *
             sqrt(m.dx * m.dx + m.dy * m.dy + m.dz * m.dz))
          ))) AS turn
        FROM (${sampleSelect}
        ) AS c
        ${d.asofInnerJoin} (${sampleSelect}
        ) AS m
        ON c.session_id = m.session_id AND c.ts > m.ts
      ) AS seg
      GROUP BY session_id
      ORDER BY total_turn_rad DESC
      LIMIT ${limit}
    `,
    query_params: bag.values,
  };
}

/**
 * XR input-source usage (derived, scene-metrics §F): hand vs. controller (vs.
 * gaze / transient) split, read from `source` on the existing interaction events.
 * One row per XR `source` with its interaction `count` and the number of
 * `sessions` that used it — flat-screen sources (`mouse`, `touch`, …) are
 * excluded so the breakdown is purely the immersive input mix.
 */
export function buildXrSourceUsage(
  projectId: string,
  opts: RangeOptions & SceneOptions & SessionOptions & { limit?: number },
  d: Dialect,
): QuerySpec {
  const bag = new ParamBag(d);
  const pid = bag.add("projectId", "string", projectId);
  const range = rangeClause(bag, opts);
  const scene = sceneClause(bag, opts);
  const session = sessionClause(bag, opts);
  const limit = bag.add("limit", "u32", opts.limit ?? 50);
  return {
    query: `
      SELECT
        source,
        count() AS interactions,
        count(DISTINCT session_id) AS sessions
      FROM events
      WHERE project_id = ${pid}
        AND source IN ${XR_SOURCES}${range}${scene}${session}
      GROUP BY source
      ORDER BY interactions DESC
      LIMIT ${limit}
    `,
    query_params: bag.values,
  };
}

/**
 * XR session abandonment (derived, scene-metrics §F): for every session that
 * used an XR input source, its first/last timestamps and event/interaction
 * counts. Comfort drop-off is read by the consumer as a short
 * `ended_at - started_at` span (a headset session cut short) — the wall-clock
 * bounds are engine-specific and excluded from parity, while the counts are
 * compared. Sessions with no XR input are omitted entirely.
 */
export function buildXrAbandonment(
  projectId: string,
  opts: RangeOptions & SceneOptions & SessionOptions & { limit?: number },
  d: Dialect,
): QuerySpec {
  const bag = new ParamBag(d);
  const pid = bag.add("projectId", "string", projectId);
  const range = rangeClause(bag, opts);
  const scene = sceneClause(bag, opts);
  const session = sessionClause(bag, opts);
  const limit = bag.add("limit", "u32", opts.limit ?? 500);
  return {
    query: `
      SELECT
        session_id,
        count() AS events,
        sum(CASE WHEN source IN ${XR_SOURCES} THEN 1 ELSE 0 END) AS xr_interactions,
        min(ts) AS started_at,
        max(ts) AS ended_at
      FROM events
      WHERE project_id = ${pid}${range}${scene}${session}
        AND session_id IN (
          SELECT session_id
          FROM events
          WHERE project_id = ${pid}
            AND source IN ${XR_SOURCES}
        )
      GROUP BY session_id
      ORDER BY started_at DESC
      LIMIT ${limit}
    `,
    query_params: bag.values,
  };
}

/**
 * Render one funnel step's predicate against the wide `events` columns (ADR
 * 0038). Every field compiles to plain equality on a promoted column, so the
 * predicate is engine-agnostic and parameter-bound (injection-safe): `type` →
 * `event_type`; `name` → the `name` column (which already carries the
 * `camera_gesture` / `mesh_interaction` kind and the `custom` event name); and
 * `mesh` → the `mesh` column. Columns are unqualified — they resolve to `events`
 * even inside the joined CTEs because the joined funnel CTEs expose only
 * `session_id` and `t`.
 */
function funnelStepPredicate(bag: ParamBag, step: FunnelStepInput, i: number): string {
  const parts = [`event_type = ${bag.add(`fType${i}`, "string", step.type)}`];
  if (step.name != null && step.name.length > 0) {
    parts.push(`name = ${bag.add(`fName${i}`, "string", step.name)}`);
  }
  if (step.mesh != null && step.mesh.length > 0) {
    parts.push(`mesh = ${bag.add(`fMesh${i}`, "string", step.mesh)}`);
  }
  return parts.join(" AND ");
}

/**
 * Single-project configurator funnel (#78, ADR 0038): ordered, per-session
 * step-reach with the drop-off between consecutive steps.
 *
 * Semantics — a session **reaches step N** iff there is an event matching step
 * N's predicate at a timestamp **≥ the first time it reached step N−1**, within
 * the same `session_id` (step 0 is reached on its first matching event). This is
 * an ordered, first-touch, monotonic funnel: steps must occur in order, only the
 * first qualifying occurrence per step counts, and a row's `sessions` is the
 * number of sessions reaching that step.
 *
 * Implementation — a CTE chain, one level per step. Level 0 takes each session's
 * first matching timestamp; level K joins the prior level on `session_id` and
 * takes the first matching timestamp `≥` the prior level's. This uses only
 * `JOIN` / `min` / `GROUP BY` — **no window or ASOF functions** — so it renders
 * identically on DuckDB (OSS) and ClickHouse (scale tier) and is covered by a
 * hand-verified parity golden (ADR 0020). The final `UNION ALL` counts the
 * sessions surviving each level; the consumer derives the conversion rates.
 *
 * The `steps` come from the caller (request input / CLI / hosted), not a stored
 * config — OSS has no authoring surface (ADR 0038).
 */
export function buildFunnel(projectId: string, opts: FunnelOptions, d: Dialect): QuerySpec {
  const bag = new ParamBag(d);
  const pid = bag.add("projectId", "string", projectId);
  const range = rangeClause(bag, opts);
  const scene = sceneClause(bag, opts);
  const cameraMode = cameraModeClause(bag, d, projectId, opts);
  const steps = opts.steps;

  const ctes = steps.map((step, i) => {
    const pred = funnelStepPredicate(bag, step, i);
    if (i === 0) {
      // Level 0: each session's first event matching step 0. Session-level
      // filters (range / scene / camera-mode) apply here and the subset
      // propagates through the joins below.
      return `s0 AS (
        SELECT session_id, min(ts) AS t
        FROM events
        WHERE project_id = ${pid} AND ${pred}${range}${scene}${cameraMode}
        GROUP BY session_id
      )`;
    }
    // Level i: the first matching event at or after the prior step's reach time.
    // `events.session_id` is qualified (ambiguous with the joined CTE); the
    // unqualified predicate / range / scene columns resolve to `events`.
    return `s${i} AS (
        SELECT events.session_id AS session_id, min(events.ts) AS t
        FROM events JOIN s${i - 1} ON events.session_id = s${i - 1}.session_id
        WHERE project_id = ${pid} AND ${pred} AND ts >= s${i - 1}.t${range}${scene}
        GROUP BY events.session_id
      )`;
  });

  const counts = steps
    .map((_step, i) => `SELECT ${i} AS step, count() AS sessions FROM s${i}`)
    .join("\n      UNION ALL ");

  return {
    query: `
      WITH ${ctes.join(",\n      ")}
      ${counts}
      ORDER BY step ASC
    `,
    query_params: bag.values,
  };
}
