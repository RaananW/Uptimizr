import { expect, test, type APIRequestContext } from "@playwright/test";

import { API_KEY, COLLECTOR_URL } from "./constants.js";
import { bootEngine, enableAllCapture, waitForEventTypes } from "./helpers/capture.js";

/**
 * Near-plane origin reconstruction for flat-pointer click rays (issue #22 /
 * ADR 0041), end to end. A real Babylon session captures the camera's projection
 * intrinsics (`fov`/`aspect`/`near`) and a flat (mouse) `pointer_click`; the
 * collector's `/heatmaps/click-rays` aggregation then unprojects that click's
 * `screen` onto the camera near plane instead of collapsing it to the camera
 * point. This drives the full browser → SDK → collector → DuckDB round trip that
 * the unit/parity tests can't:
 *
 * - the SDK now emits `aspect` + `near` (alongside the existing `fov`) on
 *   `camera_sample`, and they survive the store round trip; and
 * - the click-ray origin returned by the API equals the near-plane reconstruction
 *   computed from the *same* stored camera sample the ASOF join uses — and is
 *   therefore offset from the raw camera position (the legacy fallback), proving
 *   reconstruction is live rather than the camera-point collapse.
 *
 * Babylon is the reference capture surface. The spec replicates the collector's
 * ASOF join locally (latest `camera_sample` at or before the click) so the
 * expected origin is exact regardless of any idle camera drift.
 */

interface ClickRay {
  origin_x: number;
  origin_y: number;
  origin_z: number;
  mesh: string;
  count: number;
}

interface StoredEvent {
  type: string;
  ts: number;
  position?: [number, number, number];
  direction?: [number, number, number];
  fov?: number;
  aspect?: number;
  near?: number;
  screen?: [number, number];
  hitPoint?: [number, number, number];
}

const CELL = 0.5;

async function getJson<T>(request: APIRequestContext, url: string): Promise<T> {
  const res = await request.get(url, { headers: { "x-api-key": API_KEY } });
  expect(res.ok(), `${url} should succeed (got ${res.status()}: ${await res.text()})`).toBeTruthy();
  return (await res.json()) as T;
}

/**
 * The exact near-plane unproject the collector's `buildClickGazeRay` applies for a
 * flat pointer: canonical world-up `(0,1,0)`, no roll. Mirrors the SQL term for
 * term so the assertion validates the real query, not a paraphrase.
 */
function reconstructNearPlaneOrigin(
  cam: Required<Pick<StoredEvent, "position" | "direction" | "fov" | "aspect" | "near">>,
  screen: [number, number],
): [number, number, number] {
  const [px, py, pz] = cam.position;
  const [dx, dy, dz] = cam.direction;
  const [sx, sy] = screen;
  const dlen = Math.sqrt(dx * dx + dy * dy + dz * dz);
  const hlen = Math.sqrt(dx * dx + dz * dz);
  const offR = (2 * sx - 1) * cam.near * Math.tan(cam.fov / 2) * cam.aspect;
  const offU = (1 - 2 * sy) * cam.near * Math.tan(cam.fov / 2);
  return [
    px + (dx * cam.near) / dlen + (dz / hlen) * offR + (-(dx * dy) / (dlen * hlen)) * offU,
    py + (dy * cam.near) / dlen + (hlen / dlen) * offU,
    pz + (dz * cam.near) / dlen + (-dx / hlen) * offR + (-(dy * dz) / (dlen * hlen)) * offU,
  ];
}

test("flat-pointer click rays reconstruct the camera near-plane origin", async ({
  page,
  request,
}) => {
  // 1) Boot a real capturing session, then synthesize a single flat (mouse) click
  //    at the canvas centre so it lands on the lobby's central mesh — that yields
  //    exactly one `pointer_click` with a 3-component `hit_point` (the click-ray
  //    query drops clicks that miss geometry).
  await enableAllCapture(page, "babylon");
  const sessionId = await bootEngine(page, "babylon");
  const { width, height } = page.viewportSize() ?? { width: 1280, height: 720 };
  await page.mouse.move(Math.round(width * 0.5), Math.round(height * 0.52), { steps: 4 });
  await page.mouse.click(Math.round(width * 0.5), Math.round(height * 0.52));

  await waitForEventTypes(request, sessionId, ["camera_sample", "pointer_click"]);

  // 2) Read the stored timeline back and isolate the flat click that hit geometry.
  const events = (await getJson<StoredEvent[]>(
    request,
    `${COLLECTOR_URL}/api/v1/sessions/${sessionId}/events`,
  )) as StoredEvent[];

  const clicks = events.filter(
    (e) => e.type === "pointer_click" && e.screen?.length === 2 && e.hitPoint?.length === 3,
  );
  expect(clicks.length, "exactly one flat click should have hit the central mesh").toBe(1);
  const click = clicks[0];

  // 3) Replicate the collector's ASOF join: the latest `camera_sample` carrying a
  //    position at or before the click is the one the origin is reconstructed from.
  const joined = events
    .filter((e) => e.type === "camera_sample" && e.position?.length === 3 && e.ts <= click.ts)
    .sort((a, b) => b.ts - a.ts)[0];
  expect(joined, "the click should ASOF-join to a preceding camera_sample").toBeTruthy();

  // The new capture path: aspect + near reached the store alongside fov, all finite
  // and positive (otherwise reconstruction would silently fall back).
  expect(typeof joined.fov).toBe("number");
  expect(joined.fov as number).toBeGreaterThan(0);
  expect(typeof joined.aspect).toBe("number");
  expect(joined.aspect as number).toBeGreaterThan(0);
  expect(typeof joined.near).toBe("number");
  expect(joined.near as number).toBeGreaterThan(0);

  const expected = reconstructNearPlaneOrigin(
    {
      position: joined.position!,
      direction: joined.direction!,
      fov: joined.fov!,
      aspect: joined.aspect!,
      near: joined.near!,
    },
    click.screen!,
  );

  // 4) Poll the click-ray heatmap until the click has flushed + aggregated, then
  //    assert the API origin equals the near-plane reconstruction term for term.
  let rays: ClickRay[] = [];
  await expect
    .poll(
      async () => {
        rays = await getJson<ClickRay[]>(
          request,
          `${COLLECTOR_URL}/api/v1/heatmaps/click-rays?session=${sessionId}&cellSize=${CELL}`,
        );
        return rays.length;
      },
      { timeout: 20_000 },
    )
    .toBe(1);

  const ray = rays[0];
  expect(ray.count).toBe(1);
  expect(Number(ray.origin_x)).toBeCloseTo(expected[0], 4);
  expect(Number(ray.origin_y)).toBeCloseTo(expected[1], 4);
  expect(Number(ray.origin_z)).toBeCloseTo(expected[2], 4);

  // 5) Sanity: reconstruction is genuinely different from the legacy fallback (the
  //    raw camera position). The origin sits ~`near` out along the view ray, so the
  //    distance must be on that order, not zero.
  const [px, py, pz] = joined.position!;
  const dist = Math.hypot(
    Number(ray.origin_x) - px,
    Number(ray.origin_y) - py,
    Number(ray.origin_z) - pz,
  );
  expect(dist).toBeGreaterThan(joined.near! * 0.5);
});
