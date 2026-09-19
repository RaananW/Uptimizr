import { expect, test, type APIRequestContext, type Page } from "@playwright/test";

import {
  API_KEY,
  COLLECTOR_URL,
  DASHBOARD_URL,
  PROJECT_ID,
  QUERY_ONLY_API_KEY,
} from "./constants.js";
import { waitForEventTypes } from "./helpers/capture.js";

/**
 * Full-stack spec for conditional subscriptions (#311, ADR 0051 §6).
 *
 * It drives the whole round trip the feature exists for: seed telemetry →
 * create a subscription over the API with an `annotate` key → make it fire →
 * read the recorded firing back → see it in the dashboard's read-only
 * **Subscriptions** panel. That last hop is the acceptance criterion a unit test
 * cannot cover, because the panel's data reaches it through two real HTTP calls
 * made by `CollectorApi`.
 *
 * ## Why every case is scoped to its own scene
 *
 * The harness runs one collector for the whole suite, and the other specs seed
 * plenty of `frame_perf`. A subscription filtered to a scene id nobody else uses
 * measures only this spec's own events, so the predicate is true by
 * construction rather than by luck. (A `presence` predicate looks simpler and is
 * not: live presence depends on which browser sessions the preceding specs
 * happened to leave inside the liveness window.)
 *
 * Delivery is `sse` only: no webhook is configured, and the harness sets no
 * `COLLECTOR_WEBHOOK_ALLOWED_HOSTS`, so this spec cannot make the collector
 * issue an outbound request at all.
 */

/** Median FPS the seeded scene runs at — comfortably under the threshold. */
const SEEDED_FPS = 10;

function declarationFor(scene: string, name: string) {
  return {
    name,
    metric: "perf_summary",
    filters: { scene },
    evaluate: { every: "5m", window: "1h" },
    predicate: { kind: "threshold", column: "p50_fps", op: "<", value: 40, minSample: 1 },
    cooldown: "0s",
    delivery: [{ kind: "sse" }],
  };
}

/**
 * Seed a scene that is unambiguously slow, across the whole window the
 * subscription will measure.
 *
 * `evaluate.window: "1h"` snaps its start down to a bucket boundary, so it can
 * span the previous complete hour as well as the current partial one — the
 * samples therefore cover the last two hours, and no bucket inside the window is
 * left to some other spec's data.
 */
async function seedSlowScene(request: APIRequestContext, scene: string): Promise<string> {
  const now = Date.now();
  const sessionId = `${scene}-session`;
  const events = [];
  for (let minutes = 118; minutes >= 0; minutes -= 2) {
    events.push({
      type: "frame_perf" as const,
      projectId: PROJECT_ID,
      sessionId,
      sceneId: scene,
      sdkVersion: "0.0.0-e2e",
      ts: now - minutes * 60_000 - 1_000,
      fps: SEEDED_FPS,
    });
  }
  const res = await request.post(`${COLLECTOR_URL}/api/v1/collect`, { data: { events } });
  expect(
    res.ok(),
    `seeding frame_perf should succeed (got ${res.status()}: ${await res.text()})`,
  ).toBeTruthy();
  await waitForEventTypes(request, sessionId, ["frame_perf"]);
  return sessionId;
}

async function createSubscription(
  request: APIRequestContext,
  declaration: ReturnType<typeof declarationFor>,
): Promise<string> {
  const res = await request.post(`${COLLECTOR_URL}/api/v1/subscriptions`, {
    headers: { "x-api-key": API_KEY, "content-type": "application/json" },
    data: declaration,
  });
  expect(
    res.ok(),
    `creating a subscription should succeed (got ${res.status()}: ${await res.text()})`,
  ).toBeTruthy();
  return (await res.json()).id as string;
}

async function loadDashboard(page: Page): Promise<void> {
  await page.goto(DASHBOARD_URL);
  await page.getByPlaceholder("http://localhost:4318").fill(COLLECTOR_URL);
  await page.getByPlaceholder("utk_…").fill(API_KEY);
  await page.getByRole("button", { name: /load/i }).click();
}

test("a subscription fires, records the firing, and the dashboard lists it", async ({
  page,
  request,
}) => {
  const scene = `e2e-subs-${Date.now()}`;
  const name = `Slow scene ${scene}`;
  await seedSlowScene(request, scene);
  const id = await createSubscription(request, declarationFor(scene, name));

  try {
    // Evaluate once for real, so a firing is recorded and fanned out over SSE.
    const fired = await request.post(
      `${COLLECTOR_URL}/api/v1/subscriptions/${id}/test?deliver=true`,
      { headers: { "x-api-key": API_KEY } },
    );
    expect(fired.ok(), await fired.text()).toBeTruthy();
    const evaluation = await fired.json();
    expect(evaluation.fired, `evaluation should have fired: ${evaluation.reason}`).toBe(true);
    expect(evaluation.value).toBe(SEEDED_FPS);
    expect(evaluation.expected).toBe(40);
    expect(evaluation.delivered).toBe(true);
    // Nothing configured a webhook, so nothing left the process.
    expect(evaluation.webhookConfigured).toBe(false);

    // The bounded firing log now holds exactly that firing.
    const events = await request.get(`${COLLECTOR_URL}/api/v1/subscriptions/${id}/events`, {
      headers: { "x-api-key": API_KEY },
    });
    expect(events.ok()).toBeTruthy();
    const rows = await events.json();
    expect(rows.length).toBeGreaterThanOrEqual(1);
    expect(rows[0].payload.predicate).toBe("threshold");
    expect(rows[0].payload.scene).toBe(scene);
    expect(rows[0].payload.reason).toContain("perf_summary.p50_fps");
    // The bounded `format=summary` block rides along with the firing.
    expect(rows[0].payload.summary.metric).toBe("insight_baseline");

    await loadDashboard(page);

    const panel = page
      .locator("section")
      .filter({ has: page.getByRole("heading", { name: "Subscriptions" }) })
      .last();
    await expect(panel.getByRole("heading", { name: "Subscriptions" })).toBeVisible({
      timeout: 20_000,
    });
    // The dashboard hosts many panels, so this one can sit below the fold on a
    // short CI viewport; scroll it into view so its body mounts.
    await panel.scrollIntoViewIfNeeded();

    await expect(panel.getByText(name)).toBeVisible({ timeout: 20_000 });
    await expect(panel.getByText(`perf_summary.p50_fps < 40 · ${scene}`)).toBeVisible();
    await expect(panel.getByText("Fired").first()).toBeVisible();
    // The read-only "recent firings" list — the acceptance criterion.
    await expect(
      panel.getByText(/perf_summary\.p50_fps is 10 — < 40 over 1h/).first(),
    ).toBeVisible();
    await expect(panel.getByText("No subscriptions configured.")).toHaveCount(0);
  } finally {
    // Subscriptions are standing state on a store shared by every spec, so this
    // one cleans up after itself rather than leaving a row behind.
    await request.delete(`${COLLECTOR_URL}/api/v1/subscriptions/${id}`, {
      headers: { "x-api-key": API_KEY },
    });
  }
});

test("a query-only key can read subscriptions but not create or fire one", async ({ request }) => {
  const read = await request.get(`${COLLECTOR_URL}/api/v1/subscriptions`, {
    headers: { "x-api-key": QUERY_ONLY_API_KEY },
  });
  expect(read.status()).toBe(200);

  // Creating one is how a caller asks the collector to act on its behalf, so it
  // needs `annotate` — the same gate the metadata write path uses.
  const created = await request.post(`${COLLECTOR_URL}/api/v1/subscriptions`, {
    headers: { "x-api-key": QUERY_ONLY_API_KEY, "content-type": "application/json" },
    data: declarationFor("e2e-subs-denied", "should not be created"),
  });
  expect(created.status()).toBe(403);
  expect((await created.json()).error).toContain("metadata");
});

test("a webhook host that is not allow-listed is refused at creation", async ({ request }) => {
  // The harness sets no COLLECTOR_WEBHOOK_ALLOWED_HOSTS, so *every* webhook is
  // refused — which is the default posture a self-hoster starts from, and the
  // reason a key holder cannot aim the collector at the network around it.
  const res = await request.post(`${COLLECTOR_URL}/api/v1/subscriptions`, {
    headers: { "x-api-key": API_KEY, "content-type": "application/json" },
    data: {
      ...declarationFor("e2e-subs-refused", "should not be created"),
      delivery: [{ kind: "webhook", url: "http://169.254.169.254/latest/meta-data" }],
    },
  });
  expect(res.status()).toBe(400);
  expect((await res.json()).error).toContain("COLLECTOR_WEBHOOK_ALLOWED_HOSTS");
});
