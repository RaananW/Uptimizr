/**
 * `uptimizr agent report` — the headless scheduled-report CLI (#312, ADR 0051 §6).
 *
 * Every test drives the real command entry point (`runAgentReport`) against a
 * **real, listening** collector on a real in-memory DuckDB store seeded with the
 * shared parity fixtures, over real HTTP. Only the model is replaced: a scripted
 * `LlmProvider`, in the spirit of `@uptimizr/agent-eval`'s, stands in for a
 * frontier model so the loop, the tool catalog, the collector, the report
 * rendering and the webhook signing are all exercised with no key and no egress.
 *
 * What these assert is the contract an operator schedules against: the Markdown
 * carries the findings *and* an auditable Method section, the JSON report
 * records every call with its arguments and duration, the webhook body is signed
 * with the documented header, `--dry-run` never reaches a provider, and a
 * missing variable fails with one actionable line rather than a stack.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import type { AnyEvent } from "@uptimizr/schema";
import { PARITY_EVENTS, PARITY_PROJECT_ID, PARITY_T0 } from "@uptimizr/db";
import type {
  AgentMessage,
  LlmProvider,
  ProviderRequest,
  ProviderResponse,
} from "@uptimizr/agent-core";
import { buildApp } from "../app.js";
import { createDuckdbStore } from "../duckdbStore.js";
import type { CollectorStore } from "../store.js";
import { TEST_CONFIG, TEST_PROXY } from "./support/registryRequests.js";
import {
  EXIT,
  REPORT_SCHEMA,
  collectToolCalls,
  resolveWindow,
  runAgentReport,
  type AgentReportDeps,
  type AgentReportJson,
} from "../agentReport.js";
import { verifyWebhookSignature } from "../webhookSignature.js";

const API_KEY = "report-key";
const WEBHOOK_SECRET = "shared-webhook-secret";
/** Pinned "now" so windows and the report stamps are deterministic. */
const NOW = 1_800_000_000_000;

let app: FastifyInstance;
let collectorUrl: string;

/** The parity fixtures, moved forward so they sit inside the report window. */
function recentEvents(): AnyEvent[] {
  const shift = NOW - 60_000 - PARITY_T0;
  return PARITY_EVENTS.map((event) => ({ ...event, ts: event.ts + shift }) as AnyEvent);
}

beforeAll(async () => {
  const base = await createDuckdbStore(":memory:");
  await base.insertEvents(recentEvents());
  await base.putSceneProxy(PARITY_PROJECT_ID, TEST_PROXY, "Main Lobby");
  const store: CollectorStore = {
    ...base,
    resolveApiKey: async (key) =>
      key === API_KEY
        ? {
            projectId: PARITY_PROJECT_ID,
            keyId: "report-key-id",
            capabilities: ["query"],
            label: "report test",
            rateLimit: null,
          }
        : null,
  };
  app = await buildApp({ store, config: TEST_CONFIG });
  await app.listen({ port: 0, host: "127.0.0.1" });
  const address = app.server.address() as AddressInfo;
  collectorUrl = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  await app.close();
});

/** Captured process surface for one invocation. */
interface Captured {
  stdout: string;
  stderr: string[];
  files: Record<string, string>;
  providerCalls: number;
  code: number;
}

/**
 * A scripted provider: on its first turn it asks for every tool the skill's
 * method names, scoped to the run's window; on its second it answers from what
 * the collector actually returned. Deliberately NOT an echo of the question —
 * the answer is a rendering of live tool output, exactly like the eval harness's
 * mock, so a broken tool route fails here rather than being papered over.
 */
function scriptedProvider(toolNames: readonly string[], onCall: () => void): LlmProvider {
  return {
    async complete(request: ProviderRequest): Promise<ProviderResponse> {
      onCall();
      const results = request.messages.filter(
        (message): message is AgentMessage & { role: "tool" } => message.role === "tool",
      );
      if (results.length === 0 && request.tools.length > 0) {
        return {
          kind: "tool_calls",
          usage: { inputTokens: 1200, outputTokens: 64 },
          // Not filtered against the advertised catalog on purpose: a case can
          // name a tool that does not exist, which is how the loop's rejection
          // path (and the report's "failed" row) gets exercised.
          toolCalls: toolNames.map((name, index) => ({
            id: `call-${index}`,
            name,
            arguments: { since: NOW - 7 * 86_400_000, until: NOW },
          })),
        };
      }
      return {
        kind: "final",
        usage: { inputTokens: 2400, outputTokens: 128 },
        content:
          `Traffic looks healthy across the window.\n\n` +
          results
            .map((message) => `- \`${message.name}\`: ${message.content.length} chars`)
            .join("\n"),
      };
    },
  };
}

/** Run the command with a captured process surface. */
async function run(
  argv: string[],
  options: {
    env?: Record<string, string | undefined>;
    provider?: LlmProvider;
    toolNames?: readonly string[];
  } = {},
): Promise<Captured> {
  const captured: Captured = { stdout: "", stderr: [], files: {}, providerCalls: 0, code: -1 };
  const deps: Partial<AgentReportDeps> = {
    env: {
      UPTIMIZR_COLLECTOR_URL: collectorUrl,
      UPTIMIZR_API_KEY: API_KEY,
      // A placeholder: the provider is injected, but the command still resolves
      // its configuration from the environment exactly as it would in anger.
      UPTIMIZR_AGENT_API_KEY: "not-a-real-key",
      ...options.env,
    } as NodeJS.ProcessEnv,
    now: () => NOW,
    stdout: (text) => {
      captured.stdout += text;
    },
    stderr: (line) => captured.stderr.push(line),
    writeFile: (path, content) => {
      captured.files[path] = content;
    },
    createProvider: () =>
      options.provider ??
      scriptedProvider(options.toolNames ?? ["event_counts", "perf_summary"], () => {
        captured.providerCalls += 1;
      }),
  };
  captured.code = await runAgentReport(argv, deps);
  return captured;
}

/** Read back the single file the run wrote under a given extension. */
function fileEndingWith(captured: Captured, suffix: string): string {
  const entry = Object.entries(captured.files).find(([path]) => path.endsWith(suffix));
  if (!entry) throw new Error(`no file ending in ${suffix}; wrote ${Object.keys(captured.files)}`);
  return entry[1];
}

describe("uptimizr agent report", () => {
  it("lists the curated skills", async () => {
    const captured = await run(["--list-skills"]);
    expect(captured.code).toBe(EXIT.ok);
    expect(captured.stdout).toContain("weekly_scene_health");
    expect(captured.stdout).toContain("attention_hotspots");
    expect(captured.stdout).toContain("xr_comfort_review");
    // The tools a skill's method relies on are part of the listing, so an
    // operator can see what a scheduled run will read before scheduling it.
    expect(captured.stdout).toContain("Tools: insight_scene_health");
  });

  it("prints usage on --help without touching the collector", async () => {
    const captured = await run(["--help"], { env: { UPTIMIZR_COLLECTOR_URL: undefined } });
    expect(captured.code).toBe(EXIT.ok);
    expect(captured.stdout).toContain("--skill <name>");
    expect(captured.stdout).toContain("UPTIMIZR_AGENT_PROVIDER");
    expect(captured.providerCalls).toBe(0);
  });

  it("rejects a missing --skill, an unknown skill and an unknown flag", async () => {
    const missing = await run([]);
    expect(missing.code).toBe(EXIT.usage);
    expect(missing.stderr.join("\n")).toContain("--skill is required");

    const unknown = await run(["--skill", "no_such_skill"]);
    expect(unknown.code).toBe(EXIT.usage);
    expect(unknown.stderr.join("\n")).toContain("weekly_scene_health");

    const typo = await run(["--skill", "weekly_scene_health", "--scenes", "lobby"]);
    expect(typo.code).toBe(EXIT.usage);
    expect(typo.stderr.join("\n")).toContain("Unknown flag --scenes");
  });

  it("requires the collector environment, naming exactly what to set", async () => {
    const noUrl = await run(["--skill", "weekly_scene_health"], {
      env: { UPTIMIZR_COLLECTOR_URL: undefined },
    });
    expect(noUrl.code).toBe(EXIT.usage);
    expect(noUrl.stderr.join("\n")).toContain("UPTIMIZR_COLLECTOR_URL is not set");
    expect(noUrl.providerCalls).toBe(0);

    const noKey = await run(["--skill", "weekly_scene_health"], {
      env: { UPTIMIZR_API_KEY: undefined },
    });
    expect(noKey.code).toBe(EXIT.usage);
    expect(noKey.stderr.join("\n")).toContain("UPTIMIZR_API_KEY is not set");
  });

  it("requires a scene for a scene-scoped skill", async () => {
    const captured = await run(["--skill", "attention_hotspots"]);
    expect(captured.code).toBe(EXIT.usage);
    expect(captured.stderr.join("\n")).toContain("needs --scene");
  });

  it("refuses a provider key that is not configured", async () => {
    const captured = await run(["--skill", "weekly_scene_health"], {
      env: {
        UPTIMIZR_AGENT_PROVIDER: "anthropic",
        UPTIMIZR_AGENT_API_KEY: undefined,
        ANTHROPIC_API_KEY: undefined,
      },
      // The default provider factory must never be reached; assert via the code.
      provider: undefined,
    });
    // `createProvider` is injected in tests, so resolution is what fails first.
    expect(captured.code).toBe(EXIT.usage);
    expect(captured.stderr.join("\n")).toContain("No provider key");
  });

  it("--dry-run prints the prompt and tool list and calls no provider", async () => {
    const captured = await run(["--skill", "weekly_scene_health", "--scene", "lobby", "--dry-run"]);
    expect(captured.code).toBe(EXIT.ok);
    expect(captured.providerCalls).toBe(0);
    expect(captured.stdout).toContain("# Dry run — skill `weekly_scene_health`");
    expect(captured.stdout).toContain("## System prompt");
    expect(captured.stdout).toContain("## User turn");
    // The skill's own text and the project context both reach the prompt.
    expect(captured.stdout).toContain("weekly health report");
    expect(captured.stdout).toContain("Project context (read from this collector");
    // The skills say "read the uptimizr://context resource first"; headlessly there
    // is no resource, so the prompt says the document is already in front of it.
    expect(captured.stdout).toContain("It has already been read for you");
    expect(captured.stdout).toContain('Scope: scene "lobby"');
    // No provider configuration is needed to preview a run.
    expect(captured.stdout).toContain("not called");
  });

  it("--dry-run needs no provider environment at all (the CI smoke path)", async () => {
    const captured = await run(["--skill", "xr_comfort_review", "--dry-run"], {
      env: {
        UPTIMIZR_AGENT_PROVIDER: undefined,
        UPTIMIZR_AGENT_API_KEY: undefined,
        ANTHROPIC_API_KEY: undefined,
        OPENAI_API_KEY: undefined,
      },
    });
    expect(captured.code).toBe(EXIT.ok);
    expect(captured.providerCalls).toBe(0);
    expect(captured.stdout).toContain("xr_rotation");
  });

  it("produces Markdown with findings and an auditable Method section", async () => {
    const captured = await run([
      "--skill",
      "weekly_scene_health",
      "--scene",
      "lobby",
      "--out",
      "report.md",
      "--json",
      "report.json",
    ]);

    expect(captured.code).toBe(EXIT.ok);
    expect(captured.providerCalls).toBe(2);

    const markdown = fileEndingWith(captured, "report.md");
    expect(markdown).toContain("# Weekly scene health");
    expect(markdown).toContain("scene `lobby`");
    expect(markdown).toContain("Traffic looks healthy");
    expect(markdown).toContain("## Method");
    // Every call is listed with the arguments it was made with.
    expect(markdown).toContain("| `event_counts` |");
    expect(markdown).toContain("| `perf_summary` |");
    expect(markdown).toContain(`"since":${NOW - 7 * 86_400_000}`);
    expect(markdown).toContain("## Run");
    expect(markdown).toContain("- Skill: `weekly_scene_health`");
    expect(markdown).toContain("Tokens: 3600 in / 192 out");
  });

  it("writes a structured JSON report with per-call durations and usage", async () => {
    const captured = await run([
      "--skill",
      "weekly_scene_health",
      "--out",
      "out.md",
      "--json",
      "out.json",
    ]);

    const report = JSON.parse(fileEndingWith(captured, "out.json")) as AgentReportJson;
    expect(report.schema).toBe(REPORT_SCHEMA);
    expect(report.skill).toBe("weekly_scene_health");
    expect(report.scene).toBeNull();
    expect(report.provider.kind).toBe("anthropic");
    expect(report.window.until).toBe(NOW);
    expect(report.window.since).toBe(NOW - 7 * 86_400_000);
    expect(report.steps).toBe(2);
    expect(report.stoppedOnMaxSteps).toBe(false);
    expect(report.context.available).toBe(true);
    expect(report.usage).toEqual({ inputTokens: 3600, outputTokens: 192 });
    expect(report.toolCalls).toHaveLength(2);
    for (const call of report.toolCalls) {
      expect(call.ok).toBe(true);
      expect(call.error).toBeNull();
      expect(typeof call.durationMs).toBe("number");
      expect(call.arguments).toMatchObject({ until: NOW });
      expect(call.resultChars).toBeGreaterThan(0);
    }
    expect(report.answer).toContain("Traffic looks healthy");
    // The provider key is never anywhere near the report.
    expect(JSON.stringify(report)).not.toContain("apiKey");
  });

  it("defaults the Markdown to stdout", async () => {
    const captured = await run(["--skill", "weekly_scene_health"]);
    expect(captured.code).toBe(EXIT.ok);
    expect(captured.stdout).toContain("# Weekly scene health");
    expect(captured.files).toEqual({});
  });

  it("honours --window and --since/--until", async () => {
    const window = await run([
      "--skill",
      "weekly_scene_health",
      "--window",
      "24h",
      "--json",
      "w.json",
      "--out",
      "w.md",
    ]);
    const windowed = JSON.parse(fileEndingWith(window, "w.json")) as AgentReportJson;
    expect(windowed.window).toEqual({ since: NOW - 86_400_000, until: NOW, label: "24h" });

    const explicit = await run([
      "--skill",
      "weekly_scene_health",
      "--since",
      String(NOW - 1000),
      "--until",
      String(NOW),
      "--json",
      "e.json",
      "--out",
      "e.md",
    ]);
    const explicitReport = JSON.parse(fileEndingWith(explicit, "e.json")) as AgentReportJson;
    expect(explicitReport.window).toEqual({ since: NOW - 1000, until: NOW, label: "explicit" });

    const clash = await run(["--skill", "weekly_scene_health", "--window", "7d", "--since", "1"]);
    expect(clash.code).toBe(EXIT.usage);
    expect(clash.stderr.join("\n")).toContain("not both");
  });

  it("reports a failed tool call in the Method section and exits non-zero", async () => {
    const captured = await run(
      ["--skill", "weekly_scene_health", "--out", "bad.md", "--json", "bad.json"],
      {
        toolNames: ["event_counts", "not_a_tool"],
      },
    );
    expect(captured.code).toBe(EXIT.incomplete);
    const report = JSON.parse(fileEndingWith(captured, "bad.json")) as AgentReportJson;
    const failed = report.toolCalls.find((call) => !call.ok);
    expect(failed?.name).toBe("not_a_tool");
    // A tool rejected before any request has no duration to report.
    expect(failed?.durationMs).toBeNull();
    expect(fileEndingWith(captured, "bad.md")).toContain("**failed**");
  });

  it("exits with the provider code when the provider throws", async () => {
    const captured = await run(["--skill", "weekly_scene_health"], {
      provider: {
        complete: () => Promise.reject(new Error("429 rate limited")),
      },
    });
    expect(captured.code).toBe(EXIT.provider);
    expect(captured.stderr.join("\n")).toContain("provider failed: 429 rate limited");
  });

  it("streams tool calls to stderr as they happen", async () => {
    const captured = await run(["--skill", "weekly_scene_health"]);
    const stderr = captured.stderr.join("\n");
    expect(stderr).toContain("step 1: event_counts");
    expect(stderr).toContain("✓ api/v1/");
    expect(stderr).toContain("query`-only key is recommended");
  });
});

describe("webhook delivery", () => {
  let server: Server;
  let webhookUrl: string;
  const received: { body: string; headers: NodeJS.Dict<string | string[]> }[] = [];

  beforeAll(async () => {
    server = createServer((req: IncomingMessage, res: ServerResponse) => {
      let body = "";
      req.on("data", (chunk) => {
        body += chunk;
      });
      req.on("end", () => {
        received.push({ body, headers: req.headers });
        res.writeHead(req.url?.includes("fail-me") ? 500 : 202).end();
      });
    });
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    const address = server.address() as AddressInfo;
    webhookUrl = `http://127.0.0.1:${address.port}/hook`;
  });

  afterAll(async () => {
    await new Promise<void>((done) => server.close(() => done()));
  });

  it("posts the Markdown and the JSON report, signed over the exact bytes", async () => {
    const captured = await run(
      ["--skill", "weekly_scene_health", "--out", "hooked.md", "--webhook", webhookUrl],
      {
        env: { UPTIMIZR_WEBHOOK_SECRET: WEBHOOK_SECRET },
      },
    );
    expect(captured.code).toBe(EXIT.ok);
    expect(received).toHaveLength(1);

    const delivery = received[0]!;
    const payload = JSON.parse(delivery.body) as { markdown: string; report: AgentReportJson };
    expect(payload.markdown).toContain("## Method");
    expect(payload.report.skill).toBe("weekly_scene_health");

    const signature = delivery.headers["x-uptimizr-signature"] as string;
    expect(signature.startsWith("sha256=")).toBe(true);
    expect(verifyWebhookSignature(WEBHOOK_SECRET, delivery.body, signature)).toBe(true);
    // The signature is over the body, so any tampering invalidates it.
    expect(verifyWebhookSignature(WEBHOOK_SECRET, `${delivery.body} `, signature)).toBe(false);
    expect(verifyWebhookSignature("wrong-secret", delivery.body, signature)).toBe(false);
    expect(delivery.headers["x-uptimizr-delivery"]).toBeTruthy();
  });

  it("warns, but still delivers, when no secret is configured", async () => {
    received.length = 0;
    const captured = await run(
      ["--skill", "weekly_scene_health", "--out", "u.md", "--webhook", webhookUrl],
      {
        env: { UPTIMIZR_WEBHOOK_SECRET: undefined },
      },
    );
    expect(captured.code).toBe(EXIT.ok);
    expect(received[0]!.headers["x-uptimizr-signature"]).toBeUndefined();
    expect(captured.stderr.join("\n")).toContain("will be unsigned");
  });

  it("rejects a non-http(s) webhook URL before running anything", async () => {
    const captured = await run([
      "--skill",
      "weekly_scene_health",
      "--webhook",
      "file:///etc/passwd",
    ]);
    expect(captured.code).toBe(EXIT.usage);
    expect(captured.stderr.join("\n")).toContain("must use http or https");
    expect(captured.providerCalls).toBe(0);
  });

  it("exits with the provider code when the receiver rejects the delivery", async () => {
    received.length = 0;
    const captured = await run(
      ["--skill", "weekly_scene_health", "--out", "f.md", "--webhook", `${webhookUrl}?q=fail-me`],
      { env: { UPTIMIZR_WEBHOOK_SECRET: WEBHOOK_SECRET } },
    );
    expect(captured.code).toBe(EXIT.provider);
    expect(captured.stderr.join("\n")).toContain("returned 500");
  });
});

describe("pure helpers", () => {
  it("resolves relative windows and rejects nonsense", () => {
    expect(resolveWindow({}, NOW)).toEqual({
      since: NOW - 7 * 86_400_000,
      until: NOW,
      label: "7d",
    });
    expect(resolveWindow({ window: "2w" }, NOW).since).toBe(NOW - 14 * 86_400_000);
    expect(resolveWindow({ window: "12h" }, NOW).since).toBe(NOW - 12 * 3_600_000);
    expect(() => resolveWindow({ window: "7" }, NOW)).toThrow(/positive whole number/);
    expect(() => resolveWindow({ window: "0d" }, NOW)).toThrow(/positive whole number/);
    expect(() => resolveWindow({ window: "7y" }, NOW)).toThrow(/positive whole number/);
  });

  it("pairs timed reads with the tool calls that made them", () => {
    const messages: AgentMessage[] = [
      {
        role: "assistant",
        content: "",
        toolCalls: [
          { id: "a", name: "nope", arguments: {} },
          { id: "b", name: "event_counts", arguments: { since: 1 } },
        ],
      },
      { role: "tool", toolCallId: "a", name: "nope", content: 'Error: unknown tool "nope".' },
      { role: "tool", toolCallId: "b", name: "event_counts", content: '{"rows":[]}' },
    ];
    const calls = collectToolCalls(messages, [
      { path: "api/v1/events/counts", durationMs: 7, ok: true },
    ]);
    expect(calls).toHaveLength(2);
    // The rejected call consumed no request, so the one timed read belongs to
    // the call that actually reached the collector.
    expect(calls[0]).toMatchObject({ name: "nope", ok: false, durationMs: null });
    expect(calls[1]).toMatchObject({ name: "event_counts", ok: true, durationMs: 7 });
  });
});
