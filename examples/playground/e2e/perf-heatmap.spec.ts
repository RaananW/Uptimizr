import { expect, test, type APIRequestContext } from "@playwright/test";

import { API_KEY, COLLECTOR_URL, DASHBOARD_URL } from "./constants.js";
import {
  bootEngine,
  driveInteractions,
  enableAllCapture,
  waitForEventTypes,
} from "./helpers/capture.js";

/**
 * Spatial FPS heatmap (#145), end to end. `frame_perf` now optionally carries the
 * tracked camera's world `position`, which the collector voxel-bins into a
 * "where is FPS bad" map at `GET /api/v1/heatmaps/perf`. This drives the full
 * browser → SDK → collector → DuckDB round trip the unit/parity tests can't:
 *
 * - the Babylon connector stamps `position` onto each `frame_perf` sample from the
 *   same tracked camera as `camera_sample`, and it survives the store round trip;
 * - the perf-heatmap aggregation returns per-voxel `samples`/`avg_fps`/`min_fps`
 *   consistent with the stored samples; and
 * - the dashboard renders the captured data as the "Performance heatmap (3D)"
 *   panel.
 */

interface PerfVoxel {
  vx: number;
  vy: number;
  vz: number;
  samples: number;
  avg_fps: number;
  min_fps: number;
}

interface StoredEvent {
  type: string;
  ts: number;
  fps?: number;
  position?: [number, number, number];
}

const CELL = 0.5;

async function getJson<T>(request: APIRequestContext, url: string): Promise<T> {
  const res = await request.get(url, { headers: { "x-api-key": API_KEY } });
  expect(res.ok(), `${url} should succeed (got ${res.status()}: ${await res.text()})`).toBeTruthy();
  return (await res.json()) as T;
}

test("frame_perf position powers the spatial FPS heatmap end to end", async ({ page, request }) => {
  // 1) Boot a real capturing session and move the camera around so perf samples
  //    land at more than one position.
  await enableAllCapture(page, "babylon");
  const sessionId = await bootEngine(page, "babylon");
  await driveInteractions(page, { keyboard: true });
  await waitForEventTypes(request, sessionId, ["frame_perf", "camera_sample"]);

  // 2) Read the timeline back: at least one frame_perf sample must carry a
  //    3-component position (the new capture path), and it survived the round trip.
  const events = await getJson<StoredEvent[]>(
    request,
    `${COLLECTOR_URL}/api/v1/sessions/${sessionId}/events`,
  );
  const positioned = events.filter(
    (e) => e.type === "frame_perf" && e.position?.length === 3 && typeof e.fps === "number",
  );
  expect(
    positioned.length,
    "at least one frame_perf sample should carry a captured camera position",
  ).toBeGreaterThan(0);

  // 3) Poll the perf heatmap until the samples have flushed + aggregated, then
  //    assert the voxel shape is honest: real samples, and 0 < min_fps ≤ avg_fps.
  let voxels: PerfVoxel[] = [];
  await expect
    .poll(
      async () => {
        voxels = await getJson<PerfVoxel[]>(
          request,
          `${COLLECTOR_URL}/api/v1/heatmaps/perf?session=${sessionId}&cellSize=${CELL}`,
        );
        return voxels.length;
      },
      { timeout: 20_000 },
    )
    .toBeGreaterThan(0);

  const totalSamples = voxels.reduce((n, v) => n + Number(v.samples), 0);
  expect(totalSamples, "voxel sample counts should account for the captured frame_perf").toBe(
    positioned.length,
  );
  for (const v of voxels) {
    expect(Number(v.samples)).toBeGreaterThan(0);
    expect(Number(v.min_fps)).toBeGreaterThan(0);
    expect(Number(v.min_fps)).toBeLessThanOrEqual(Number(v.avg_fps) + 1e-9);
  }

  // 4) The dashboard renders the captured data as the Performance heatmap (3D)
  //    panel. We don't assert WebGL pixels (3D output isn't meaningfully
  //    assertable); we verify the panel mounts against real data with a canvas.
  await page.goto(DASHBOARD_URL);
  await page.getByPlaceholder("http://localhost:4318").fill(COLLECTOR_URL);
  await page.getByPlaceholder("utk_…").fill(API_KEY);
  await page.getByRole("button", { name: /load/i }).click();

  const perf = page.locator("section", { hasText: "Performance heatmap (3D)" }).first();
  await perf.scrollIntoViewIfNeeded();
  await expect(perf.getByRole("heading", { name: "Performance heatmap (3D)" })).toBeVisible({
    timeout: 20_000,
  });
  await expect(perf.locator("canvas").first()).toBeVisible();
});
