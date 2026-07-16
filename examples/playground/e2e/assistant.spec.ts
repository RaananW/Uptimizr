import { expect, test, type Route } from "@playwright/test";

import { API_KEY, COLLECTOR_URL, DASHBOARD_URL } from "./constants.js";
import {
  bootEngine,
  driveInteractions,
  enableAllCapture,
  waitForEventTypes,
} from "./helpers/capture.js";

/**
 * Full round-trip E2E for the in-browser analytics assistant (issue #193, the
 * final ADR 0050 issue). It drives a real Babylon session so the collector's
 * DuckDB store has mesh-interaction data, opens the Next.js dashboard's assistant
 * drawer, and runs one grounded turn: browser → `<AssistantPanel>` → the shared
 * read-only tool contract → the real collector → a grounded answer.
 *
 * The LLM is mocked deterministically so CI never downloads WebLLM weights and the
 * test is fast + hermetic. We configure the panel's **bring-your-own hosted**
 * (OpenAI-compatible) backend pointed at a **same-origin** dashboard URL
 * (`/mock-llm`, so there is no cross-origin preflight) and fulfil it with
 * Playwright routing:
 *   - Turn 1 (no tool result yet) → reply with an OpenAI `tool_calls` message
 *     invoking `top_meshes`. The real agent loop executes it through the same
 *     `CollectorApi.read` the dashboard panels use, hitting the real collector.
 *   - Turn 2 (the tool result is now in the transcript) → the mock reads the tool
 *     message the loop produced and returns a final answer that **echoes the real
 *     top mesh** — a grounded answer, not a canned one.
 *
 * We then assert the tool ran and the rendered answer names the top mesh, cross
 * checked against a direct collector query. The mock parses with `JSON.parse` and
 * plain array scans only — no regex over model/tool output (CodeQL ReDoS).
 */

/** Same-origin endpoint the panel's hosted OpenAI adapter POSTs to. */
const MOCK_LLM_ENDPOINT = `${DASHBOARD_URL}/mock-llm`;

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
}) {
  return JSON.stringify({ choices: [{ message }] });
}

/** Pull the most-recent `role:"tool"` message's parsed JSON content, if any. */
function latestToolResult(messages: OpenAiRequestMessage[]): unknown {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role === "tool" && typeof m.content === "string") {
      try {
        return JSON.parse(m.content);
      } catch {
        return null;
      }
    }
  }
  return null;
}

/** Extract the top mesh id from a `top_meshes` result (array of {mesh,count}). */
function topMeshFromResult(result: unknown): string | null {
  const rows = Array.isArray(result)
    ? result
    : Array.isArray((result as { rows?: unknown[] })?.rows)
      ? (result as { rows: unknown[] }).rows
      : [];
  for (const row of rows) {
    const mesh = (row as { mesh?: unknown })?.mesh;
    if (typeof mesh === "string" && mesh.length > 0) return mesh;
  }
  return null;
}

/** True when the request body advertises at least one tool (function-calling). */
function requestHasTools(body: { tools?: unknown }): boolean {
  return Array.isArray(body.tools) && body.tools.length > 0;
}

test("assistant answers a grounded question end to end", async ({ page, request }) => {
  // 1) Produce a real session so `top_meshes` has data (a box mesh gets picked).
  await enableAllCapture(page, "babylon");
  const sessionId = await bootEngine(page, "babylon");
  await driveInteractions(page, { keyboard: true });
  await waitForEventTypes(request, sessionId, ["mesh_interaction", "pointer_click"]);

  // Ground truth: the collector's own answer, fetched directly with the same key.
  const topRes = await request.get(`${COLLECTOR_URL}/api/v1/meshes/top`, {
    headers: { "x-api-key": API_KEY },
  });
  expect(topRes.ok()).toBeTruthy();
  const expectedTopMesh = topMeshFromResult(await topRes.json());
  expect(expectedTopMesh, "seeded session should yield a top mesh").toBeTruthy();

  // 2) Deterministic LLM: fulfil the hosted endpoint ourselves (no real weights).
  await page.route("**/mock-llm/**", async (route: Route) => {
    const body = route.request().postDataJSON() as { messages?: OpenAiRequestMessage[] };
    const messages = body.messages ?? [];
    const toolResult = latestToolResult(messages);

    if (toolResult === null) {
      // Turn 1: ask the loop to run the shared `top_meshes` tool.
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: completion({
          content: "",
          tool_calls: [
            {
              id: "call_top_meshes",
              type: "function",
              function: { name: "top_meshes", arguments: JSON.stringify({ limit: 5 }) },
            },
          ],
        }),
      });
      return;
    }

    // Turn 2: ground the final answer in the real collector rows.
    const mesh = topMeshFromResult(toolResult) ?? "unknown";
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: completion({
        content: `The most-interacted mesh is ${mesh}.`,
      }),
    });
  });

  // 3) Open the dashboard and connect to the collector.
  await page.goto(DASHBOARD_URL);
  await page.getByPlaceholder("http://localhost:4318").fill(COLLECTOR_URL);
  await page.getByPlaceholder("utk_…").fill(API_KEY);
  await page.getByRole("button", { name: /load/i }).click();

  // The connected dashboard renders — the assistant drawer is available.
  await expect(page.getByText("Top meshes")).toBeVisible({ timeout: 20_000 });

  // 4) Open the assistant and configure the (mocked) hosted backend. On first
  //    open the panel presents an explicit backend chooser (no auto-preselect),
  //    so we assert BOTH options are offered, then pick bring-your-own hosted.
  await page.getByRole("button", { name: "Ask the assistant" }).click();
  const assistant = page.getByRole("region", { name: "Analytics assistant" });

  await expect(assistant.getByRole("heading", { name: "Local (in-browser)" })).toBeVisible();
  await expect(assistant.getByRole("heading", { name: "Bring your own hosted key" })).toBeVisible();

  // Choose the bring-your-own hosted path (WebGPU is typically unavailable in CI,
  // so the local option is disabled; hosted is the reliable, weight-free route).
  await assistant.getByRole("button", { name: "Use hosted key" }).click();
  await assistant.getByLabel("Endpoint").fill(MOCK_LLM_ENDPOINT);
  await assistant.getByLabel("API key").fill("mock-key");
  await assistant.getByLabel("Hosted model").fill("mock-model");
  await assistant.getByRole("button", { name: "Use this provider" }).click();

  // 5) Ask a grounded question and send it.
  await assistant.getByLabel("Message").fill("What was the most-interacted mesh?");
  await assistant.getByRole("button", { name: "Send" }).click();

  // 5a) The panel makes it obvious the assistant is working: a live status region
  //     shows a spinner + label (Running analytics… / Thinking…) for the whole
  //     in-flight turn, before any answer arrives. This is the fix for "I can't
  //     tell it's doing anything" — it must appear even though the LLM does not
  //     stream. The regex targets our own fixed UI labels only (no ReDoS surface).
  await expect(assistant.getByRole("status")).toContainText(
    /Thinking|Running analytics|Loading model/,
    { timeout: 20_000 },
  );

  // 6) The shared `top_meshes` tool ran (browser → assistant → tools → collector).
  const toolActivity = assistant.getByRole("list", { name: "Tool activity" });
  await expect(toolActivity.getByText("top_meshes")).toBeVisible({ timeout: 20_000 });

  // 7) The rendered answer is grounded: it names the real top mesh.
  const answer = assistant.locator('[data-role="assistant"]');
  await expect(answer).toContainText(expectedTopMesh!, { timeout: 20_000 });

  // 7a) Once the turn completes the working indicator clears (idle, no spinner).
  await expect(assistant.getByRole("status")).toHaveText("");

  // 8) The backend selection stage is reachable at any time: "Change backend"
  //    reopens the side-by-side chooser cards (both options), and the escape
  //    hatch returns to chat with the backend unchanged (ADR 0050). WebGPU is
  //    typically unavailable in CI, so the local↔hosted *switch* itself is
  //    covered by the AssistantPanel component tests; here we assert the
  //    discoverable affordance + escape round-trip.
  await assistant.getByRole("button", { name: "Change backend" }).click();
  await expect(assistant.getByRole("heading", { name: "Local (in-browser)" })).toBeVisible();
  await expect(assistant.getByRole("heading", { name: "Bring your own hosted key" })).toBeVisible();
  await assistant.getByRole("button", { name: /Back to chat/i }).click();
  await expect(assistant.getByLabel("Message")).toBeVisible();
});

/**
 * Regression E2E for the "model gathered data but never wrote an answer" bug: a
 * small local model returns an EMPTY `final` even after a tool ran, so the user
 * saw nothing. The fix is `runAgent`'s forced, tools-disabled synthesis pass —
 * when a turn ends empty, the loop makes ONE more `provider.complete()` with no
 * tools, forcing a plain-text answer from the tool results already gathered.
 *
 * We reproduce it with the same mocked hosted backend (no weights): while tools
 * are offered the mock first calls `top_meshes`, then returns an EMPTY final; on
 * the forced call (the loop sends NO `tools`) it returns a grounded answer. The
 * rendered reply must name the real top mesh — proving the forced pass recovered
 * an answer that would otherwise have been dropped.
 */
test("assistant recovers an empty answer via the forced final pass", async ({ page, request }) => {
  // 1) Real session so `top_meshes` has data.
  await enableAllCapture(page, "babylon");
  const sessionId = await bootEngine(page, "babylon");
  await driveInteractions(page, { keyboard: true });
  await waitForEventTypes(request, sessionId, ["mesh_interaction", "pointer_click"]);

  const topRes = await request.get(`${COLLECTOR_URL}/api/v1/meshes/top`, {
    headers: { "x-api-key": API_KEY },
  });
  expect(topRes.ok()).toBeTruthy();
  const expectedTopMesh = topMeshFromResult(await topRes.json());
  expect(expectedTopMesh, "seeded session should yield a top mesh").toBeTruthy();

  // 2) Mock: tool-call once, then an EMPTY final while tools are offered; a
  //    grounded final only on the forced (tools-disabled) call.
  await page.route("**/mock-llm/**", async (route: Route) => {
    const body = route.request().postDataJSON() as {
      messages?: OpenAiRequestMessage[];
      tools?: unknown;
    };
    const messages = body.messages ?? [];
    const toolResult = latestToolResult(messages);

    if (requestHasTools(body)) {
      if (toolResult === null) {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: completion({
            content: "",
            tool_calls: [
              {
                id: "call_top_meshes",
                type: "function",
                function: { name: "top_meshes", arguments: JSON.stringify({ limit: 5 }) },
              },
            ],
          }),
        });
        return;
      }
      // Data gathered, but the model "stalls" and returns nothing.
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: completion({ content: "" }),
      });
      return;
    }

    // Forced synthesis pass (no tools): now answer, grounded in the tool result.
    const mesh = topMeshFromResult(toolResult) ?? "unknown";
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: completion({ content: `The most-interacted mesh is ${mesh}.` }),
    });
  });

  // 3) Connect the dashboard to the collector.
  await page.goto(DASHBOARD_URL);
  await page.getByPlaceholder("http://localhost:4318").fill(COLLECTOR_URL);
  await page.getByPlaceholder("utk_…").fill(API_KEY);
  await page.getByRole("button", { name: /load/i }).click();
  await expect(page.getByText("Top meshes")).toBeVisible({ timeout: 20_000 });

  // 4) Configure the mocked hosted backend.
  await page.getByRole("button", { name: "Ask the assistant" }).click();
  const assistant = page.getByRole("region", { name: "Analytics assistant" });
  await assistant.getByRole("button", { name: "Use hosted key" }).click();
  await assistant.getByLabel("Endpoint").fill(MOCK_LLM_ENDPOINT);
  await assistant.getByLabel("API key").fill("mock-key");
  await assistant.getByLabel("Hosted model").fill("mock-model");
  await assistant.getByRole("button", { name: "Use this provider" }).click();

  // 5) Ask a grounded question.
  await assistant.getByLabel("Message").fill("What was the most-interacted mesh?");
  await assistant.getByRole("button", { name: "Send" }).click();

  // 6) The tool ran, and despite the empty final the forced pass produced a
  //    grounded answer that names the real top mesh — no "no answer" dead end.
  const toolActivity = assistant.getByRole("list", { name: "Tool activity" });
  await expect(toolActivity.getByText("top_meshes")).toBeVisible({ timeout: 20_000 });
  const answer = assistant.locator('[data-role="assistant"]');
  await expect(answer).toContainText(expectedTopMesh!, { timeout: 20_000 });
});
