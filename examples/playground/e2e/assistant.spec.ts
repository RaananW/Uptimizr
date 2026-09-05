import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
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

/**
 * Count the tool results already gathered in the CURRENT turn: the number of
 * `role:"tool"` messages after the last `role:"user"` message. Lets the mock
 * make a few tool calls per turn and then answer, deterministically. Plain array
 * scan — no regex over model/tool output (CodeQL ReDoS).
 */
function toolCallsSinceLastUser(messages: OpenAiRequestMessage[]): number {
  let lastUser = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "user") {
      lastUser = i;
      break;
    }
  }
  let count = 0;
  for (let i = lastUser + 1; i < messages.length; i++) {
    if (messages[i].role === "tool") count += 1;
  }
  return count;
}

/**
 * Do two axis-aligned rectangles overlap (share any area)? Used to prove the
 * message column and the tool-activity list do not visually collide.
 */
function rectsOverlap(
  a: { x: number; y: number; width: number; height: number },
  b: { x: number; y: number; width: number; height: number },
): boolean {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}

/** A long, multi-line answer that makes the conversation column tall (screenshot-like). */
const LONG_ANSWER = [
  "Your top meshes used this week are:",
  "1. box-1 (48 instances)",
  "2. sphere-2 (41 instances)",
  "3. plane-3 (37 instances)",
  "4. cylinder-4 (33 instances)",
  "5. torus-5 (29 instances)",
  "6. cone-6 (24 instances)",
  "7. capsule-7 (21 instances)",
  "8. disc-8 (18 instances)",
  "9. ground-9 (15 instances)",
  "10. ramp-10 (11 instances)",
].join("\n");

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
  //     tell it's doing anything" — it must appear even when the LLM does not
  //     stream (this mock answers in one JSON body; the streaming path is covered
  //     by the dedicated SSE test below). The regex targets our own fixed UI
  //     labels only (no ReDoS surface).
  await expect(assistant.getByRole("status")).toContainText(
    /Thinking|Running analytics|Loading model|Streaming/,
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

/**
 * Guided-prompt round trip: the empty conversation offers labelled starter
 * questions, each mapping to a SINGLE core tool — the reliable first-run path for
 * a small local model. Clicking one must send it and run one grounded turn. We
 * reuse the same mocked hosted backend (no weights): turn 1 calls `top_meshes`,
 * turn 2 grounds the answer in the real collector rows. Real WebLLM answer
 * quality can only be verified in a WebGPU browser (WebLLM can't run in CI/Node),
 * so — like the other assistant specs — this uses the deterministic mock.
 */
test("assistant sends a guided example prompt and answers it end to end", async ({
  page,
  request,
}) => {
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

  // 2) Deterministic LLM: call `top_meshes`, then ground the final answer.
  await page.route("**/mock-llm/**", async (route: Route) => {
    const body = route.request().postDataJSON() as { messages?: OpenAiRequestMessage[] };
    const messages = body.messages ?? [];
    const toolResult = latestToolResult(messages);

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

    const mesh = topMeshFromResult(toolResult) ?? "unknown";
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: completion({ content: `The most-interacted mesh is ${mesh}.` }),
    });
  });

  // 3) Connect the dashboard, configure the mocked hosted backend.
  await page.goto(DASHBOARD_URL);
  await page.getByPlaceholder("http://localhost:4318").fill(COLLECTOR_URL);
  await page.getByPlaceholder("utk_…").fill(API_KEY);
  await page.getByRole("button", { name: /load/i }).click();
  await expect(page.getByText("Top meshes")).toBeVisible({ timeout: 20_000 });

  await page.getByRole("button", { name: "Ask the assistant" }).click();
  const assistant = page.getByRole("region", { name: "Analytics assistant" });
  await assistant.getByRole("button", { name: "Use hosted key" }).click();
  await assistant.getByLabel("Endpoint").fill(MOCK_LLM_ENDPOINT);
  await assistant.getByLabel("API key").fill("mock-key");
  await assistant.getByLabel("Hosted model").fill("mock-model");
  await assistant.getByRole("button", { name: "Use this provider" }).click();

  // 4) Click a guided example prompt instead of typing — it must send verbatim.
  await assistant.getByRole("button", { name: "What are my top meshes this week?" }).click();

  // 5) The clicked question is surfaced as the user turn.
  await expect(assistant.getByText("What are my top meshes this week?")).toBeVisible();

  // 6) The single core tool ran and the grounded answer names the real top mesh.
  const toolActivity = assistant.getByRole("list", { name: "Tool activity" });
  await expect(toolActivity.getByText("top_meshes")).toBeVisible({ timeout: 20_000 });
  const answer = assistant.locator('[data-role="assistant"]');
  await expect(answer).toContainText(expectedTopMesh!, { timeout: 20_000 });
});

/**
 * Layout regression for the demo.uptimizr.com bug (this PR): after turns with
 * many repeated tool calls and long answers, the faint **Tool activity** list was
 * painted ON TOP OF the chat message column. Root cause: the scroll container is a
 * height-capped flex column whose `<ol>` (Conversation) had `min-h` and default
 * `flex-shrink:1`, so under pressure it shrank BELOW its content and its
 * `overflow:visible` messages spilled over the following `<ul>`. The fix makes the
 * scroll children `shrink-0` so the column keeps its natural height and the
 * container scrolls as one unit.
 *
 * We reproduce it deterministically with the mocked hosted backend (no weights):
 * every tools-enabled request calls `top_meshes` a few times, then a LONG numbered
 * answer — driven over two turns so the conversation column exceeds the panel's
 * `max-h-[24rem]`. We then MEASURE box positions and assert the last rendered
 * message and the tool-activity list do NOT intersect (they did, pre-fix).
 */
test("tool-activity list never overlaps the message column (layout regression)", async ({
  page,
  request,
}, testInfo) => {
  // 1) Real session so the `top_meshes` tool the loop calls returns real rows.
  await enableAllCapture(page, "babylon");
  const sessionId = await bootEngine(page, "babylon");
  await driveInteractions(page, { keyboard: true });
  await waitForEventTypes(request, sessionId, ["mesh_interaction", "pointer_click"]);

  // 2) Mock: a few `top_meshes` calls per turn, then a long multi-line answer.
  await page.route("**/mock-llm/**", async (route: Route) => {
    const body = route.request().postDataJSON() as {
      messages?: OpenAiRequestMessage[];
      tools?: unknown;
    };
    const messages = body.messages ?? [];

    if (requestHasTools(body) && toolCallsSinceLastUser(messages) < 3) {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: completion({
          content: "",
          tool_calls: [
            {
              id: `call_${messages.length}`,
              type: "function",
              function: { name: "top_meshes", arguments: JSON.stringify({ limit: 5 }) },
            },
          ],
        }),
      });
      return;
    }

    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: completion({ content: LONG_ANSWER }),
    });
  });

  // 3) Connect the dashboard and configure the mocked hosted backend.
  await page.goto(DASHBOARD_URL);
  await page.getByPlaceholder("http://localhost:4318").fill(COLLECTOR_URL);
  await page.getByPlaceholder("utk_…").fill(API_KEY);
  await page.getByRole("button", { name: /load/i }).click();
  await expect(page.getByText("Top meshes")).toBeVisible({ timeout: 20_000 });

  await page.getByRole("button", { name: "Ask the assistant" }).click();
  const assistant = page.getByRole("region", { name: "Analytics assistant" });
  await assistant.getByRole("button", { name: "Use hosted key" }).click();
  await assistant.getByLabel("Endpoint").fill(MOCK_LLM_ENDPOINT);
  await assistant.getByLabel("API key").fill("mock-key");
  await assistant.getByLabel("Hosted model").fill("mock-model");
  await assistant.getByRole("button", { name: "Use this provider" }).click();

  // 4) Two turns so the conversation column grows past the panel's max-height.
  for (let turn = 0; turn < 2; turn++) {
    await assistant.getByLabel("Message").fill("What are my top meshes this week?");
    await assistant.getByRole("button", { name: "Send" }).click();
    // Wait for this turn's answer before sending the next question.
    await expect(assistant.locator('[data-role="assistant"]').nth(turn)).toContainText(
      "box-1 (48 instances)",
      { timeout: 20_000 },
    );
  }

  // 5) The tool activity ran and both regions are present.
  const toolActivity = assistant.getByRole("list", { name: "Tool activity" });
  await expect(toolActivity.getByText("top_meshes")).toBeVisible({ timeout: 20_000 });
  const conversation = assistant.getByRole("list", { name: "Conversation" });
  await expect(conversation).toBeVisible();

  // Attach a screenshot artifact of the panel for visual inspection.
  await testInfo.attach("assistant-panel", {
    body: await assistant.screenshot(),
    contentType: "image/png",
  });

  // 6) MEASURE: the last rendered message and the tool-activity list must not
  //    share any screen area. Pre-fix the shrunk `<ol>`'s content overflowed down
  //    over the `<ul>`, so the last message's box intersected the tool list.
  const lastMessage = assistant.locator('[data-role="assistant"]').last();
  const messageBox = await lastMessage.boundingBox();
  const toolBox = await toolActivity.boundingBox();
  expect(messageBox, "last message must have a layout box").not.toBeNull();
  expect(toolBox, "tool-activity list must have a layout box").not.toBeNull();

  expect(
    rectsOverlap(messageBox!, toolBox!),
    `message box ${JSON.stringify(messageBox)} must not overlap tool-activity box ${JSON.stringify(
      toolBox,
    )}`,
  ).toBe(false);

  // And, being vertically ordered, the message must end at or above the tool list
  // (a 1px tolerance absorbs sub-pixel rounding).
  expect(messageBox!.y + messageBox!.height).toBeLessThanOrEqual(toolBox!.y + 1);
});

/**
 * A tiny OpenAI-compatible **streaming** mock (issue #212). Playwright's
 * `route.fulfill` hands the browser a whole body at once, so it cannot exercise
 * incremental delivery; this real `node:http` server does, answering the
 * panel's hosted adapter with `text/event-stream` chunks spaced out in time —
 * a tool call first (as tool-call deltas), then the grounded answer one word at
 * a time. It sends permissive CORS headers because the dashboard calls it
 * cross-origin, exactly like a user's own provider would. Bound to 127.0.0.1 on
 * an ephemeral port; closed by the test.
 */
async function startStreamingLlm(options: {
  /** The answer, as the fragments to stream, given the parsed tool result. */
  answerFor: (toolResult: unknown) => string[];
  /** Delay between streamed fragments (ms). */
  intervalMs: number;
}): Promise<{ endpoint: string; close: () => Promise<void> }> {
  const cors = {
    "access-control-allow-origin": "*",
    "access-control-allow-headers": "content-type, authorization",
    "access-control-allow-methods": "POST, OPTIONS",
  };
  const server = createServer((req, res) => {
    if (req.method === "OPTIONS") {
      res.writeHead(204, cors);
      res.end();
      return;
    }
    let raw = "";
    req.setEncoding("utf8");
    req.on("data", (chunk: string) => (raw += chunk));
    req.on("end", () => {
      let body: { messages?: OpenAiRequestMessage[] };
      try {
        body = JSON.parse(raw) as { messages?: OpenAiRequestMessage[] };
      } catch {
        body = {};
      }
      const toolResult = latestToolResult(body.messages ?? []);
      res.writeHead(200, {
        ...cors,
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
      });
      res.flushHeaders();
      const send = (chunk: unknown) => res.write(`data: ${JSON.stringify(chunk)}\n\n`);
      const done = () => {
        res.write("data: [DONE]\n\n");
        res.end();
      };

      if (toolResult === null) {
        // Turn 1: a tool call, split across two deltas the way OpenAI streams it.
        send({
          choices: [
            {
              delta: {
                content: null,
                tool_calls: [
                  {
                    index: 0,
                    id: "call_top_meshes",
                    type: "function",
                    function: { name: "top_meshes", arguments: "" },
                  },
                ],
              },
            },
          ],
        });
        send({
          choices: [
            {
              delta: {
                tool_calls: [{ index: 0, function: { arguments: JSON.stringify({ limit: 5 }) } }],
              },
            },
          ],
        });
        send({ choices: [{ delta: {}, finish_reason: "tool_calls" }] });
        done();
        return;
      }

      // Turn 2: stream the grounded answer fragment by fragment, spaced in time.
      const fragments = options.answerFor(toolResult);
      let i = 0;
      const timer = setInterval(() => {
        if (i < fragments.length) {
          send({ choices: [{ delta: { content: fragments[i++] } }] });
          return;
        }
        clearInterval(timer);
        send({ choices: [{ delta: {}, finish_reason: "stop" }] });
        done();
      }, options.intervalMs);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    endpoint: `http://127.0.0.1:${port}/v1`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

/**
 * Streaming E2E (issue #212): the answer must render **incrementally** as the
 * model produces it, for the hosted backend end to end — browser →
 * `<AssistantPanel>` → hosted adapter (SSE, `stream: true`) → real streamed
 * chunks — while the tool-calling loop (a streamed tool call executed against
 * the real collector) keeps working. We assert the intermediate state (a live
 * assistant bubble holding a prefix of the answer while the status says
 * Streaming…), then the final state: one assistant bubble with the full,
 * grounded answer, no streaming marker, indicator cleared.
 */
test("assistant streams the answer incrementally (hosted SSE)", async ({ page, request }) => {
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

  // 2) A real streaming mock provider: a streamed tool call, then the grounded
  //    answer delivered as eight fragments 250 ms apart (~2 s of streaming).
  const llm = await startStreamingLlm({
    intervalMs: 250,
    answerFor: (toolResult) => {
      const mesh = topMeshFromResult(toolResult) ?? "unknown";
      return ["The ", "most-", "interacted ", "mesh ", "in ", "this ", "scene ", `is ${mesh}.`];
    },
  });

  try {
    // 3) Connect the dashboard and point the hosted backend at the mock.
    await page.goto(DASHBOARD_URL);
    await page.getByPlaceholder("http://localhost:4318").fill(COLLECTOR_URL);
    await page.getByPlaceholder("utk_…").fill(API_KEY);
    await page.getByRole("button", { name: /load/i }).click();
    await expect(page.getByText("Top meshes")).toBeVisible({ timeout: 20_000 });

    await page.getByRole("button", { name: "Ask the assistant" }).click();
    const assistant = page.getByRole("region", { name: "Analytics assistant" });
    await assistant.getByRole("button", { name: "Use hosted key" }).click();
    await assistant.getByLabel("Endpoint").fill(llm.endpoint);
    await assistant.getByLabel("API key").fill("mock-key");
    await assistant.getByLabel("Hosted model").fill("mock-model");
    await assistant.getByRole("button", { name: "Use this provider" }).click();

    // 4) Ask; the streamed tool call runs against the real collector.
    await assistant.getByLabel("Message").fill("What was the most-interacted mesh?");
    await assistant.getByRole("button", { name: "Send" }).click();
    const toolActivity = assistant.getByRole("list", { name: "Tool activity" });
    await expect(toolActivity.getByText("top_meshes")).toBeVisible({ timeout: 20_000 });

    // 5) INCREMENTAL: while the answer is still streaming, a live assistant
    //    bubble shows the prefix received so far and the status says Streaming….
    const streaming = assistant.locator('[data-role="assistant"][data-streaming="true"]');
    await expect(streaming).toBeVisible({ timeout: 20_000 });
    await expect(streaming).toContainText("The most-");
    // Captured mid-stream: the answer is not complete yet (the mesh name is the
    // last fragment, ~2 s after the first).
    await expect(streaming).not.toContainText(expectedTopMesh!);
    await expect(assistant.getByRole("status")).toContainText("Streaming");

    // 6) FINAL: the complete grounded answer, as exactly one assistant bubble
    //    (the live bubble was replaced, not duplicated), no streaming marker, and
    //    the working indicator cleared.
    const answer = assistant.locator('[data-role="assistant"]');
    await expect(answer).toContainText(`is ${expectedTopMesh!}.`, { timeout: 20_000 });
    await expect(answer).toHaveCount(1);
    await expect(streaming).toHaveCount(0);
    await expect(answer).toContainText("The most-interacted mesh in this scene is");
    await expect(assistant.getByRole("status")).toHaveText("");
    await expect(assistant.locator('[data-role="notice"]')).toHaveCount(0);
  } finally {
    await llm.close();
  }
});
