import { expect, test } from "@playwright/test";

import { API_KEY, COLLECTOR_URL, DASHBOARD_URL } from "./constants.js";
import {
  bootEngine,
  driveInteractions,
  enableAllCapture,
  waitForEventTypes,
} from "./helpers/capture.js";

/**
 * Live layer (ADR 0032) end to end. A running playground session must surface in
 * the dashboard's real-time **presence** badge + roster and the live **event
 * feed**, then be followable as a per-session **live replay** — all over SSE.
 *
 * This exercises the full browser → SDK → collector → in-process bus → SSE →
 * dashboard path that no other spec covers:
 *
 * - `POST /api/v1/live/token` (api-key → short-lived live token), then
 * - `GET /api/v1/live/presence` (aggregate badge + roster),
 * - `GET /api/v1/live/stream` (firehose driving the in-place feed), and
 * - `GET /api/v1/live/sessions/:id` (retention-gated live follow — retention is
 *   enabled in the harness env).
 *
 * It also guards the cross-origin case: the dashboard and collector run on
 * different origins here, so the SSE responses must carry CORS headers (the
 * streams are written on the raw, hijacked socket and bypass the CORS plugin).
 *
 * Babylon is the subject connector (the reference: it captures the richest set
 * and supports the live birdview replay driver).
 */
test("live presence, feed, and follow surface a running session in the dashboard", async ({
  page,
  context,
  request,
}) => {
  // Two pages + a Babylon live-replay viewer is a lot of work for one test.
  test.setTimeout(90_000);

  // 1) Boot a real, capturing playground session — the live "subject".
  await enableAllCapture(page, "babylon");
  const sessionId = await bootEngine(page, "babylon");

  // 2) Open the dashboard in a second tab and connect it to the same collector,
  //    so its live SSE connections (presence + firehose) open before traffic.
  const dash = await context.newPage();
  await dash.goto(DASHBOARD_URL);
  await dash.getByPlaceholder("http://localhost:4318").fill(COLLECTOR_URL);
  await dash.getByPlaceholder("utk_…").fill(API_KEY);
  await dash.getByRole("button", { name: /load/i }).click();

  // The real-time presence panel renders (only in the non-detail dashboard view).
  const livePanel = dash.locator("section", { hasText: "Live now" }).first();
  await expect(livePanel.getByRole("heading", { name: "Live now" })).toBeVisible({
    timeout: 20_000,
  });

  // Wait for the presence SSE to actually connect *while the dashboard is still
  // foreground* — browsers throttle initiating EventSource connections in a
  // background tab, so opening it now avoids a flaky connect later. Once open the
  // badge reads "N live now" (N≥0); the connection stays up when backgrounded.
  // The hook reconnects with exponential backoff (up to 15s), so allow 30s for a
  // transient first-connect error to recover — matching the live-follow wait below.
  await expect(dash.getByText(/\d+ live now/)).toBeVisible({ timeout: 30_000 });

  // 3) Generate live traffic on the playground tab. Bring it to front so its
  //    flush timer isn't background-throttled, drive the full interaction set,
  //    then confirm the events landed — which means they also fanned out over
  //    the in-process bus to the dashboard's open SSE connections.
  await page.bringToFront();
  await driveInteractions(page);
  await waitForEventTypes(request, sessionId, ["session_start", "pointer_click", "camera_sample"]);

  // 4) Back on the dashboard, the live layer reflects the session in place.
  await dash.bringToFront();

  // The session shows up in the non-identifying presence roster (short id).
  const rosterEntry = livePanel.getByRole("button", {
    name: new RegExp(sessionId.slice(0, 8)),
  });
  await expect(rosterEntry).toBeVisible({ timeout: 20_000 });

  // The live event feed populated from the firehose. The feed is a capped,
  // rolling window, so assert on the high-frequency event types that keep
  // arriving (camera/pointer/frame samples) rather than a single discrete click
  // that can scroll out. These type strings only render as feed chips.
  await expect(
    livePanel.getByText(/camera_sample|pointer_move|frame_perf|mesh_interaction/).first(),
  ).toBeVisible({ timeout: 20_000 });

  // 5) Follow the session live → the per-session live-replay viewer opens and
  //    reaches the LIVE state. Keep events flowing so the follow stream stays at
  //    the live edge while the dashboard's Babylon viewer spins up.
  await rosterEntry.click();
  await expect(dash.getByRole("heading", { name: "Live replay" })).toBeVisible({ timeout: 20_000 });

  await page.bringToFront();
  await driveInteractions(page);
  await dash.bringToFront();

  await expect(dash.getByText("● LIVE")).toBeVisible({ timeout: 30_000 });
});
