import { expect, test, type APIRequestContext, type Page } from "@playwright/test";

import { API_KEY, COLLECTOR_URL, DASHBOARD_URL, PROJECT_ID } from "./constants.js";

/**
 * Full-stack spec for the **Scene health score** tile (#307, ADR 0051 §4).
 *
 * `insight_scene_health` is the only panel whose value depends on *two* windows:
 * it normalises every factor against the project's own baseline over the
 * preceding equal window. A tile seeded with today's data alone would correctly
 * render "—" for every factor, which proves nothing. So the spec seeds both
 * sides: several healthy batches inside the baseline window, and one bad batch
 * now.
 *
 * The baseline offsets are chosen so they land in the baseline window for **any
 * hour of the day the suite happens to run at**. With the dashboard's "Last 24h"
 * preset the scored range is `[yesterday 00:00, tomorrow 00:00)` and the
 * baseline is the two days before it, so an offset of 48-72 hours is inside the
 * baseline for every possible `now` while an offset of 30 hours is not.
 *
 * Events are seeded by batched POSTs to the public ingest endpoint rather than
 * driven through a real engine: neither a 20 FPS frame nor an uncaught error can
 * be produced deterministically in the headless runner, and the seeded path is
 * the same browser → collector → DuckDB → query API → dashboard round trip the
 * SDK would take. One POST per batch keeps the shared ingest rate-limiter happy.
 */

const HOUR = 3_600_000;
/** The scene this spec owns. Distinct from every other spec's, so runs cannot collide. */
const SCENE = "health-scene";

/** Offsets (hours before now) that are inside the baseline window whatever the hour. */
const BASELINE_OFFSETS_H = [48, 54, 60, 66, 72];

/** One session's worth of events: perf, a click, a camera sample, optionally an error. */
function batch(
  sessionId: string,
  ts: number,
  health: { fps: number; longFrames: number; deadClick: boolean; error: boolean },
): Record<string, unknown>[] {
  const base = { projectId: PROJECT_ID, sessionId, sdkVersion: "0.0.0-e2e", sceneId: SCENE };
  const events: Record<string, unknown>[] = [
    {
      ...base,
      type: "session_start",
      ts,
      scene: { cameraType: "arc-rotate", cameraName: "cam", meshCount: 3 },
      device: { engine: "webgl2", renderer: "SwiftShader", isMobile: false },
    },
  ];
  for (let i = 0; i < 4; i += 1) {
    events.push({
      ...base,
      type: "frame_perf",
      ts: ts + 1_000 + i,
      fps: health.fps,
      frameTimeMs: 1000 / health.fps,
      frameTimeP95Ms: 2000 / health.fps,
      longFrames: health.longFrames,
      dpr: 1,
      renderScale: 1,
      position: [0, 1, 0],
    });
  }
  events.push({
    ...base,
    type: "pointer_click",
    ts: ts + 2_000,
    screen: [0.5, 0.5],
    button: 0,
    source: "mouse",
    ...(health.deadClick ? {} : { hitMesh: "box", hitPoint: [1, 1, 1], uv: [0.5, 0.5] }),
  });
  events.push({
    ...base,
    type: "camera_sample",
    ts: ts + 3_000,
    position: [1, 1, 1],
    direction: [0, 0, 1],
  });
  if (health.error) {
    events.push({ ...base, type: "runtime_error", ts: ts + 4_000, kind: "error", message: "boom" });
  }
  return events;
}

async function seed(request: APIRequestContext, events: Record<string, unknown>[]): Promise<void> {
  const res = await request.post(`${COLLECTOR_URL}/api/v1/collect`, { data: { events } });
  expect(
    res.ok(),
    `seeding should succeed (got ${res.status()}: ${await res.text()})`,
  ).toBeTruthy();
}

async function loadDashboard(page: Page): Promise<void> {
  await page.goto(DASHBOARD_URL);
  await page.getByPlaceholder("http://localhost:4318").fill(COLLECTOR_URL);
  await page.getByPlaceholder("utk_…").fill(API_KEY);
  await page.getByRole("button", { name: /load/i }).click();
  // "Last 24h" makes the scored window the last two whole days, so the baseline
  // window is the two days the healthy batches were seeded into.
  await page.getByRole("button", { name: "Last 24h" }).click();
}

test("scene health tile scores a regressed scene against its own baseline", async ({
  page,
  request,
}) => {
  const now = Date.now();
  const run = `e2e-health-${now}`;

  // A healthy past: 60 FPS, no long frames, every click hits, no errors.
  for (const [index, hours] of BASELINE_OFFSETS_H.entries()) {
    await seed(
      request,
      batch(`${run}-base-${index}`, now - hours * HOUR, {
        fps: 60,
        longFrames: 0,
        deadClick: false,
        error: false,
      }),
    );
  }
  // A bad now: 20 FPS, long frames, a click that hit nothing, and an error.
  await seed(
    request,
    batch(`${run}-now`, now - 60_000, { fps: 20, longFrames: 6, deadClick: true, error: true }),
  );

  await loadDashboard(page);

  const panel = page
    .locator("section")
    .filter({ has: page.getByRole("heading", { name: "Scene health score" }) })
    .last();
  await expect(panel.getByRole("heading", { name: "Scene health score" })).toBeVisible({
    timeout: 20_000,
  });

  const row = panel.locator(`[data-testid="scene-health-row"][data-scene="${SCENE}"]`);
  await expect(row).toBeVisible({ timeout: 20_000 });

  // The headline is a real score, not the "—" of a scene with no baseline.
  const score = row.locator('[data-testid="scene-health-score"]');
  await expect(score).toBeVisible();
  await expect(score).toHaveText(/^\d+$/);

  // …and it is traceable: the perf factor names the metric behind it, and the
  // regression puts it below the project norm of 50.
  const perf = row.locator('[data-testid="health-factor-perf_stability"]');
  await expect(perf).toHaveAttribute("data-metric", "perf_summary");
  const perfScore = Number(await perf.locator("span").last().innerText());
  expect(perfScore).toBeLessThan(50);
});
