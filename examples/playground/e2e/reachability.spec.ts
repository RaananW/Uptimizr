import { expect, test, type APIRequestContext, type Page } from "@playwright/test";

import { API_KEY, COLLECTOR_URL, DASHBOARD_URL, PROJECT_ID } from "./constants.js";
import { waitForEventTypes } from "./helpers/capture.js";

/**
 * Full-stack spec for the reachability report (#151). The graph derives a
 * per-mesh histogram of the distance between where a user stood (the click-time
 * `camera_sample` position) and the world point they interacted with — it needs
 * no schema change, only existing `camera_sample` + `mesh_interaction` events.
 *
 * We seed a single session straight to the public ingest endpoint (one camera
 * standpoint at the origin, then two mesh interactions — one near, one far) and
 * exercise the same collector → DuckDB → query API → dashboard path the SDK would,
 * rather than driving a full engine session, which would flood the shared ingest
 * rate-limiter and starve sibling specs. The ASOF join pins both interactions to
 * the one preceding camera sample, so the distances (and therefore the buckets)
 * are exact.
 */

interface ReachabilityBin {
  mesh: string;
  bucket: number;
  count: number;
  avg_distance: number;
}

const BUCKET_SIZE = 0.5;

async function getJson<T>(request: APIRequestContext, url: string): Promise<T> {
  const res = await request.get(url, { headers: { "x-api-key": API_KEY } });
  expect(res.ok(), `${url} should succeed (got ${res.status()}: ${await res.text()})`).toBeTruthy();
  return (await res.json()) as T;
}

async function seedReachability(
  request: APIRequestContext,
  sessionId: string,
  nearMesh: string,
  farMesh: string,
): Promise<void> {
  const now = Date.now();
  const res = await request.post(`${COLLECTOR_URL}/api/v1/collect`, {
    data: {
      events: [
        // The standpoint: one camera sample at the origin, before either click.
        {
          type: "camera_sample" as const,
          projectId: PROJECT_ID,
          sessionId,
          sdkVersion: "0.0.0-e2e",
          ts: now,
          position: [0, 0, 0],
          direction: [0, 0, 1],
        },
        // Near interaction: 0.3 world units away → bucket floor(0.3 / 0.5) = 0.
        {
          type: "mesh_interaction" as const,
          projectId: PROJECT_ID,
          sessionId,
          sdkVersion: "0.0.0-e2e",
          ts: now + 10,
          mesh: nearMesh,
          kind: "pick" as const,
          point: [0.3, 0, 0],
        },
        // Far interaction: 3 world units away → bucket floor(3 / 0.5) = 6.
        {
          type: "mesh_interaction" as const,
          projectId: PROJECT_ID,
          sessionId,
          sdkVersion: "0.0.0-e2e",
          ts: now + 20,
          mesh: farMesh,
          kind: "pick" as const,
          point: [3, 0, 0],
        },
      ],
    },
  });
  expect(
    res.ok(),
    `seeding reachability events should succeed (got ${res.status()}: ${await res.text()})`,
  ).toBeTruthy();
}

async function loadDashboard(page: Page): Promise<void> {
  await page.goto(DASHBOARD_URL);
  await page.getByPlaceholder("http://localhost:4318").fill(COLLECTOR_URL);
  await page.getByPlaceholder("utk_…").fill(API_KEY);
  await page.getByRole("button", { name: /load/i }).click();
}

test("reachability report histograms per-mesh interaction distance and flags far meshes", async ({
  page,
  request,
}) => {
  const run = Date.now();
  const sessionId = `e2e-reach-${run}`;
  const nearMesh = `reach-near-${run}`;
  const farMesh = `reach-far-${run}`;

  await seedReachability(request, sessionId, nearMesh, farMesh);
  await waitForEventTypes(request, sessionId, ["camera_sample", "mesh_interaction"]);

  // 1) API: poll until both interactions have flushed + aggregated into bins.
  let bins: ReachabilityBin[] = [];
  await expect
    .poll(
      async () => {
        bins = await getJson<ReachabilityBin[]>(
          request,
          `${COLLECTOR_URL}/api/v1/meshes/reachability?session=${sessionId}&bucketSize=${BUCKET_SIZE}`,
        );
        return bins.length;
      },
      { timeout: 20_000 },
    )
    .toBe(2);

  const near = bins.find((b) => b.mesh === nearMesh);
  const far = bins.find((b) => b.mesh === farMesh);
  expect(near, "the near mesh should have a distance bin").toBeTruthy();
  expect(far, "the far mesh should have a distance bin").toBeTruthy();
  // Buckets are exact because both clicks ASOF-join to the single origin sample.
  expect(near!.bucket).toBe(0);
  expect(near!.count).toBe(1);
  expect(Number(near!.avg_distance)).toBeCloseTo(0.3, 4);
  expect(far!.bucket).toBe(6);
  expect(far!.count).toBe(1);
  expect(Number(far!.avg_distance)).toBeCloseTo(3, 4);

  // 2) Dashboard: the reachability panel renders real bins (not the empty state)
  //    and surfaces the far mesh with an out-of-reach flag.
  await loadDashboard(page);

  const panel = page
    .locator("section")
    .filter({ has: page.getByRole("heading", { name: "Reachability report" }) })
    .last();
  await expect(panel.getByRole("heading", { name: "Reachability report" })).toBeVisible({
    timeout: 20_000,
  });
  await expect(panel.getByText(/meshes are reached from beyond/)).toBeVisible();
  await expect(panel.getByText("No measurable interactions in range.")).toHaveCount(0);
});
