import { expect, test, type APIRequestContext, type Page } from "@playwright/test";

import { API_KEY, COLLECTOR_URL, DASHBOARD_URL, QUERY_ONLY_API_KEY } from "./constants.js";

/**
 * Full-stack spec for conditional subscriptions (#311, ADR 0051 §6).
 *
 * It drives the whole round trip the feature exists for: create a subscription
 * over the API with an `annotate` key → make it fire → read the recorded firing
 * back → see it in the dashboard's read-only **Subscriptions** panel. That last
 * hop is the acceptance criterion a unit test cannot cover, because the panel's
 * data reaches it through two real HTTP calls made by `CollectorApi`.
 *
 * The predicate is `presence == 0` deliberately. It is answered from the live
 * bus rather than from seeded telemetry, so the spec does not depend on the
 * fixture's timestamps falling inside an evaluation window — a Playwright run
 * has no live sessions, so it is true the moment it is asked, every time.
 *
 * Delivery is `sse` only: no webhook is configured, so this spec cannot make the
 * collector issue an outbound request even if `COLLECTOR_WEBHOOK_ALLOWED_HOSTS`
 * were somehow set in the harness.
 */

const declaration = {
  name: "Nobody in the scene (e2e)",
  metric: "perf_summary",
  evaluate: { every: "5m", window: "1h" },
  predicate: { kind: "presence", op: "==", value: 0 },
  cooldown: "0s",
  delivery: [{ kind: "sse" }],
};

async function createSubscription(request: APIRequestContext, name: string): Promise<string> {
  const res = await request.post(`${COLLECTOR_URL}/api/v1/subscriptions`, {
    headers: { "x-api-key": API_KEY, "content-type": "application/json" },
    data: { ...declaration, name },
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
  const name = `Nobody in the scene (e2e ${Date.now()})`;
  const id = await createSubscription(request, name);

  try {
    // Evaluate once for real, so a firing is recorded and fanned out over SSE.
    const fired = await request.post(
      `${COLLECTOR_URL}/api/v1/subscriptions/${id}/test?deliver=true`,
      { headers: { "x-api-key": API_KEY } },
    );
    expect(fired.ok(), await fired.text()).toBeTruthy();
    const evaluation = await fired.json();
    expect(evaluation.fired).toBe(true);
    expect(evaluation.delivered).toBe(true);
    expect(evaluation.webhookConfigured).toBe(false);

    // The bounded firing log now has exactly that firing.
    const events = await request.get(`${COLLECTOR_URL}/api/v1/subscriptions/${id}/events`, {
      headers: { "x-api-key": API_KEY },
    });
    expect(events.ok()).toBeTruthy();
    const rows = await events.json();
    expect(rows.length).toBeGreaterThanOrEqual(1);
    expect(rows[0].payload.predicate).toBe("presence");
    expect(rows[0].payload.reason).toContain("live session");

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
    await expect(panel.getByText("live sessions == 0").first()).toBeVisible();
    // The read-only "recent firings" list — the acceptance criterion.
    await expect(panel.getByText(/live session\(s\); predicate is presence/).first()).toBeVisible();
    await expect(panel.getByText("Fired").first()).toBeVisible();
    await expect(panel.getByText("No subscriptions configured.")).toHaveCount(0);
  } finally {
    // Subscriptions are standing state on a store shared by every spec, so this
    // one cleans up after itself rather than leaving a timer-backed row behind.
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
    data: declaration,
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
      ...declaration,
      name: "should not be created",
      delivery: [{ kind: "webhook", url: "http://169.254.169.254/latest/meta-data" }],
    },
  });
  expect(res.status()).toBe(400);
  expect((await res.json()).error).toContain("COLLECTOR_WEBHOOK_ALLOWED_HOSTS");
});
