import { expect, test } from "@playwright/test";
import { API_KEY, COLLECTOR_URL, FULL_FLOW_ENGINES } from "./constants.js";
import { openControls } from "./helpers/capture.js";

/** The envelope fields this spec asserts on (a loose view of `AnyEvent`). */
interface CapturedEvent {
  type: string;
  sessionId: string;
  sceneId?: string;
  source?: string;
}

// The consolidated playground serves every engine from one app; `?engine=<id>`
// selects which one boots (it wins over the persisted localStorage choice). Each
// vanilla WebGL connector exposes the same shell controls, so the full round-trip
// spec body runs once per engine.
for (const engineId of FULL_FLOW_ENGINES) {
  test(`[${engineId}] captures input source, scene, and delivery end to end`, async ({
    page,
    request,
  }) => {
    await page.goto(`/?engine=${engineId}`);

    // The collector is reachable (the panel's `/health` ping flips the dot green).
    await expect(page.locator("#connDot")).toHaveClass(/ok/);

    // The session id is stamped synchronously once the connector starts.
    await expect(page.locator("#sessionId")).not.toHaveText("…");
    const sessionId = (await page.locator("#sessionId").textContent())?.trim();
    expect(sessionId).toBeTruthy();

    // Interact below the info panel so we drive the 3D canvas, not the controls.
    const { width, height } = page.viewportSize() ?? { width: 1280, height: 720 };
    const x = Math.round(width * 0.6);
    const y = Math.round(height * 0.72);

    // 1) Mouse pointer in the "lobby" scene → events carry source "mouse".
    await page.mouse.move(x, y);
    await page.mouse.click(x, y);

    // 2) Switch scene/area (ADR 0010) → subsequent events carry sceneId "gallery".
    // The scene buttons live in the controls panel, which boots collapsed.
    await openControls(page);
    await page.locator("#sceneGallery").click();
    await expect(page.locator("#currentScene")).toHaveText("gallery");

    // 3) Touch tap (ADR 0011) → events carry source "touch"; the readout mirrors it.
    await page.touchscreen.tap(x, y);
    await expect(page.locator("#lastSource")).toHaveText("touch");

    // Force a flush via the panel button and wait for the collector to accept it.
    const flushed = page.waitForResponse(
      (res) =>
        res.url().includes("/api/v1/collect") &&
        res.request().method() === "POST" &&
        res.status() === 200,
    );
    await page.locator("#replayCurrentButton").click();
    await flushed;

    // The UI confirms the collector stored at least one event.
    await expect(page.locator("#delivered")).not.toHaveText("0");

    // Read the stored timeline back from the collector and assert the new ADR
    // fields survived the full browser → SDK → collector → store round trip.
    const res = await request.get(`${COLLECTOR_URL}/api/v1/sessions/${sessionId}/events`, {
      headers: { "x-api-key": API_KEY },
    });
    expect(res.ok()).toBeTruthy();
    const events = (await res.json()) as CapturedEvent[];
    expect(events.length).toBeGreaterThan(0);

    const sources = new Set(
      events.map((e) => e.source).filter((s): s is string => typeof s === "string"),
    );
    expect(sources).toContain("mouse");
    expect(sources).toContain("touch");

    const scenes = new Set(
      events.map((e) => e.sceneId).filter((s): s is string => typeof s === "string"),
    );
    expect(scenes).toContain("lobby");
    expect(scenes).toContain("gallery");

    expect(events.some((e) => e.type === "scene_change")).toBe(true);
  });
}

// react-three-fiber renders through three but owns its own canvas/DOM and does not
// expose the scene-switch / replay controls, so it gets a lighter smoke test: the
// app boots the React root, the connector starts, and a session id is stamped.
test("[r3f] boots and starts a session", async ({ page }) => {
  await page.goto("/?engine=r3f");
  await expect(page.locator("#connDot")).toHaveClass(/ok/);
  await expect(page.locator("#sessionId")).not.toHaveText("…");
  const sessionId = (await page.locator("#sessionId").textContent())?.trim();
  expect(sessionId).toBeTruthy();
});

/** One ordered point of a session's walked path (ADR 0026). */
interface TrajectoryPoint {
  ts: number;
  x: number;
  y: number;
  z: number;
}

/** One cell of the top-down floor-plan camera-position heatmap (ADR 0026). */
interface PositionBin {
  gx: number;
  gz: number;
  avg_y: number;
  count: number;
}

// Walkable / first-person capture (ADR 0026). The Babylon `UniversalCamera`
// auto-classifies as `cameraType: "free"` and drives on WASD without pointer
// lock, so it's the reliable engine for a headless walk. `?camera=first-person`
// swaps the orbit demo for the walkable room. We assert the camera-mode label
// survives end to end and that the two first-person spatial reads (floor-plan
// position heatmap + session trajectory) return data.
test("[babylon] captures a first-person walkable session", async ({ page, request }) => {
  await page.goto("/?engine=babylon&camera=first-person");

  await expect(page.locator("#connDot")).toHaveClass(/ok/);
  // The camera mode is fixed by the scene and surfaced read-only (no toggle).
  await expect(page.locator("#cameraMode")).toHaveText("first-person");
  // In first-person mode the lobby/gallery sub-area switcher is hidden.
  await expect(page.locator("#sceneSwitcher")).toBeHidden();

  await expect(page.locator("#sessionId")).not.toHaveText("…");
  const sessionId = (await page.locator("#sessionId").textContent())?.trim();
  expect(sessionId).toBeTruthy();

  // Focus the canvas, then walk with WASD so the camera pose changes and the
  // position sampler records more than the initial standing point.
  const { width, height } = page.viewportSize() ?? { width: 1280, height: 720 };
  await page.mouse.click(Math.round(width * 0.6), Math.round(height * 0.72));
  for (const key of ["KeyW", "KeyD", "KeyW"]) {
    await page.keyboard.down(key);
    await page.waitForTimeout(450);
    await page.keyboard.up(key);
  }

  // Flush and wait for the collector to accept the batch.
  const flushed = page.waitForResponse(
    (res) =>
      res.url().includes("/api/v1/collect") &&
      res.request().method() === "POST" &&
      res.status() === 200,
  );
  // The replay button lives in the controls panel, which boots collapsed.
  await openControls(page);
  await page.locator("#replayCurrentButton").click();
  await flushed;

  // 1) The session is labelled first-person end to end (`cameraType: "free"`).
  const metaRes = await request.get(`${COLLECTOR_URL}/api/v1/sessions/${sessionId}/meta`, {
    headers: { "x-api-key": API_KEY },
  });
  expect(metaRes.ok()).toBeTruthy();
  const meta = (await metaRes.json()) as { scene?: { cameraType?: string } };
  expect(meta.scene?.cameraType).toBe("free");

  // 2) The walked-path endpoint returns the session's ordered camera positions.
  const trajRes = await request.get(`${COLLECTOR_URL}/api/v1/sessions/${sessionId}/trajectory`, {
    headers: { "x-api-key": API_KEY },
  });
  expect(trajRes.ok()).toBeTruthy();
  const trajectory = (await trajRes.json()) as TrajectoryPoint[];
  expect(trajectory.length).toBeGreaterThan(0);
  // Points are ordered oldest-first and carry numeric ground-plane coordinates.
  for (let i = 1; i < trajectory.length; i++) {
    expect(trajectory[i]!.ts).toBeGreaterThanOrEqual(trajectory[i - 1]!.ts);
  }
  expect(typeof trajectory[0]!.x).toBe("number");
  expect(typeof trajectory[0]!.z).toBe("number");

  // 3) The first-person floor-plan heatmap has at least one occupied cell.
  const fpRes = await request.get(
    `${COLLECTOR_URL}/api/v1/heatmaps/position?cameraMode=first-person`,
    { headers: { "x-api-key": API_KEY } },
  );
  expect(fpRes.ok()).toBeTruthy();
  const floorPlan = (await fpRes.json()) as PositionBin[];
  expect(floorPlan.length).toBeGreaterThan(0);

  // 4) The camera-mode filter discriminates: the session is listed under the
  //    first-person filter but excluded by the viewer filter.
  const listed = async (cameraMode: "viewer" | "first-person"): Promise<boolean> => {
    const res = await request.get(`${COLLECTOR_URL}/api/v1/sessions?cameraMode=${cameraMode}`, {
      headers: { "x-api-key": API_KEY },
    });
    expect(res.ok()).toBeTruthy();
    const rows = (await res.json()) as { session_id: string }[];
    return rows.some((r) => r.session_id === sessionId);
  };
  expect(await listed("first-person")).toBe(true);
  expect(await listed("viewer")).toBe(false);
});
