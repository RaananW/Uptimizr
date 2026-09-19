import { expect, test, type Page, type Route } from "@playwright/test";

import { API_KEY, COLLECTOR_URL, DASHBOARD_URL, QUERY_ONLY_API_KEY } from "./constants.js";
import {
  bootEngine,
  driveInteractions,
  enableAllCapture,
  waitForEventTypes,
} from "./helpers/capture.js";

/**
 * End-to-end for the **metadata write path** (#310, ADR 0051 §5): the two
 * assistant actions a person actually clicks — "Annotate this" and "Save this
 * analysis" — and the annotation marker that then appears on the dashboard's
 * time axis.
 *
 * The round trip is real in every part that matters: a real Babylon session
 * feeds the real collector's DuckDB store, the real dashboard renders, the real
 * `<AssistantPanel>` writes through the real `annotate`-gated endpoints, and the
 * assertions read the stored rows back with the collector's own API. Only the
 * LLM is mocked — deterministically, same-origin, no weights — exactly as
 * `assistant.spec.ts` does it.
 *
 * The second test is the other half of the promise: a key **without** `annotate`
 * is offered no actions at all, and is refused the write if it asks anyway.
 */

/** Same-origin endpoint the panel's hosted OpenAI adapter POSTs to. */
const MOCK_LLM_ENDPOINT = `${DASHBOARD_URL}/mock-llm`;

const ANSWER = "Traffic doubled in the gallery this week.";

/** A minimal OpenAI chat-completion body carrying one plain answer. */
function completion(content: string): string {
  return JSON.stringify({ choices: [{ message: { content } }] });
}

/** Fulfil every mock-LLM call with the same grounded-looking one-line answer. */
async function mockLlm(page: Page): Promise<void> {
  await page.route("**/mock-llm/**", async (route: Route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: completion(ANSWER),
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

test("the assistant can annotate an answer and save it as an analysis", async ({
  page,
  request,
}) => {
  // 1) A real session, so the dashboard has something to render and the answer
  //    is being written about a project that actually has data.
  await enableAllCapture(page, "babylon");
  const sessionId = await bootEngine(page, "babylon");
  await driveInteractions(page, { keyboard: true });
  await waitForEventTypes(request, sessionId, ["mesh_interaction", "pointer_click"]);

  await mockLlm(page);
  await connectDashboard(page, API_KEY);
  const assistant = await openAssistant(page);

  // 2) One turn, so there is an answer to act on.
  await assistant.getByLabel("Message").fill("How did traffic change this week?");
  await assistant.getByRole("button", { name: "Send" }).click();
  const answer = assistant.locator('[data-role="assistant"]').last();
  await expect(answer).toContainText(ANSWER, { timeout: 20_000 });

  // 3) "Annotate this" — the harness key holds `annotate`, so the action is
  //    offered, and clicking it stores the answer as a project note.
  const annotate = assistant.getByRole("button", { name: "Annotate this" }).last();
  await expect(annotate).toBeVisible({ timeout: 20_000 });
  await annotate.click();
  await expect(assistant.getByText("Saved as an annotation.")).toBeVisible({ timeout: 20_000 });

  // The row is really there, and the collector — not the payload — decided that
  // an agent wrote it (the assistant identifies as `assistant`, not `dashboard`).
  const annotationsRes = await request.get(`${COLLECTOR_URL}/api/v1/annotations`, {
    headers: { "x-api-key": API_KEY },
  });
  expect(annotationsRes.ok()).toBeTruthy();
  const annotations = (await annotationsRes.json()) as Array<{
    text: string;
    authorKind: string;
    targetKind: string;
    since: string | null;
  }>;
  const stored = annotations.find((row) => row.text === ANSWER);
  expect(stored, "the answer should be stored as an annotation").toBeTruthy();
  expect(stored!.authorKind).toBe("agent");
  // The dashboard's default window is a bounded range, so the note is pinned to
  // that period rather than left standing.
  expect(stored!.targetKind).toBe("window");
  expect(stored!.since).toBeTruthy();

  // 4) "Save this analysis" — the title is pre-filled with the question asked.
  await assistant.getByRole("button", { name: "Save this analysis" }).last().click();
  const titleInput = assistant.getByLabel("Analysis title");
  await expect(titleInput).toHaveValue("How did traffic change this week?");
  await titleInput.fill("Weekly gallery traffic");
  await assistant.getByRole("button", { name: "Save", exact: true }).click();
  await expect(assistant.getByText("Analysis saved.")).toBeVisible({ timeout: 20_000 });

  const analysesRes = await request.get(`${COLLECTOR_URL}/api/v1/analyses`, {
    headers: { "x-api-key": API_KEY },
  });
  expect(analysesRes.ok()).toBeTruthy();
  const analyses = (await analysesRes.json()) as Array<{
    title: string;
    conclusion: string | null;
    authorKind: string;
  }>;
  const savedAnalysis = analyses.find((row) => row.title === "Weekly gallery traffic");
  expect(savedAnalysis, "the turn should be stored as a saved analysis").toBeTruthy();
  expect(savedAnalysis!.conclusion).toBe(ANSWER);
  expect(savedAnalysis!.authorKind).toBe("agent");

  // 5) The note now shows on the dashboard's time axis. Reconnect from scratch
  //    so the event-volume panel loads afresh, and look for the marker carrying
  //    the note's text as its tooltip.
  await connectDashboard(page, API_KEY);
  // The marker itself is what a person sees and hovers; the list around it is a
  // zero-height positioning layer over the canvas, so assert on the marker.
  const marker = page.locator(`[data-role="annotation-marker"] [title=${JSON.stringify(ANSWER)}]`);
  await expect(marker).toBeVisible({ timeout: 20_000 });
});

test("a key without `annotate` is offered no write actions and is refused the write", async ({
  page,
  request,
}) => {
  await enableAllCapture(page, "babylon");
  const sessionId = await bootEngine(page, "babylon");
  await driveInteractions(page, { keyboard: true });
  await waitForEventTypes(request, sessionId, ["mesh_interaction", "pointer_click"]);

  await mockLlm(page);
  await connectDashboard(page, QUERY_ONLY_API_KEY);
  const assistant = await openAssistant(page);

  await assistant.getByLabel("Message").fill("How did traffic change this week?");
  await assistant.getByRole("button", { name: "Send" }).click();
  await expect(assistant.locator('[data-role="assistant"]').last()).toContainText(ANSWER, {
    timeout: 20_000,
  });

  // No actions are offered — the panel asked `whoami` and got a read-only key.
  await expect(assistant.getByRole("button", { name: "Annotate this" })).toHaveCount(0);
  await expect(assistant.getByRole("button", { name: "Save this analysis" })).toHaveCount(0);

  // And the endpoint refuses the write regardless of what the UI offers: the
  // capability is the boundary, the hidden button is only courtesy.
  const refused = await request.post(`${COLLECTOR_URL}/api/v1/annotations`, {
    headers: { "x-api-key": QUERY_ONLY_API_KEY },
    data: { targetKind: "project", text: "should not be stored" },
  });
  expect(refused.status()).toBe(403);

  // Reading is still allowed, and nothing was written.
  const listed = await request.get(`${COLLECTOR_URL}/api/v1/annotations`, {
    headers: { "x-api-key": QUERY_ONLY_API_KEY },
  });
  expect(listed.ok()).toBeTruthy();
  const rows = (await listed.json()) as Array<{ text: string }>;
  expect(rows.some((row) => row.text === "should not be stored")).toBe(false);
});
