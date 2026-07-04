import { expect, test, type APIRequestContext } from "@playwright/test";

import { API_KEY, COLLECTOR_URL } from "./constants.js";
import { bootEngine, enableAllCapture, waitForEventTypes } from "./helpers/capture.js";

/**
 * Per-mesh texture-space (UV) heatmap (issue #149), end to end. A real Babylon
 * session picks a mesh at the canvas centre; the connector reads the raycast hit's
 * UV coordinate (`PickingInfo.getTextureCoordinates()`) and attaches it as an
 * optional `uv` on the resulting `pointer_click` / `mesh_interaction`. The spec
 * then drives the full browser → SDK → collector → DuckDB round trip that the
 * unit/parity tests can't:
 *
 * - the captured `uv` survives the store round trip (visible on the raw event); and
 * - `GET /api/v1/heatmaps/mesh-uv?mesh=…` bins that `uv` into a grid whose cell
 *   indices fall inside the requested `bins × bins` range.
 *
 * Babylon is the reference capture surface (its `getTextureCoordinates` is what the
 * connector reads); the playground's box meshes carry UVs by construction.
 */

interface StoredEvent {
  type: string;
  ts: number;
  mesh?: string;
  hitMesh?: string;
  uv?: [number, number];
}

interface HeatmapBin {
  gx: number;
  gy: number;
  count: number;
}

const BINS = 16;

async function getJson<T>(request: APIRequestContext, url: string): Promise<T> {
  const res = await request.get(url, { headers: { "x-api-key": API_KEY } });
  expect(res.ok(), `${url} should succeed (got ${res.status()}: ${await res.text()})`).toBeTruthy();
  return (await res.json()) as T;
}

test("mesh UV heatmap bins captured texture coordinates for a picked mesh", async ({
  page,
  request,
}) => {
  // 1) Boot a real capturing session and click the canvas centre so the ray hits
  //    the central mesh, yielding a `mesh_interaction` (+ `pointer_click`) whose
  //    hit carries a UV coordinate.
  await enableAllCapture(page, "babylon");
  const sessionId = await bootEngine(page, "babylon");
  const { width, height } = page.viewportSize() ?? { width: 1280, height: 720 };
  await page.mouse.move(Math.round(width * 0.5), Math.round(height * 0.52), { steps: 4 });
  await page.mouse.click(Math.round(width * 0.5), Math.round(height * 0.52));

  await waitForEventTypes(request, sessionId, ["mesh_interaction", "pointer_click"]);

  // 2) Read the stored timeline back and isolate an interaction that captured a UV.
  const events = await getJson<StoredEvent[]>(
    request,
    `${COLLECTOR_URL}/api/v1/sessions/${sessionId}/events`,
  );

  const withUv = events.filter(
    (e) =>
      (e.type === "mesh_interaction" || e.type === "pointer_click") &&
      Array.isArray(e.uv) &&
      e.uv.length === 2 &&
      Number.isFinite(e.uv[0]) &&
      Number.isFinite(e.uv[1]),
  );
  expect(withUv.length, "at least one interaction should carry a captured uv").toBeGreaterThan(0);

  const mesh = withUv[0].mesh ?? withUv[0].hitMesh;
  expect(mesh, "the interaction with a uv should name its mesh").toBeTruthy();

  // 3) Poll the mesh-uv heatmap until the interaction has flushed + aggregated, then
  //    assert the returned bins reference the requested grid.
  let bins: HeatmapBin[] = [];
  await expect
    .poll(
      async () => {
        bins = await getJson<HeatmapBin[]>(
          request,
          `${COLLECTOR_URL}/api/v1/heatmaps/mesh-uv?session=${sessionId}` +
            `&mesh=${encodeURIComponent(mesh as string)}&bins=${BINS}`,
        );
        return bins.reduce((sum, b) => sum + Number(b.count), 0);
      },
      { timeout: 20_000 },
    )
    .toBeGreaterThan(0);

  for (const b of bins) {
    expect(Number(b.gx)).toBeGreaterThanOrEqual(0);
    expect(Number(b.gx)).toBeLessThan(BINS);
    expect(Number(b.gy)).toBeGreaterThanOrEqual(0);
    expect(Number(b.gy)).toBeLessThan(BINS);
    expect(Number(b.count)).toBeGreaterThan(0);
  }

  // 4) A mesh with no interactions returns an empty grid (the filter is honoured).
  const empty = await getJson<HeatmapBin[]>(
    request,
    `${COLLECTOR_URL}/api/v1/heatmaps/mesh-uv?session=${sessionId}` +
      `&mesh=__no_such_mesh__&bins=${BINS}`,
  );
  expect(empty).toEqual([]);
});
