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
  SceneRetentionOptions,
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
 * 360° view-coverage histogram (#146): how much of a 3D object each session
 * actually looked at, bucketed across sessions. Each session's `camera_sample`
 * `direction` samples are binned into the **same** azimuth/elevation grid as the
 * view-direction dome ({@link buildCameraDirectionHeatmap}); the fraction of the
 * `bins × bins` cells a session visited is its coverage score (0–100%). Sessions
 * are then grouped into four coverage buckets — `0` (0–25%), `25` (25–50%), `50`
 * (50–75%), `75` (75–100%) — answering "how many visitors saw <25% of the
 * product". A single integer `bin_id = azimuth_bin * bins + elevation_bin` keeps
 * the distinct-cell count cross-dialect (no `COUNT(DISTINCT a, b)`), and
 * `least(floor(pct / 25), 3)` folds a full-coverage (100%) session into the top
 * bucket instead of a spurious fifth `100` bucket. Purely derived from the
 * existing `camera_sample` stream — no schema change.
 */
export function buildViewCoverageHistogram(
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
        least(floor(coverage_pct / 25), 3) * 25 AS bucket,
        count() AS sessions
      FROM (
        SELECT
          session_id,
          count(DISTINCT bin_id) * 100.0 / (${bins} * ${bins}) AS coverage_pct
        FROM (
          SELECT
            session_id,
            floor((atan2(direction[3], direction[1]) + pi()) / (2 * pi()) * ${bins}) * ${bins}
              + floor((asin(direction[2] / greatest(${d.vectorNorm("direction")}, 1e-6)) + pi() / 2) / pi() * ${bins}) AS bin_id
          FROM events
          WHERE project_id = ${pid}
            AND event_type = 'camera_sample'
            AND length(direction) = 3${range}${scene}${session}${cameraMode}
        ) binned
        GROUP BY session_id
      ) per_session
      GROUP BY bucket
      ORDER BY bucket ASC
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
 * stylus) have no native ray; when the ASOF-joined `camera_sample` carries the
 * projection intrinsics (`fov`/`aspect`/`near`, #22, ADR 0043) we unproject the
 * click's normalized `screen[x, y]` onto the camera **near plane** and use that
 * point as the origin, so flat-pointer rays fan out across the near plane the way
 * the clicks were actually made. The near-plane basis assumes the canonical
 * world-up `(0, 1, 0)` and no camera roll (true for mouse/touch); a degenerate
 * look-straight-up/down view (or any missing/zero intrinsic, e.g. legacy data)
 * falls back to the nearest preceding `camera_sample` **position** — the
 * historical view-gated behavior. The camera join is therefore a LEFT join so
 * pose clicks survive even in sessions that never emit a `camera_sample`; rows
 * with neither a ray, a reconstructable near-plane point, nor a camera origin are
 * dropped.
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
          ja.hx AS hx, ja.hy AS hy, ja.hz AS hz, ja.mesh AS mesh,
          CASE
            WHEN ja.has_ray THEN ja.rox
            WHEN ja.recon THEN ja.px + ja.dx * ja.near / ja.dlen
              + (ja.dz / ja.hlen) * ja.off_r
              + (-(ja.dx * ja.dy) / (ja.dlen * ja.hlen)) * ja.off_u
            WHEN ja.cam_present = 1 THEN ja.px
          END AS ox,
          CASE
            WHEN ja.has_ray THEN ja.roy
            WHEN ja.recon THEN ja.py + ja.dy * ja.near / ja.dlen
              + (ja.hlen / ja.dlen) * ja.off_u
            WHEN ja.cam_present = 1 THEN ja.py
          END AS oy,
          CASE
            WHEN ja.has_ray THEN ja.roz
            WHEN ja.recon THEN ja.pz + ja.dz * ja.near / ja.dlen
              + (-(ja.dx) / ja.hlen) * ja.off_r
              + (-(ja.dy * ja.dz) / (ja.dlen * ja.hlen)) * ja.off_u
            WHEN ja.cam_present = 1 THEN ja.pz
          END AS oz
        FROM (
          SELECT
            c.hx AS hx, c.hy AS hy, c.hz AS hz, c.mesh AS mesh,
            c.has_ray AS has_ray, c.rox AS rox, c.roy AS roy, c.roz AS roz,
            m.cam_present AS cam_present,
            m.px AS px, m.py AS py, m.pz AS pz,
            m.dx AS dx, m.dy AS dy, m.dz AS dz, m.cam_near AS near,
            sqrt(m.dx * m.dx + m.dy * m.dy + m.dz * m.dz) AS dlen,
            sqrt(m.dx * m.dx + m.dz * m.dz) AS hlen,
            (2 * c.sx - 1) * m.cam_near * tan(m.cam_fov / 2) * m.cam_aspect AS off_r,
            (1 - 2 * c.sy) * m.cam_near * tan(m.cam_fov / 2) AS off_u,
            (NOT c.has_ray) AND c.has_screen
              AND m.cam_fov > 0 AND m.cam_aspect > 0 AND m.cam_near > 0
              AND sqrt(m.dx * m.dx + m.dz * m.dz)
                  > 1e-6 * sqrt(m.dx * m.dx + m.dy * m.dy + m.dz * m.dz) AS recon
          FROM (
            SELECT session_id, ts,
              hit_point[1] AS hx, hit_point[2] AS hy, hit_point[3] AS hz, mesh,
              length(ray_origin) = 3 AS has_ray,
              ray_origin[1] AS rox, ray_origin[2] AS roy, ray_origin[3] AS roz,
              length(screen) = 2 AS has_screen,
              screen[1] AS sx, screen[2] AS sy
            FROM events
            WHERE project_id = ${pid}
              AND event_type = 'pointer_click'
              AND length(hit_point) = 3${range}${scene}${source}${session}
          ) AS c
          ${d.asofLeftJoin} (
            SELECT session_id, ts, 1 AS cam_present,
              position[1] AS px, position[2] AS py, position[3] AS pz,
              direction[1] AS dx, direction[2] AS dy, direction[3] AS dz,
              fov AS cam_fov, aspect AS cam_aspect, near AS cam_near
            FROM events
            WHERE project_id = ${pid}
              AND event_type = 'camera_sample'
              AND length(position) = 3${range}${scene}${session}
          ) AS m
          ON c.session_id = m.session_id AND c.ts >= m.ts
        ) AS ja
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
 * Blind-spot / never-noticed meshes (#143): the inverse of the Top-meshes and
 * part-popularity leaderboards. Cross-references what was *rendered* against what
 * was *engaged with* — per mesh, the total `mesh_visibility` on-screen time vs.
 * the count of `mesh_interaction` events and the `hover_dwell` hesitation. A mesh
 * with high visibility but zero (or near-zero) interaction + hover is a blind
 * spot: a product detail nobody noticed, or a prop/room that renders but nobody
 * investigates.
 *
 * Engagement is deliberately the two *active-attention* signals the issue names —
 * `mesh_interaction` (the source-neutral pick/hover/drag signal, ADR 0011) and
 * `hover_dwell` (hover-without-action, #48). Passive gaze (`camera_sample`) is
 * not engagement, and raw `pointer_click` is excluded because a mesh-hitting click
 * already surfaces as a `mesh_interaction`. Both durations live in the shared
 * `visible_ms` column (events.ts maps `mesh_visibility.visibleMs` and
 * `hover_dwell.dwellMs` onto it), so the whole report is one grouped scan.
 *
 * `HAVING sum(visible_ms) WHERE mesh_visibility > 0` keeps only meshes that were
 * actually seen (a blind spot must first be visible). Ranked by engagement
 * ascending, then visibility descending, so the most-seen-yet-least-touched
 * meshes rank first.
 */
export function buildMeshBlindSpots(
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
        sum(CASE WHEN event_type = 'mesh_visibility' THEN visible_ms ELSE 0 END) AS visible_ms,
        sum(CASE WHEN event_type = 'mesh_visibility' THEN 1 ELSE 0 END) AS vis_samples,
        sum(CASE WHEN event_type = 'mesh_interaction' THEN 1 ELSE 0 END) AS interactions,
        sum(CASE WHEN event_type = 'hover_dwell' THEN visible_ms ELSE 0 END) AS hover_ms,
        sum(CASE WHEN event_type = 'hover_dwell' THEN 1 ELSE 0 END) AS hover_episodes
      FROM events
      WHERE project_id = ${pid}
        AND event_type IN ('mesh_visibility', 'mesh_interaction', 'hover_dwell')
        AND mesh != ''${range}${scene}${session}
      GROUP BY mesh
      HAVING sum(CASE WHEN event_type = 'mesh_visibility' THEN visible_ms ELSE 0 END) > 0
      ORDER BY
        sum(CASE WHEN event_type = 'mesh_interaction' THEN 1 ELSE 0 END)
          + sum(CASE WHEN event_type = 'hover_dwell' THEN 1 ELSE 0 END) ASC,
        sum(CASE WHEN event_type = 'mesh_visibility' THEN visible_ms ELSE 0 END) DESC
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
 * Reachability report (#151): how far each interacted mesh sat from where the
 * user actually stood. ASOF-join every `mesh_interaction` that carries a world
 * `point` (→ `hit_point`) to the nearest **preceding** `camera_sample` in the
 * same session, take the Euclidean standpoint→hit distance, and histogram it per
 * mesh in `bucketSize`-wide world-unit bands. Meshes/UI whose interactions
 * cluster in far bands are consistently reached from an uncomfortable range —
 * actionable feedback for VR UI placement and first-person layout.
 *
 * The standpoint is the click-time camera **position** (the shared coordinate
 * frame, ADR 0018); interactions with no preceding camera sample in range can't
 * be measured, so the inner ASOF join drops them. Same nearest-in-time caveat as
 * the click-gaze / navigation joins: camera samples are frequent enough that the
 * approximation is sound for discrete interaction events. Honors the shared
 * scene/source/session filters (source constrains the *interaction* side only —
 * a `camera_sample`'s `source` is the realized `'mouse'` default, ADR 0011).
 */
export function buildReachability(
  projectId: string,
  opts: RangeOptions &
    SceneOptions &
    SourceOptions &
    SessionOptions & { bucketSize?: number; limit?: number },
  d: Dialect,
): QuerySpec {
  const bag = new ParamBag(d);
  const pid = bag.add("projectId", "string", projectId);
  const bucketSize = bag.add("bucketSize", "f64", opts.bucketSize ?? 0.5);
  const range = rangeClause(bag, opts);
  const scene = sceneClause(bag, opts);
  const source = sourceClause(bag, opts);
  const session = sessionClause(bag, opts);
  const limit = bag.add("limit", "u32", opts.limit ?? 500);
  return {
    query: `
      SELECT
        seg.mesh AS mesh,
        floor(seg.dist / ${bucketSize}) AS bucket,
        count() AS count,
        avg(seg.dist) AS avg_distance
      FROM (
        SELECT
          i.mesh AS mesh,
          sqrt(
            (i.hx - m.px) * (i.hx - m.px) +
            (i.hy - m.py) * (i.hy - m.py) +
            (i.hz - m.pz) * (i.hz - m.pz)
          ) AS dist
        FROM (
          SELECT session_id, ts, mesh,
            hit_point[1] AS hx, hit_point[2] AS hy, hit_point[3] AS hz
          FROM events
          WHERE project_id = ${pid}
            AND event_type = 'mesh_interaction'
            AND mesh != ''
            AND length(hit_point) = 3${range}${scene}${source}${session}
        ) AS i
        ${d.asofInnerJoin} (
          SELECT session_id, ts,
            position[1] AS px, position[2] AS py, position[3] AS pz
          FROM events
          WHERE project_id = ${pid}
            AND event_type = 'camera_sample'
            AND length(position) = 3${range}${scene}${session}
        ) AS m
        ON i.session_id = m.session_id AND i.ts >= m.ts
      ) AS seg
      GROUP BY mesh, bucket
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
 * Opt-in engine-diagnostic counts from `graphics_diagnostic` (ADR 0021 part 2):
 * the fully-crossed `(severity, category, backend)` group with the total incident
 * count per cell, so the dashboard can derive the by-category, by-severity, and
 * by-backend breakdowns from a single query by summing.
 *
 * The diagnostic fields ride in the `payload` JSON (they are not promoted
 * columns, per ADR 0004 — nothing is promoted unless an aggregation needs it),
 * so `severity` / `category` / `backend` are read with `jsonText` and `backend`
 * `coalesce`s to `''` ("unknown") when the connector omitted it.
 *
 * **Rollup-or-marker (ADR 0021 decision 4).** Each event carries *either* one
 * discrete incident (no `count`) *or* a per-session rollup (`count = N`). The
 * incident total is `sum(coalesce(count, 1))`, so a marker folds in as 1 and a
 * rollup as N — markers and rollups land in the same counters. Capture is off by
 * default, so the common case is an empty result.
 */
export function buildGraphicsDiagnosticCounts(
  projectId: string,
  opts: RangeOptions & SceneOptions & SessionOptions,
  d: Dialect,
): QuerySpec {
  const bag = new ParamBag(d);
  const pid = bag.add("projectId", "string", projectId);
  const range = rangeClause(bag, opts);
  const scene = sceneClause(bag, opts);
  const session = sessionClause(bag, opts);
  const severity = d.jsonText("payload", "severity");
  const category = d.jsonText("payload", "category");
  const backend = d.jsonText("payload", "backend");
  const count = d.jsonInt("payload", "count");
  return {
    query: `
      SELECT
        ${severity} AS severity,
        ${category} AS category,
        coalesce(${backend}, '') AS backend,
        sum(coalesce(${count}, 1)) AS incidents
      FROM events
      WHERE project_id = ${pid} AND event_type = 'graphics_diagnostic'${range}${scene}${session}
      GROUP BY severity, category, backend
      ORDER BY incidents DESC
    `,
    query_params: bag.values,
  };
}

/**
 * Always-on rendering-technology mix from `session_start.graphics` (ADR 0021 part
 * 1): the fully-crossed `(api, backend, api_version, shading_language)` group with
 * one session count per cell, so the dashboard can derive the by-api, by-backend,
 * by-version, and by-shading-language breakdowns from a single query by summing.
 *
 * The graphics fields ride in the `payload` JSON (they are not promoted columns,
 * per ADR 0004 — nothing is promoted unless an aggregation needs it), so each is
 * read with `jsonText` and `coalesce`s to `''` ("unknown") when the connector
 * omitted it. Unlike the opt-in `graphics_diagnostic` counts, `session_start` is
 * always-on, so a populated result is the common case.
 */
export function buildRenderingTechnology(
  projectId: string,
  opts: RangeOptions & SceneOptions & SessionOptions,
  d: Dialect,
): QuerySpec {
  const bag = new ParamBag(d);
  const pid = bag.add("projectId", "string", projectId);
  const range = rangeClause(bag, opts);
  const scene = sceneClause(bag, opts);
  const session = sessionClause(bag, opts);
  const api = d.jsonText("payload", "graphics", "api");
  const backend = d.jsonText("payload", "graphics", "backend");
  const apiVersion = d.jsonText("payload", "graphics", "apiVersion");
  const shadingLanguage = d.jsonText("payload", "graphics", "shadingLanguage");
  return {
    query: `
      SELECT
        coalesce(${api}, '') AS api,
        coalesce(${backend}, '') AS backend,
        coalesce(${apiVersion}, '') AS api_version,
        coalesce(${shadingLanguage}, '') AS shading_language,
        count() AS sessions
      FROM events
      WHERE project_id = ${pid} AND event_type = 'session_start'${range}${scene}${session}
      GROUP BY api, backend, api_version, shading_language
      ORDER BY sessions DESC
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
 * Perf-correlated churn (#144): does a stutter actually cost sessions? Correlates
 * perf dips against early session end. Of the sessions that ended in range
 * (`sessions`), `churn_sessions` ended within `windowMs` of an FPS dip (a
 * `frame_perf` sample below `fpsThreshold`) or a `compile_stall` of at least
 * `stallMs` — the felt hitches that plausibly drove the user away, as opposed to
 * background noise that the perf-distribution panel averages over.
 *
 * Semantics — a session churns iff it has a `session_end` **and** at least one
 * qualifying dip whose timestamp lies in `[end - windowMs, end]` (its earliest
 * `session_end` is the anchor). `fps_churn_sessions` / `stall_churn_sessions`
 * attribute the cause; a session whose window held both is counted in each cause
 * column but only once in `churn_sessions`, so the cause columns can sum to more
 * than the total.
 *
 * Implementation — an `ends` CTE (each session's first `session_end`) joined to a
 * `dips` CTE (the qualifying `frame_perf` / `compile_stall` rows) on `session_id`,
 * with the window enforced through the dialect's `epochMs` so the timestamp math
 * is engine-neutral. This uses only `JOIN` / `min` / `max` / `count` — **no window
 * or ASOF functions** — so it renders identically on DuckDB (OSS) and ClickHouse
 * (scale tier). Aggregating over the (possibly empty) `correlated` set always
 * yields one row; the `sessions` denominator is an uncorrelated scalar sub-select
 * so it stands even when nothing churned. Privacy (ADR 0003): aggregate counts
 * only, no per-session identifiers leave the query.
 */
export function buildPerfChurn(
  projectId: string,
  opts: RangeOptions &
    SceneOptions &
    SessionOptions & {
      windowMs?: number;
      fpsThreshold?: number;
      stallMs?: number;
    },
  d: Dialect,
): QuerySpec {
  const bag = new ParamBag(d);
  const pid = bag.add("projectId", "string", projectId);
  const range = rangeClause(bag, opts);
  const scene = sceneClause(bag, opts);
  const session = sessionClause(bag, opts);
  const windowMs = bag.add("windowMs", "u32", opts.windowMs ?? 30_000);
  const fpsThreshold = bag.add("fpsThreshold", "f64", opts.fpsThreshold ?? 30);
  const stallMs = bag.add("stallMs", "f64", opts.stallMs ?? 100);
  const dipTs = d.epochMs("dips.ts");
  const endTs = d.epochMs("ends.end_ts");
  return {
    query: `
      WITH ends AS (
        SELECT session_id, min(ts) AS end_ts
        FROM events
        WHERE project_id = ${pid} AND event_type = 'session_end'${range}${scene}${session}
        GROUP BY session_id
      ),
      dips AS (
        SELECT
          session_id,
          ts,
          CASE WHEN event_type = 'frame_perf' THEN 1 ELSE 0 END AS is_fps,
          CASE WHEN event_type = 'compile_stall' THEN 1 ELSE 0 END AS is_stall
        FROM events
        WHERE project_id = ${pid}${range}${scene}${session}
          AND (
            (event_type = 'frame_perf' AND fps < ${fpsThreshold})
            OR (event_type = 'compile_stall' AND visible_ms >= ${stallMs})
          )
      ),
      correlated AS (
        SELECT
          ends.session_id AS session_id,
          max(dips.is_fps) AS had_fps,
          max(dips.is_stall) AS had_stall
        FROM ends JOIN dips ON ends.session_id = dips.session_id
        WHERE ${dipTs} <= ${endTs} AND ${dipTs} >= ${endTs} - ${windowMs}
        GROUP BY ends.session_id
      )
      SELECT
        (SELECT count() FROM ends) AS sessions,
        count() AS churn_sessions,
        sum(had_fps) AS fps_churn_sessions,
        sum(had_stall) AS stall_churn_sessions
      FROM correlated
    `,
    query_params: bag.values,
  };
}

/**
 * FPS segmented by device class, computed **per-session then aggregated** (ADR
 * 0028 §2). Each session's median FPS is attributed to the graphics backend,
 * mobile flag, and GPU `renderer` recorded in its `session_start.device` block,
 * plus the coarse `browser`/`os` families derived server-side from the
 * User-Agent at ingestion (ADR 0041) — all data already on the wire, so there is
 * no SDK or schema change. Device fields are read from the `session_start`
 * payload JSON (they are not promoted columns) and `coalesce`d to `''` when a
 * session never reported them. `p50_fps` is the median across sessions in the
 * group of each session's median FPS.
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
  const browser = d.jsonText("payload", "device", "browser");
  const os = d.jsonText("payload", "device", "os");
  return {
    query: `
      WITH session_device AS (
        SELECT
          session_id,
          ${engine} AS engine,
          ${isMobile} AS is_mobile,
          ${renderer} AS renderer,
          ${browser} AS browser,
          ${os} AS os
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
        coalesce(dev.browser, '') AS browser,
        coalesce(dev.os, '') AS os,
        count() AS sessions,
        sum(perf.s_samples) AS samples,
        ${d.quantile("perf.s_p50", 0.5)} AS p50_fps
      FROM session_perf perf
      LEFT JOIN session_device dev ON dev.session_id = perf.session_id
      GROUP BY engine, is_mobile, renderer, browser, os
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
 * Spatial FPS heatmap (#145): voxel-bin `frame_perf` samples by their captured
 * camera `position` into a uniform grid of `cellSize`-sized cubes, reporting each
 * occupied cell's sample count, mean FPS, and worst single FPS. This answers
 * *where* performance degrades ("FPS is bad in the boss room"), the spatial
 * complement to the time-bucketed {@link buildPerfDistribution}/{@link buildFpsHistogram}.
 *
 * It reads the same promoted `position` column the camera-position heatmaps use —
 * `frame_perf` now carries an optional camera position, filled by the connector at
 * sample time — so no join against the separately-sampled `camera_sample` stream is
 * needed. Rows are ordered worst-FPS-first so the capped top-`limit` slice surfaces
 * the jankiest cells rather than an arbitrary corner of the scene.
 */
export function buildPerfHeatmap(
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
  const limit = bag.add("limit", "u32", opts.limit ?? 2000);
  return {
    query: `
      SELECT
        floor(position[1] / ${cellSize}) AS vx,
        floor(position[2] / ${cellSize}) AS vy,
        floor(position[3] / ${cellSize}) AS vz,
        count() AS samples,
        avg(fps) AS avg_fps,
        min(fps) AS min_fps
      FROM events
      WHERE project_id = ${pid}
        AND event_type = 'frame_perf'
        AND length(position) = 3${range}${scene}${session}
      GROUP BY vx, vy, vz
      ORDER BY avg_fps ASC
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

/**
 * Path-retrace / backtracking ratio (#153): a confusion signal derived from the
 * same `camera_sample` position stream that feeds desire lines, surfaced as a
 * per-scene leaderboard. It answers "which areas do visitors keep re-walking?" —
 * a high backtrack ratio flags a dead end, a missed cue, or a puzzle that isn't
 * reading clearly.
 *
 * Algorithm — the coarse-grid revisit proxy (the cheap first cut, not true
 * reverse-segment retracing): bin each session's positions onto a `cellSize`
 * X/Z grid, then collapse consecutive samples in the same cell into ordered cell
 * *entries* (so standing still / dwelling never counts) via an ASOF self-join to
 * the immediately preceding sample. A row is an entry when it has no predecessor
 * (the session's first sample) or its cell differs from the predecessor's. The
 * `present` sentinel makes the unmatched-predecessor test engine-agnostic:
 * DuckDB null-fills a LEFT-join miss while ClickHouse zero-fills it, so `present`
 * (`1` only on a real match) is the portable "has a predecessor" flag.
 *
 * Per (session, scene): `revisits = entries − distinct_cells` — every entry into
 * a cell beyond its first is a re-entry. Pooled per scene, the leaderboard
 * reports `backtrack_ratio = Σ revisits / Σ entries` alongside the raw counts.
 * Only plain `count()` and a dedup subquery are used (no multi-column
 * `COUNT(DISTINCT …)`), so DuckDB and ClickHouse agree.
 */
export function buildBacktrackRatio(
  projectId: string,
  opts: RangeOptions & SceneOptions & SessionOptions & { cellSize?: number; limit?: number },
  d: Dialect,
): QuerySpec {
  const bag = new ParamBag(d);
  const pid = bag.add("projectId", "string", projectId);
  const cellSize = bag.add("cellSize", "f64", opts.cellSize ?? 2);
  const range = rangeClause(bag, opts);
  const scene = sceneClause(bag, opts);
  const session = sessionClause(bag, opts);
  const limit = bag.add("limit", "u32", opts.limit ?? 100);
  const sampleSelect = `
        SELECT session_id, scene_id AS scene, ts,
          floor(position[1] / ${cellSize}) AS gx,
          floor(position[3] / ${cellSize}) AS gz
        FROM events
        WHERE project_id = ${pid}
          AND event_type = 'camera_sample'
          AND length(position) = 3${range}${scene}${session}`;
  // Ordered cell entries (consecutive same-cell samples collapsed): a sample is
  // an entry when it has no predecessor or its cell changed vs. the predecessor.
  const entries = `
      SELECT c.session_id AS session_id, c.scene AS scene, c.gx AS gx, c.gz AS gz
      FROM (${sampleSelect}
      ) AS c
      ${d.asofLeftJoin} (
        SELECT session_id, ts, 1 AS present, gx, gz FROM (${sampleSelect}
        ) AS s
      ) AS m
      ON c.session_id = m.session_id AND c.ts > m.ts
      WHERE m.present IS NULL OR m.present = 0 OR c.gx <> m.gx OR c.gz <> m.gz`;
  return {
    query: `
      SELECT
        scene,
        count() AS sessions,
        sum(total_entries) AS entries,
        sum(revisits) AS revisits,
        CASE WHEN sum(total_entries) > 0
             THEN sum(revisits) * 1.0 / sum(total_entries) ELSE 0 END AS backtrack_ratio
      FROM (
        SELECT
          e.session_id AS session_id,
          e.scene AS scene,
          count() AS total_entries,
          count() - dc.distinct_cells AS revisits
        FROM (${entries}
        ) AS e
        JOIN (
          SELECT session_id, scene, count() AS distinct_cells
          FROM (
            SELECT DISTINCT session_id, scene, gx, gz FROM (${entries}
            ) AS de
          ) AS ded
          GROUP BY session_id, scene
        ) AS dc ON e.session_id = dc.session_id AND e.scene = dc.scene
        GROUP BY e.session_id, e.scene, dc.distinct_cells
      ) AS per_session
      GROUP BY scene
      ORDER BY backtrack_ratio DESC, entries DESC
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
 * XR locomotion & comfort (#148): per session that used an XR input source, its
 * locomotion-style breakdown and wall-clock span. This turns the existing
 * `camera_gesture` / `mesh_interaction` streams into a comfort signal for VR
 * developers — constant smooth `fly` locomotion (a motion-sickness risk) vs.
 * teleport-dominant sessions — and lets the consumer correlate heavy locomotion
 * with early exits (a short span, a discomfort / "rage-quit" proxy).
 *
 * A teleport emits **both** a `camera_gesture { kind: "fly" }` and a
 * `mesh_interaction { kind: "teleport" }` (ADR 0025), so `fly_gestures` counts
 * every fly (smooth + teleport) while `teleports` isolates the discrete jumps;
 * the consumer derives smooth locomotion as `fly_gestures - teleports`. Sessions
 * with no XR input are omitted entirely (same XR-session gate as
 * {@link buildXrAbandonment}). Wall-clock bounds are engine-specific and excluded
 * from parity; the counts are compared.
 */
export function buildXrLocomotionComfort(
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
        sum(CASE WHEN event_type = 'camera_gesture' AND name = 'fly' THEN 1 ELSE 0 END) AS fly_gestures,
        sum(CASE WHEN event_type = 'camera_gesture' AND name = 'navigate' THEN 1 ELSE 0 END) AS navigate_gestures,
        sum(CASE WHEN event_type = 'mesh_interaction' AND name = 'teleport' THEN 1 ELSE 0 END) AS teleports,
        sum(CASE WHEN event_type = 'camera_gesture' AND name IN ('fly', 'navigate') THEN visible_ms ELSE 0 END) AS locomotion_ms,
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
      ORDER BY locomotion_ms DESC
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

/**
 * Canned scene/level retention funnel (#147): session counts flowing scene →
 * scene in the order they were observed, built directly from `scene_change`
 * markers with **no caller-authored steps** (the zero-config complement to the
 * ADR 0038 funnel). Each `scene_change` envelope carries the scene now active in
 * `scene_id`, so a session's ordered `scene_change` targets are the levels it
 * moved through; every **consecutive pair** is a directed link.
 *
 * Semantics — for one session, order its `scene_change` events by `ts`; the link
 * `A → B` exists whenever `B`'s marker is the *next* `scene_change` after an `A`
 * marker. A link's weight is the number of **distinct sessions** that made that
 * consecutive transition, so it reads as level-to-level retention. Sessions with
 * a single `scene_change` contribute no link (there is no "from").
 *
 * Implementation — `sc` is the per-session ordered `scene_change` stream; `nxt`
 * finds, for each marker, the timestamp of the very next marker in the same
 * session via a self-join + `MIN` (no window/ASOF functions, so it renders
 * identically on DuckDB and ClickHouse — the same parity discipline as
 * {@link buildFunnel}); joining that back to `sc` resolves the `to_scene`. The
 * final `GROUP BY` counts distinct sessions per `(from_scene, to_scene)` pair.
 * A same-timestamp tie between two markers can fan out to multiple `to` rows;
 * this is a benign edge case for a preset over human-paced scene switches.
 */
export function buildSceneRetention(
  projectId: string,
  opts: SceneRetentionOptions,
  d: Dialect,
): QuerySpec {
  const bag = new ParamBag(d);
  const pid = bag.add("projectId", "string", projectId);
  const range = rangeClause(bag, opts);
  const limit = bag.add("limit", "u32", opts.limit ?? 100);

  return {
    query: `
      WITH sc AS (
        SELECT session_id, ts, scene_id
        FROM events
        WHERE project_id = ${pid} AND event_type = 'scene_change'${range}
      ),
      nxt AS (
        SELECT a.session_id AS session_id, a.ts AS from_ts, a.scene_id AS from_scene,
               min(b.ts) AS to_ts
        FROM sc a JOIN sc b ON b.session_id = a.session_id AND b.ts > a.ts
        GROUP BY a.session_id, a.ts, a.scene_id
      ),
      links AS (
        SELECT nxt.session_id AS session_id, nxt.from_scene AS from_scene,
               sc.scene_id AS to_scene
        FROM nxt JOIN sc ON sc.session_id = nxt.session_id AND sc.ts = nxt.to_ts
      )
      SELECT from_scene, to_scene, count(DISTINCT session_id) AS sessions
      FROM links
      GROUP BY from_scene, to_scene
      ORDER BY sessions DESC, from_scene ASC, to_scene ASC
      LIMIT ${limit}
    `,
    query_params: bag.values,
  };
}
