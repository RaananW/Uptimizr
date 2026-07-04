import { expect, test, type APIRequestContext } from "@playwright/test";

import { API_KEY, COLLECTOR_URL, DASHBOARD_URL } from "./constants.js";
import {
  bootEngine,
  enableAllCapture,
  openControls,
  readSessionEvents,
} from "./helpers/capture.js";

/**
 * Scene/level retention funnel (#147) end to end. The canned preset is built
 * directly from `scene_change` markers, so this drives the built-in "lobby"
 * viewer scene through its lobby ⇄ gallery sub-area switcher (ADR 0010) to emit a
 * multi-hop scene path, then proves the full round trip:
 *
 *   real browser → SDK `setScene` → collector → DuckDB → `GET /api/v1/scene-retention`
 *
 * and finally that the dashboard's **Scene retention funnel** panel renders the
 * captured flow. The switcher starts on `lobby`, so clicking gallery → lobby →
 * gallery yields the ordered scene targets `[gallery, lobby, gallery]` and thus
 * the two consecutive links `gallery → lobby` and `lobby → gallery`.
 */

interface RetentionLink {
  from_scene: string;
  to_scene: string;
  sessions: number;
}

/** Read the scene-retention aggregation back from the collector. */
async function getRetention(request: APIRequestContext): Promise<RetentionLink[]> {
  const res = await request.get(`${COLLECTOR_URL}/api/v1/scene-retention`, {
    headers: { "x-api-key": API_KEY },
  });
  expect(
    res.ok(),
    `scene-retention should succeed (got ${res.status()}: ${await res.text()})`,
  ).toBeTruthy();
  return (await res.json()) as RetentionLink[];
}

/** Poll the stored timeline until the session has recorded `min` scene_change markers. */
async function waitForSceneChanges(
  request: APIRequestContext,
  sessionId: string,
  min: number,
  timeoutMs = 20_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const events = await readSessionEvents(request, sessionId);
    const changes = events.filter((e) => e.type === "scene_change").length;
    if (changes >= min) return;
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${min} scene_change events (saw ${changes})`);
    }
    await new Promise((r) => setTimeout(r, 750));
  }
}

test("scene retention funnel captures scene → scene flow end to end", async ({ page, request }) => {
  // 1) Boot the built-in lobby viewer scene (its lobby/gallery sub-area switcher
  //    is what emits scene_change markers) and open the controls that host it.
  await enableAllCapture(page, "babylon");
  const sessionId = await bootEngine(page, "babylon");
  await openControls(page);
  await expect(page.locator("#currentScene")).toHaveText("lobby");

  // 2) Walk a multi-hop path: gallery → lobby → gallery. The switcher no-ops on a
  //    same-scene click, so alternating guarantees three distinct scene_change
  //    markers and the two consecutive links we assert on.
  await page.locator("#sceneGallery").click();
  await expect(page.locator("#currentScene")).toHaveText("gallery");
  await page.locator("#sceneLobby").click();
  await expect(page.locator("#currentScene")).toHaveText("lobby");
  await page.locator("#sceneGallery").click();
  await expect(page.locator("#currentScene")).toHaveText("gallery");

  await waitForSceneChanges(request, sessionId, 3);

  // 3) The aggregation exposes both consecutive transitions, weighted by sessions.
  const links = await getRetention(request);
  const lobbyToGallery = links.find((l) => l.from_scene === "lobby" && l.to_scene === "gallery");
  const galleryToLobby = links.find((l) => l.from_scene === "gallery" && l.to_scene === "lobby");
  expect(lobbyToGallery, "expected a lobby → gallery link").toBeTruthy();
  expect(galleryToLobby, "expected a gallery → lobby link").toBeTruthy();
  expect(lobbyToGallery!.sessions).toBeGreaterThanOrEqual(1);
  expect(galleryToLobby!.sessions).toBeGreaterThanOrEqual(1);

  // 4) The dashboard's Scene retention funnel panel renders the captured flow.
  await page.goto(DASHBOARD_URL);
  await page.getByPlaceholder("http://localhost:4318").fill(COLLECTOR_URL);
  await page.getByPlaceholder("utk_…").fill(API_KEY);
  await page.getByRole("button", { name: /load/i }).click();

  const panel = page.locator("section", { hasText: "Scene retention funnel" }).first();
  await panel.scrollIntoViewIfNeeded();
  await expect(panel).toBeVisible({ timeout: 20_000 });
  // The grouped scene → scene bars name the scenes captured above.
  const funnel = panel.getByTestId("scene-retention-funnel");
  await expect(funnel).toBeVisible();
  await expect(funnel.locator("[data-scene-link='lobby->gallery']")).toBeVisible();
  await expect(funnel.locator("[data-scene-link='gallery->lobby']")).toBeVisible();
});
