import { expect, test, type APIRequestContext } from "@playwright/test";

import { API_KEY, COLLECTOR_URL } from "./constants.js";
import {
  bootEngine,
  driveInteractions,
  enableAllCapture,
  waitForEventTypes,
} from "./helpers/capture.js";

/**
 * Large-scene spatial resolution (ADR 0040) end to end. A real capturing Babylon
 * session produces world-space pointer hits; this spec then exercises the three
 * query-side additions that keep big scenes legible — over the full browser →
 * SDK → collector → DuckDB round trip that the unit/integration tests can't:
 *
 * - `GET /api/v1/heatmaps/world/stats` (§3) — the **true** occupied-cell + hit
 *   totals behind the truncated top-N voxel list, plus the effective `cellSize`.
 * - `region=minX,minY,minZ,maxX,maxY,maxZ` (§4) — AABB drill-down on the world
 *   heatmap and its stats (a box around the data keeps every hit; a far box drops
 *   them all).
 * - bounds-driven `cellSize` (§1) — omitting `cellSize` still yields a positive
 *   effective cell size on the stats endpoint.
 *
 * Babylon is the subject connector (the reference capture surface). The spec
 * pins an explicit `cellSize` for the voxel/region math so the assertions are
 * deterministic regardless of the harness scene's registered bounds.
 */

interface WorldVoxel {
  vx: number;
  vy: number;
  vz: number;
  count: number;
}
interface SpatialStats {
  cellSize: number;
  cells: number;
  hits: number;
}

const CELL = 0.5;

function worldQuery(sessionId: string, extra = ""): string {
  return `${COLLECTOR_URL}/api/v1/heatmaps/world?session=${sessionId}&cellSize=${CELL}${extra}`;
}
function worldStatsQuery(sessionId: string, extra = ""): string {
  return `${COLLECTOR_URL}/api/v1/heatmaps/world/stats?session=${sessionId}&cellSize=${CELL}${extra}`;
}

async function getJson<T>(request: APIRequestContext, url: string): Promise<T> {
  const res = await request.get(url, { headers: { "x-api-key": API_KEY } });
  expect(res.ok(), `${url} should succeed (got ${res.status()}: ${await res.text()})`).toBeTruthy();
  return (await res.json()) as T;
}

test("world heatmap exposes true totals, region drill-down, and a derived cellSize", async ({
  page,
  request,
}) => {
  // 1) Boot a real capturing session and synthesize a center mesh pick, which
  //    yields at least one world-space `pointer_click` hit_point.
  await enableAllCapture(page, "babylon");
  const sessionId = await bootEngine(page, "babylon");
  await driveInteractions(page, { keyboard: false });
  await waitForEventTypes(request, sessionId, ["pointer_click"]);

  // 2) The world heatmap returns occupied voxels for this session. Poll until the
  //    mesh-pick hit has flushed and aggregated.
  let world: WorldVoxel[] = [];
  await expect
    .poll(
      async () => {
        world = await getJson<WorldVoxel[]>(request, worldQuery(sessionId));
        return world.length;
      },
      { timeout: 20_000 },
    )
    .toBeGreaterThan(0);

  const totalHits = world.reduce((sum, v) => sum + v.count, 0);

  // 3) Stats report the real cell/hit totals behind the (here untruncated) list.
  const stats = await getJson<SpatialStats>(request, worldStatsQuery(sessionId));
  expect(stats.cellSize).toBe(CELL);
  expect(stats.cells).toBe(world.length);
  expect(stats.hits).toBe(totalHits);
  expect(stats.cells).toBeGreaterThan(0);
  expect(stats.hits).toBeGreaterThanOrEqual(stats.cells);

  // 4) Region drill-down. A box around every occupied voxel keeps all of them…
  const axisMin = (k: "vx" | "vy" | "vz") => Math.min(...world.map((v) => v[k])) * CELL - CELL;
  const axisMax = (k: "vx" | "vy" | "vz") => (Math.max(...world.map((v) => v[k])) + 1) * CELL + CELL;
  const inBox = [axisMin("vx"), axisMin("vy"), axisMin("vz"), axisMax("vx"), axisMax("vy"), axisMax("vz")].join(",");
  const statsIn = await getJson<SpatialStats>(
    request,
    worldStatsQuery(sessionId, `&region=${inBox}`),
  );
  expect(statsIn.cells).toBe(stats.cells);
  expect(statsIn.hits).toBe(stats.hits);

  // …and a far-away box excludes them all (both the voxel list and the totals).
  const farBox = "100000,100000,100000,100001,100001,100001";
  const worldFar = await getJson<WorldVoxel[]>(request, worldQuery(sessionId, `&region=${farBox}`));
  expect(worldFar.length).toBe(0);
  const statsFar = await getJson<SpatialStats>(
    request,
    worldStatsQuery(sessionId, `&region=${farBox}`),
  );
  expect(statsFar.cells).toBe(0);
  expect(statsFar.hits).toBe(0);

  // 5) A malformed region is rejected at the query boundary.
  const bad = await request.get(`${COLLECTOR_URL}/api/v1/heatmaps/world?session=${sessionId}&region=1,2,3`, {
    headers: { "x-api-key": API_KEY },
  });
  expect(bad.status()).toBe(400);

  // 6) Omitting cellSize still resolves to a positive effective cell size (ADR
  //    0040 §1 — derived from scene/region bounds, or the fixed default).
  const auto = await getJson<SpatialStats>(
    request,
    `${COLLECTOR_URL}/api/v1/heatmaps/world/stats?session=${sessionId}`,
  );
  expect(auto.cellSize).toBeGreaterThan(0);

  // 7) The gaze stats sibling answers over the same path with a valid shape.
  const gazeStats = await getJson<SpatialStats>(
    request,
    `${COLLECTOR_URL}/api/v1/heatmaps/gaze/stats?session=${sessionId}`,
  );
  expect(gazeStats.cellSize).toBeGreaterThan(0);
  expect(gazeStats.cells).toBeGreaterThanOrEqual(0);
  expect(gazeStats.hits).toBeGreaterThanOrEqual(0);
});
