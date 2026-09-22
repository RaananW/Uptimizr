import { expect, test, type Page, type Route } from "@playwright/test";

import { API_KEY, COLLECTOR_URL, DASHBOARD_URL, QUERY_ONLY_API_KEY } from "./constants.js";
import {
  bootEngine,
  driveInteractions,
  enableAllCapture,
  waitForEventTypes,
} from "./helpers/capture.js";

/**
 * End-to-end for **declarative panel specs** (#315, ADR 0051 §7 / sketch §G.3):
 * the thing a person actually does — ask a question, decide the answer is worth
 * keeping, and find the panel still there tomorrow.
 *
 * The round trip is real in every part that matters: a real Babylon session
 * feeds the real collector's DuckDB store, the real `<AssistantPanel>` runs the
 * real query DSL against it, "Pin as panel" writes through the real
 * `annotate`-gated endpoint, the real dashboard loads the spec back on mount
 * and draws it with the panel components it ships. Only the LLM is mocked —
 * deterministically, same-origin, no weights — exactly as `assistant.spec.ts`
 * and `metadata.spec.ts` do it.
 *
 * The second test is the other half of the promise: a key **without** `annotate`
 * is offered no pin and no unpin, and is refused the write if it asks anyway.
 *
 * No regex is run over model or tool output anywhere below — plain `JSON.parse`
 * and array scans only (CodeQL ReDoS).
 */

/** Same-origin endpoint the panel's hosted OpenAI adapter POSTs to. */
const MOCK_LLM_ENDPOINT = `${DASHBOARD_URL}/mock-llm`;

/** The panel the agent pins, and the reading it leaves with it. */
const PANEL_TITLE = "Meshes people actually touch";
const ANSWER = "The crate is the most-interacted mesh.";

interface OpenAiRequestMessage {
  role: string;
  content?: string;
}

/** A minimal OpenAI chat-completion body. */
function completion(message: {
  content: string;
  tool_calls?: Array<{
    id: string;
    type: "function";
    function: { name: string; arguments: string };
  }>;
}): string {
  return JSON.stringify({ choices: [{ message }] });
}

/** Whether the transcript already carries a tool result for this turn. */
function hasToolResult(messages: OpenAiRequestMessage[]): boolean {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]!.role === "tool") return true;
    if (messages[i]!.role === "user") return false;
  }
  return false;
}

/**
 * A mock LLM that calls the **query DSL tool** and then answers.
 *
 * That the call is `query` and not a canned endpoint is the whole point: "Pin as
 * panel" is offered only for an answer backed by a `queryV1` document, because
 * that document is what the panel re-runs. A turn that answered from
 * `/api/v1/meshes/top` has nothing to pin.
 */
async function mockLlm(page: Page): Promise<void> {
  await page.route("**/mock-llm/**", async (route: Route) => {
    const body = route.request().postDataJSON() as { messages?: OpenAiRequestMessage[] };
    const messages = body.messages ?? [];

    if (!hasToolResult(messages)) {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: completion({
          content: "",
          tool_calls: [
            {
              id: "call_query",
              type: "function",
              function: {
                name: "query",
                arguments: JSON.stringify({
                  v: 1,
                  metric: "top_meshes",
                  // A real window: the assistant's tool call carries one, and
                  // "Pin as panel" is what replaces it with `inherit`.
                  range: { since: Date.now() - 86_400_000, until: Date.now() + 60_000 },
                  limit: 10,
                }),
              },
            },
          ],
        }),
      });
      return;
    }

    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: completion({ content: ANSWER }),
    });
  });
}

/** Connect the dashboard to the collector with `apiKey` and wait for panels. */
async function connectDashboard(page: Page, apiKey: string): Promise<void> {
  await page.goto(DASHBOARD_URL);
  await page.getByPlaceholder("http://localhost:4318").fill(COLLECTOR_URL);
  await page.getByPlaceholder("utk_…").fill(apiKey);
  await page.getByRole("button", { name: /load/i }).click();
  await expect(page.getByText("Top meshes")).toBeVisible({ timeout: 20_000 });
}

/** Open the assistant drawer and configure the mocked hosted backend. */
async function openAssistant(page: Page) {
  await page.getByRole("button", { name: "Ask the assistant" }).click();
  const assistant = page.getByRole("region", { name: "Analytics assistant" });
  await assistant.getByRole("button", { name: "Use hosted key" }).click();
  await assistant.getByLabel("Endpoint").fill(MOCK_LLM_ENDPOINT);
  await assistant.getByLabel("API key").fill("mock-key");
  await assistant.getByLabel("Hosted model").fill("mock-model");
  await assistant.getByRole("button", { name: "Use this provider" }).click();
  return assistant;
}

test("an answer can be pinned as a panel, survives a reload, and can be unpinned", async ({
  page,
  request,
}) => {
  // 1) A real session, so the query the assistant runs has something to answer
  //    from and the pinned panel has something to draw.
  await enableAllCapture(page, "babylon");
  const sessionId = await bootEngine(page, "babylon");
  await driveInteractions(page, { keyboard: true });
  await waitForEventTypes(request, sessionId, ["mesh_interaction", "pointer_click"]);

  await mockLlm(page);
  await connectDashboard(page, API_KEY);
  const assistant = await openAssistant(page);

  // 2) One turn, backed by a real `query` call against the real collector.
  await assistant.getByLabel("Message").fill("Which meshes do people touch most?");
  await assistant.getByRole("button", { name: "Send" }).click();
  const answer = assistant.locator('[data-role="assistant"]').last();
  await expect(answer).toContainText(ANSWER, { timeout: 30_000 });

  // 3) "Pin as panel" — offered because the answer came from a `query` call.
  const pin = assistant.getByRole("button", { name: "Pin as panel" }).last();
  await expect(pin).toBeVisible({ timeout: 20_000 });
  await pin.click();
  await assistant.getByLabel("Panel title").fill(PANEL_TITLE);
  await assistant.getByRole("button", { name: "Pin", exact: true }).click();
  await expect(assistant.getByText("Pinned to the dashboard.")).toBeVisible({ timeout: 20_000 });

  // The spec is really stored, as data: a query, a chart and a reading. The
  // window the question was asked in has become `inherit`, so the panel follows
  // the dashboard's filter bar instead of freezing.
  const panelsRes = await request.get(`${COLLECTOR_URL}/api/v1/panels`, {
    headers: { "x-api-key": API_KEY },
  });
  expect(panelsRes.ok()).toBeTruthy();
  const panels = (await panelsRes.json()) as Array<{
    id: string;
    authorKind: string;
    spec: {
      title: string;
      chart: string;
      note?: string;
      query: { metric: string; range: unknown };
    };
  }>;
  const stored = panels.find((row) => row.spec.title === PANEL_TITLE);
  expect(stored, "the answer should be stored as a panel spec").toBeTruthy();
  expect(stored!.spec.query.metric).toBe("top_meshes");
  expect(stored!.spec.query.range).toBe("inherit");
  // A ranking is drawn as bars — chosen from the metric's grain, not guessed.
  expect(stored!.spec.chart).toBe("bar");
  expect(stored!.spec.note).toBe(ANSWER);
  // The collector decided an agent pinned it (the assistant identifies as
  // `assistant`, not `dashboard`).
  expect(stored!.authorKind).toBe("agent");

  // 4) Reload from scratch: the panel is loaded back from the spec and drawn by
  //    the dashboard's own components. Nothing was imported and nothing was
  //    evaluated — ADR 0041's trust decision is untouched.
  await connectDashboard(page, API_KEY);
  const panel = page.locator("section").filter({ hasText: PANEL_TITLE }).first();
  await expect(panel).toBeVisible({ timeout: 20_000 });
  // It is marked, so it is never mistaken for a built-in, and it carries the
  // agent's reading as its subtitle.
  await expect(panel.locator('[data-role="panel-badge"]')).toHaveText("Pinned by agents");
  await expect(panel.getByText(ANSWER)).toBeVisible();

  // 5) Unpin — offered because this key holds `annotate`. Unlike "hide", this
  //    removes the panel for the whole project.
  await panel.getByRole("button", { name: `Unpin ${PANEL_TITLE}` }).click();
  await expect(page.getByText(PANEL_TITLE)).toHaveCount(0, { timeout: 20_000 });

  const after = await request.get(`${COLLECTOR_URL}/api/v1/panels`, {
    headers: { "x-api-key": API_KEY },
  });
  const remaining = (await after.json()) as Array<{ spec: { title: string } }>;
  expect(remaining.some((row) => row.spec.title === PANEL_TITLE)).toBe(false);
});

test("a `query`-only key is offered no pin or unpin, and is refused the write", async ({
  page,
  request,
}) => {
  await enableAllCapture(page, "babylon");
  const sessionId = await bootEngine(page, "babylon");
  await driveInteractions(page, { keyboard: true });
  await waitForEventTypes(request, sessionId, ["mesh_interaction", "pointer_click"]);

  // Pin one panel with the writer key, so there is something an unpin control
  // *could* have appeared on.
  const pinned = await request.post(`${COLLECTOR_URL}/api/v1/panels`, {
    headers: { "x-api-key": API_KEY },
    data: {
      v: 1,
      title: "Read-only visible panel",
      chart: "bar",
      query: { v: 1, metric: "top_meshes", range: "inherit", limit: 5 },
      note: "Pinned by the writer key.",
    },
  });
  expect(pinned.status()).toBe(201);
  const { id } = (await pinned.json()) as { id: string };

  await mockLlm(page);
  await connectDashboard(page, QUERY_ONLY_API_KEY);

  // The panel is visible and marked — a read-only key can *see* what agents
  // pinned; it simply cannot change it.
  const panel = page.locator("section").filter({ hasText: "Read-only visible panel" }).first();
  await expect(panel).toBeVisible({ timeout: 20_000 });
  await expect(panel.locator('[data-role="panel-badge"]')).toHaveText("Pinned by agents");
  await expect(panel.getByRole("button", { name: /^Unpin / })).toHaveCount(0);

  // And the assistant offers no "Pin as panel": `whoami` reported a read-only key.
  const assistant = await openAssistant(page);
  await assistant.getByLabel("Message").fill("Which meshes do people touch most?");
  await assistant.getByRole("button", { name: "Send" }).click();
  await expect(assistant.locator('[data-role="assistant"]').last()).toContainText(ANSWER, {
    timeout: 30_000,
  });
  await expect(assistant.getByRole("button", { name: "Pin as panel" })).toHaveCount(0);

  // The endpoint refuses the write regardless of what the UI offers: the
  // capability is the boundary, the hidden button is only courtesy.
  const refusedPin = await request.post(`${COLLECTOR_URL}/api/v1/panels`, {
    headers: { "x-api-key": QUERY_ONLY_API_KEY },
    data: {
      v: 1,
      title: "Should not be stored",
      chart: "bar",
      query: { v: 1, metric: "top_meshes", range: "inherit" },
    },
  });
  expect(refusedPin.status()).toBe(403);
  const refusedUnpin = await request.delete(`${COLLECTOR_URL}/api/v1/panels/${id}`, {
    headers: { "x-api-key": QUERY_ONLY_API_KEY },
  });
  expect(refusedUnpin.status()).toBe(403);

  // Reading is still allowed, and nothing changed.
  const listed = await request.get(`${COLLECTOR_URL}/api/v1/panels`, {
    headers: { "x-api-key": QUERY_ONLY_API_KEY },
  });
  expect(listed.ok()).toBeTruthy();
  const rows = (await listed.json()) as Array<{ id: string; spec: { title: string } }>;
  expect(rows.some((row) => row.id === id)).toBe(true);
  expect(rows.some((row) => row.spec.title === "Should not be stored")).toBe(false);

  // Leave the harness as we found it: these specs share one collector.
  await request.delete(`${COLLECTOR_URL}/api/v1/panels/${id}`, {
    headers: { "x-api-key": API_KEY },
  });
});
