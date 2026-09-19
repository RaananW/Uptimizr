/**
 * `uptimizr agent report` — headless, scheduled analytics reports (ADR 0051 §6,
 * design sketch §F.4).
 *
 * A weekly scene-health digest should not need a human to open a chat. This
 * subcommand runs the **same** headless loop the browser assistant and the MCP
 * server run — `runAgent` from `@uptimizr/agent-core` over the generated
 * read-only tool catalog — once, from a shell, and writes Markdown to a file,
 * to stdout, or to a signed webhook.
 *
 * Three boundaries are deliberate and load-bearing:
 *
 * 1. **The collector gains no in-process LLM loop.** This is a separate process
 *    that talks to the collector over its ordinary HTTP query API with an
 *    ordinary project API key, exactly as any other agent client would. Nothing
 *    here is importable by the server (keep backends thin, ADR 0005).
 * 2. **Scheduling is the operator's.** cron, a systemd timer, a GitHub Action —
 *    the CLI runs once and exits with a meaningful code. Uptimizr operates
 *    nothing (ADR 0017).
 * 3. **Provider configuration comes from the environment only and is never
 *    persisted.** The provider key is read once into the adapter; it is never
 *    logged, echoed, written to a report or included in an error message. The
 *    collector key is likewise never printed.
 *
 * The report is **read-only**: the catalog it exposes performs `GET`s against
 * the query API and nothing else, so a `query`-capability key is all it needs
 * (and all it should be given — #309 / ADR 0051 §7).
 */

import { writeFileSync } from "node:fs";
import { resolve as resolvePath } from "node:path";
import {
  ANALYTICS_AGENT_GUIDELINES,
  AGENT_SKILLS,
  DEFAULT_MAX_STEPS,
  createCollectorClient,
  getAgentSkill,
  readTools,
  renderContextForPrompt,
  renderCurrentTimeLine,
  runAgent,
  type AgentMessage,
  type AgentSkill,
  type CollectorClient,
  type LlmProvider,
  type PromptContextDocument,
  type ProviderRequest,
  type ProviderResponse,
  type ProviderUsage,
  type QueryParams,
  type ReadTool,
} from "@uptimizr/agent-core";
import { createHostedProvider } from "@uptimizr/agent-core/providers/hosted";
import {
  WEBHOOK_DELIVERY_HEADER,
  WEBHOOK_SIGNATURE_HEADER,
  newDeliveryId,
  parseWebhookUrl,
  signWebhookBody,
} from "./webhookSignature.js";

/**
 * A problem the operator can fix, reported as one clear line rather than a
 * stack trace. Everything user-facing this module rejects — a missing variable,
 * an unknown skill, an unreachable provider — is one of these.
 */
export class AgentReportError extends Error {
  constructor(
    message: string,
    /** Process exit code to use (see {@link EXIT}). */
    readonly exitCode: number = EXIT.usage,
  ) {
    super(message);
    this.name = "AgentReportError";
  }
}

/**
 * Exit codes, documented because a scheduled job branches on them.
 *
 * `incomplete` is deliberately non-zero: a digest whose tool calls partly failed
 * is still written (and says so), but a cron wrapper must be able to notice.
 */
export const EXIT = {
  /** The report was produced and every tool call succeeded. */
  ok: 0,
  /** Usage or configuration error — nothing ran. */
  usage: 1,
  /** The provider call, or the webhook delivery, failed. */
  provider: 2,
  /** A report was produced but is incomplete: a tool call failed, or no answer. */
  incomplete: 3,
} as const;

/** Wire formats the hosted adapter speaks, plus the model-free CI provider. */
export type ReportProviderKind = "anthropic" | "openai" | "scripted";

/** Default model per wire format when `UPTIMIZR_AGENT_MODEL` is unset. */
const DEFAULT_MODELS: Record<"anthropic" | "openai", string> = {
  anthropic: "claude-sonnet-5",
  openai: "gpt-4o-mini",
};

/** Default endpoint per wire format when `UPTIMIZR_AGENT_ENDPOINT` is unset. */
const DEFAULT_ENDPOINTS: Record<"anthropic" | "openai", string> = {
  anthropic: "https://api.anthropic.com/v1",
  openai: "https://api.openai.com/v1",
};

/**
 * Output-token ceiling for one provider turn. A report is a few paragraphs plus
 * figures; the loop's step cap bounds the number of turns.
 */
const PROVIDER_MAX_TOKENS = 2048;

/** Default analysis window when neither `--window` nor `--since/--until` is given. */
const DEFAULT_WINDOW = "7d";

/** Version tag on the JSON report, so a consumer can branch on the shape. */
export const REPORT_SCHEMA = "uptimizr.agent-report/1";

/** Injectable process surface, so the whole command is testable in-process. */
export interface AgentReportDeps {
  env: NodeJS.ProcessEnv;
  /** Current time in epoch ms (pinned by tests). */
  now: () => number;
  fetchImpl: typeof fetch;
  /** Report output (stdout): written verbatim, no trailing newline added. */
  stdout: (text: string) => void;
  /** Progress and diagnostics (stderr): one line at a time. */
  stderr: (line: string) => void;
  /** File writer, so tests need no temp directory. */
  writeFile: (path: string, content: string) => void;
  /**
   * Build the LLM backend. Defaults to the hosted adapter (or the scripted
   * provider); tests inject a deterministic one.
   */
  createProvider: (config: ResolvedProvider, context: ProviderContext) => LlmProvider;
}

/** What `createProvider` needs beyond the resolved configuration. */
export interface ProviderContext {
  skill: AgentSkill;
  tools: readonly ReadTool[];
  window: ReportWindow;
  scene?: string;
}

/** The provider configuration, minus the key, which is never surfaced. */
export interface ResolvedProvider {
  kind: ReportProviderKind;
  model: string;
  endpoint: string;
  /** Present only for a hosted run; never logged, reported or serialised. */
  apiKey?: string;
}

/** The analysis window in epoch milliseconds. */
export interface ReportWindow {
  since: number;
  until: number;
  /** How it was expressed (`7d`, or `explicit` for `--since/--until`). */
  label: string;
}

/** One tool call the agent made, as the report records it. */
export interface ReportToolCall {
  name: string;
  arguments: Record<string, unknown>;
  /** Wall-clock milliseconds of the collector request, when one was made. */
  durationMs: number | null;
  ok: boolean;
  /** The error text the loop fed back to the model, when the call failed. */
  error: string | null;
  /** Characters of the result handed back to the model. */
  resultChars: number;
}

/** The structured report written by `--json` and posted to `--webhook`. */
export interface AgentReportJson {
  schema: typeof REPORT_SCHEMA;
  skill: string;
  title: string;
  scene: string | null;
  window: ReportWindow;
  collectorUrl: string;
  provider: { kind: ReportProviderKind; model: string };
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  steps: number;
  maxSteps: number;
  stoppedOnMaxSteps: boolean;
  /** Token accounting summed over the run, when the provider reported any. */
  usage: ProviderUsage | null;
  /** Whether `GET /api/v1/context` answered, and how much prompt it contributed. */
  context: { available: boolean; chars: number };
  toolCalls: ReportToolCall[];
  answer: string;
}

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------

/** Flags that take a value; everything else is a boolean switch. */
const VALUE_FLAGS = new Set([
  "skill",
  "scene",
  "since",
  "until",
  "window",
  "out",
  "json",
  "webhook",
  "max-steps",
]);

/** Boolean switches. */
const BOOL_FLAGS = new Set(["dry-run", "list-skills", "help"]);

interface ParsedArgs {
  flags: Record<string, string>;
  switches: Set<string>;
}

/**
 * Parse `--flag value` / `--flag=value` / `--switch`. Deliberately tiny and
 * dependency-free, matching the rest of the CLI, and strict: an unknown flag is
 * an error rather than being silently ignored, because a typo'd `--scene` in a
 * cron line would otherwise produce a confidently project-wide report.
 */
export function parseAgentReportArgs(argv: readonly string[]): ParsedArgs {
  const flags: Record<string, string> = {};
  const switches = new Set<string>();
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (arg === "--") continue;
    if (!arg.startsWith("--")) {
      throw new AgentReportError(
        `Unexpected argument ${JSON.stringify(arg)}. ` +
          "`uptimizr agent report` takes flags only — see `uptimizr agent report --help`.",
      );
    }
    const eq = arg.indexOf("=");
    const name = eq > 2 ? arg.slice(2, eq) : arg.slice(2);
    if (BOOL_FLAGS.has(name)) {
      if (eq > 2) throw new AgentReportError(`--${name} takes no value.`);
      switches.add(name);
      continue;
    }
    if (!VALUE_FLAGS.has(name)) {
      throw new AgentReportError(
        `Unknown flag --${name}. See \`uptimizr agent report --help\` for the full list.`,
      );
    }
    if (eq > 2) {
      flags[name] = arg.slice(eq + 1);
      continue;
    }
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) {
      throw new AgentReportError(`Missing value for --${name}.`);
    }
    flags[name] = next;
    i += 1;
  }
  return { flags, switches };
}

/** Milliseconds per `--window` unit. */
const WINDOW_UNITS: Record<string, number> = {
  h: 3_600_000,
  d: 86_400_000,
  w: 604_800_000,
};

/**
 * Resolve the analysis window: explicit `--since`/`--until` epoch milliseconds
 * win, otherwise `--window <N><h|d|w>` counts back from now.
 *
 * Parsed by hand (digits then a unit letter) rather than with a regular
 * expression — the value is operator input and plain scanning has no ReDoS
 * surface at all.
 */
export function resolveWindow(
  flags: Record<string, string>,
  nowMs: number,
  defaultWindow = DEFAULT_WINDOW,
): ReportWindow {
  const sinceFlag = flags.since;
  const untilFlag = flags.until;
  if (sinceFlag !== undefined || untilFlag !== undefined) {
    if (flags.window !== undefined) {
      throw new AgentReportError("Pass either --window or --since/--until, not both.");
    }
    const since = parseEpoch(sinceFlag, "--since");
    const until = parseEpoch(untilFlag, "--until") ?? nowMs;
    if (since === undefined) throw new AgentReportError("--until also needs --since.");
    if (since >= until) throw new AgentReportError("--since must be before --until.");
    return { since, until, label: "explicit" };
  }

  const raw = flags.window ?? defaultWindow;
  const unit = raw.slice(-1);
  const count = Number(raw.slice(0, -1));
  const perUnit = WINDOW_UNITS[unit];
  if (perUnit === undefined || !Number.isInteger(count) || count <= 0) {
    throw new AgentReportError(
      `--window must be a positive whole number of hours, days or weeks ` +
        `(e.g. 24h, 7d, 2w) — got ${JSON.stringify(raw)}.`,
    );
  }
  return { since: nowMs - count * perUnit, until: nowMs, label: raw };
}

/**
 * The window in the words a skill's text expects (`{{range}}`): "the last 7d",
 * or the two dates when the window was given explicitly.
 *
 * The system prompt already states the window in epoch milliseconds, but the
 * user turn a skill renders opens with a range of its own, and a report run with
 * `--window 24h` must not ask for "the last 7 days" (#316).
 */
export function describeWindow(window: ReportWindow): string {
  return window.label === "explicit"
    ? `${iso(window.since)} → ${iso(window.until)}`
    : `the last ${window.label}`;
}

function parseEpoch(value: string | undefined, flag: string): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new AgentReportError(`${flag} must be an epoch-millisecond integer (got "${value}").`);
  }
  return parsed;
}

// ---------------------------------------------------------------------------
// Prompt
// ---------------------------------------------------------------------------

/**
 * The role statement for a headless report run.
 *
 * The behavioural half — never invent numbers, the data is aggregate and
 * privacy-preserving, timestamps are epoch ms, explain tool errors — is the very
 * block the browser assistant uses ({@link ANALYTICS_AGENT_GUIDELINES}), so what
 * the two clients promise about the data cannot drift. Only the role and the
 * output format differ, and both legitimately do: nobody is watching this run,
 * so it must produce a finished document rather than a chat reply.
 */
const REPORT_ROLE = [
  "You are Uptimizr's reporting analyst. You are running without a human present:",
  "gather what you need with the read-only tools against this project's own collector,",
  "then write the finished report in one pass. Nobody will ask you a follow-up.",
].join("\n");

/**
 * Every skill opens by telling the agent to read the `uptimizr://context`
 * resource first — the right instruction in an MCP client, where it *is* a
 * resource. Headlessly there is no resource to read: the CLI has already fetched
 * the document and rendered it into this prompt. Saying so prevents the model
 * from opening the report with an apology about a tool it does not have.
 */
const CONTEXT_ALREADY_READ =
  "The block above IS this project's context document (`GET /api/v1/context`, the same " +
  "one the `uptimizr://context` resource serves). It has already been read for you — the " +
  "task below will tell you to read it first; treat that as done and use the names above.";

/** How the answer must be shaped, since it is written straight into a document. */
const REPORT_OUTPUT_RULES = [
  "Write the report as GitHub-flavoured Markdown:",
  "- Start with a one-paragraph summary a busy reader can act on.",
  "- Then the findings, with the actual figures the tools returned.",
  "- Do not add a top-level `#` heading and do not restate the method — the tool",
  "  calls you made are recorded separately and appended to your report.",
  "- If the data is thin or a capture channel is off, say so plainly instead of",
  "  reporting a zero as a finding.",
].join("\n");

/**
 * Compose the system prompt: role, shared guidelines, the clock, the window the
 * operator asked for, the project context document, and the output rules.
 *
 * `projectContext` is the compact rendering of `GET /api/v1/context` (ADR 0051
 * §5) — the project's real scene ids, region ids and custom-event names. It is
 * injected here exactly as `useAssistant` and the eval harness inject it, and is
 * simply absent on a collector too old to serve the endpoint.
 */
export function buildReportSystemPrompt(options: {
  nowMs: number;
  window: ReportWindow;
  scene?: string;
  projectContext?: string;
}): string {
  const parts = [
    REPORT_ROLE,
    "",
    ANALYTICS_AGENT_GUIDELINES,
    "",
    renderCurrentTimeLine(options.nowMs),
    "",
    `Report window: since=${options.window.since} until=${options.window.until} ` +
      "(epoch milliseconds). Use exactly this range for every tool call unless the " +
      "skill explicitly asks for another.",
  ];
  if (options.scene) {
    parts.push(
      `Scope: scene "${options.scene}". Pass scene="${options.scene}" to every tool whose ` +
        "schema accepts it, and say so in the report.",
    );
  }
  const context = (options.projectContext ?? "").trim();
  if (context.length > 0) {
    parts.push("", context, "", CONTEXT_ALREADY_READ);
  }
  parts.push("", REPORT_OUTPUT_RULES);
  return parts.join("\n");
}

// ---------------------------------------------------------------------------
// Instrumentation
// ---------------------------------------------------------------------------

/** One collector request the run made, timed. */
interface RecordedRead {
  path: string;
  durationMs: number;
  ok: boolean;
}

/**
 * Wrap the collector client so every request is timed and announced.
 *
 * The loop issues exactly one `GET` per *executable* tool call (an unknown tool
 * or invalid arguments are rejected before any request), and executes them
 * sequentially, so the recorded reads line up with the transcript's tool results
 * in order — which is how {@link collectToolCalls} attaches a duration to each
 * call without agent-core having to report one.
 */
function instrumentClient(
  client: CollectorClient,
  reads: RecordedRead[],
  stderr: (line: string) => void,
): CollectorClient {
  return {
    async get(path: string, params?: QueryParams): Promise<unknown> {
      const began = Date.now();
      try {
        const result = await client.get(path, params);
        const durationMs = Date.now() - began;
        reads.push({ path, durationMs, ok: true });
        stderr(`    ✓ ${path} (${durationMs} ms)`);
        return result;
      } catch (err) {
        const durationMs = Date.now() - began;
        reads.push({ path, durationMs, ok: false });
        stderr(`    ✗ ${path} (${durationMs} ms): ${(err as Error).message}`);
        throw err;
      }
    },
  };
}

/** Running totals a wrapped provider accumulates across the loop's turns. */
interface ProviderTally {
  turns: number;
  usage: ProviderUsage | null;
}

/**
 * Wrap the provider so each turn's requested tool calls are announced to stderr
 * as they happen, and any reported token usage is summed.
 *
 * Announcing from here (rather than from `runAgent`'s streaming channel) is what
 * makes the progress output about *tool calls* — the thing an operator watching
 * a cron job wants — without asking the provider for a streamed response nobody
 * is rendering.
 */
function instrumentProvider(
  provider: LlmProvider,
  tally: ProviderTally,
  stderr: (line: string) => void,
): LlmProvider {
  return {
    async complete(request: ProviderRequest): Promise<ProviderResponse> {
      tally.turns += 1;
      const step = tally.turns;
      const response = await provider.complete(request);
      if (response.usage) {
        tally.usage = {
          inputTokens: (tally.usage?.inputTokens ?? 0) + (response.usage.inputTokens ?? 0),
          outputTokens: (tally.usage?.outputTokens ?? 0) + (response.usage.outputTokens ?? 0),
        };
      }
      if (response.kind === "tool_calls") {
        for (const call of response.toolCalls) {
          stderr(`  → step ${step}: ${call.name} ${compactArgs(call.arguments)}`);
        }
      } else {
        stderr(`  → step ${step}: final answer (${response.content.length} chars)`);
      }
      return response;
    },
  };
}

/** One-line rendering of tool arguments, capped so a cron log stays readable. */
function compactArgs(args: Record<string, unknown> | undefined): string {
  const json = JSON.stringify(args ?? {});
  return json.length <= 160 ? json : `${json.slice(0, 160)}…`;
}

/** Prefixes the loop uses for failures that never reach the collector. */
const NO_REQUEST_PREFIXES = ["Error: unknown tool", "Error: invalid arguments for"];

/**
 * Pair the transcript's tool calls with the timed reads, in order.
 *
 * A tool result that starts with one of {@link NO_REQUEST_PREFIXES} was rejected
 * by the loop before it built a request, so it consumes no recorded read; every
 * other result — including a collector error, which *did* make a request —
 * consumes the next one.
 */
export function collectToolCalls(
  messages: readonly AgentMessage[],
  reads: readonly RecordedRead[],
): ReportToolCall[] {
  const requested = new Map<string, { name: string; arguments: Record<string, unknown> }>();
  const ordered: ReportToolCall[] = [];
  let readIndex = 0;

  for (const message of messages) {
    if (message.role === "assistant") {
      for (const call of message.toolCalls ?? []) {
        requested.set(call.id, { name: call.name, arguments: call.arguments ?? {} });
      }
      continue;
    }
    if (message.role !== "tool") continue;

    const asked = requested.get(message.toolCallId);
    const failed = message.content.startsWith("Error: ");
    const madeRequest = !NO_REQUEST_PREFIXES.some((prefix) => message.content.startsWith(prefix));
    const read = madeRequest ? reads[readIndex++] : undefined;
    ordered.push({
      name: asked?.name ?? message.name,
      arguments: asked?.arguments ?? {},
      durationMs: read?.durationMs ?? null,
      ok: !failed,
      error: failed ? message.content : null,
      resultChars: message.content.length,
    });
  }
  return ordered;
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

/** Escape the pipe characters that would break a Markdown table cell. */
function cell(text: string): string {
  return text.split("|").join("\\|");
}

/** `2026-09-19T08:00:00.000Z` → a compact, unambiguous stamp for a heading. */
function iso(ms: number): string {
  return new Date(ms).toISOString();
}

/**
 * Render the Markdown report: the model's findings, then a **Method** section
 * that lists every tool call with its arguments and outcome.
 *
 * The Method section is not decoration — it is what makes an unattended,
 * model-written document auditable: a reader can see exactly which aggregates
 * the figures came from, re-run them, and spot a call that silently failed.
 */
export function renderReportMarkdown(report: AgentReportJson): string {
  const scene = report.scene ? `scene \`${report.scene}\`` : "all scenes";
  const lines: string[] = [
    `# ${report.title}`,
    "",
    `_${scene} · ${iso(report.window.since)} → ${iso(report.window.until)} · ` +
      `generated ${report.finishedAt} by \`uptimizr agent report --skill ${report.skill}\`_`,
    "",
  ];

  lines.push(
    report.answer.trim() === "" ? "_The model returned no answer._" : report.answer.trim(),
  );

  lines.push(
    "",
    "## Method",
    "",
    report.toolCalls.length === 0
      ? "The agent made no tool calls — treat the findings above with suspicion."
      : `The agent made ${report.toolCalls.length} read-only tool call(s) against the collector:`,
  );

  if (report.toolCalls.length > 0) {
    lines.push(
      "",
      "| # | Tool | Arguments | Duration | Result |",
      "| --- | --- | --- | --- | --- |",
    );
    report.toolCalls.forEach((call, index) => {
      const duration = call.durationMs == null ? "—" : `${call.durationMs} ms`;
      const outcome = call.ok ? `ok (${call.resultChars} chars)` : `**failed** — ${call.error}`;
      lines.push(
        `| ${index + 1} | \`${cell(call.name)}\` | \`${cell(compactArgs(call.arguments))}\` | ` +
          `${duration} | ${cell(outcome)} |`,
      );
    });
  }

  const usage = report.usage;
  lines.push(
    "",
    "## Run",
    "",
    `- Skill: \`${report.skill}\``,
    `- Collector: ${report.collectorUrl}`,
    `- Provider: ${report.provider.kind} (${report.provider.model})`,
    `- Provider turns: ${report.steps} of ${report.maxSteps}` +
      (report.stoppedOnMaxSteps ? " — **stopped at the step cap**" : ""),
    `- Project context: ${
      report.context.available
        ? `${report.context.chars} characters from \`GET /api/v1/context\``
        : "unavailable (older collector, or the read failed)"
    }`,
    `- Duration: ${(report.durationMs / 1000).toFixed(1)} s`,
    `- Tokens: ${
      usage
        ? `${usage.inputTokens ?? "?"} in / ${usage.outputTokens ?? "?"} out (as reported by the provider)`
        : "not reported by this provider"
    }`,
    "",
  );
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Providers
// ---------------------------------------------------------------------------

/**
 * The deterministic, key-free provider (`UPTIMIZR_AGENT_PROVIDER=scripted`).
 *
 * It is a real {@link LlmProvider} driven through the real loop against the real
 * collector — only the "model" is replaced by a rule: on its first turn it calls
 * exactly the tools the chosen skill names, scoped to the run's window and
 * scene; on its second it renders what the collector returned.
 *
 * It performs **no analysis** and is documented as such. What it is good for is
 * everything around the analysis: proving the collector URL, the API key, the
 * skill name, the output paths and the webhook signature all work, in CI or on a
 * new host, with no provider account and no egress.
 */
export function createScriptedReportProvider(context: ProviderContext): LlmProvider {
  const byName = new Map(context.tools.map((tool) => [tool.name, tool]));
  return {
    async complete(request: ProviderRequest): Promise<ProviderResponse> {
      const results = request.messages.filter(
        (message): message is AgentMessage & { role: "tool" } => message.role === "tool",
      );

      if (results.length === 0 && request.tools.length > 0) {
        const toolCalls = context.skill.tools
          .filter((name) => byName.has(name))
          .map((name, index) => ({
            id: `scripted-${index}`,
            name,
            arguments: scriptedArgsFor(byName.get(name)!, context),
          }));
        if (toolCalls.length > 0) return { kind: "tool_calls", toolCalls };
      }

      const body = results
        .map((message) => `### \`${message.name}\`\n\n\`\`\`json\n${message.content}\n\`\`\``)
        .join("\n\n");
      return {
        kind: "final",
        content:
          `This report was produced by the **scripted** provider: it called the ` +
          `\`${context.skill.name}\` skill's tools and printed what the collector returned. ` +
          "No model was involved, so nothing below is analysis — it is raw aggregate data.\n\n" +
          body,
      };
    },
  };
}

/** Window/scene arguments for a bare scripted call, where the schema takes them. */
function scriptedArgsFor(tool: ReadTool, context: ProviderContext): Record<string, unknown> {
  const args: Record<string, unknown> = {};
  if ("since" in tool.inputSchema) args.since = context.window.since;
  if ("until" in tool.inputSchema) args.until = context.window.until;
  if (context.scene && "scene" in tool.inputSchema) args.scene = context.scene;
  return args;
}

/**
 * Resolve the provider from the environment — and only from the environment
 * (ADR 0051 §6): nothing about a provider is ever written to disk by this CLI.
 *
 * The key is read from `UPTIMIZR_AGENT_API_KEY`, falling back to the provider's
 * own conventional variable so an operator who already exports `ANTHROPIC_API_KEY`
 * needs no second export. It is returned for the adapter's constructor and is
 * never placed in any other value this module produces.
 */
export function resolveProvider(env: NodeJS.ProcessEnv): ResolvedProvider {
  const requested = (env.UPTIMIZR_AGENT_PROVIDER ?? "anthropic").toLowerCase();
  if (requested === "scripted") {
    return { kind: "scripted", model: "scripted", endpoint: "(none)" };
  }
  if (requested !== "anthropic" && requested !== "openai") {
    throw new AgentReportError(
      `UPTIMIZR_AGENT_PROVIDER must be "anthropic", "openai" or "scripted" ` +
        `(got ${JSON.stringify(env.UPTIMIZR_AGENT_PROVIDER ?? "")}).`,
    );
  }
  const kind = requested;
  const fallbackKey = kind === "anthropic" ? env.ANTHROPIC_API_KEY : env.OPENAI_API_KEY;
  const apiKey = (env.UPTIMIZR_AGENT_API_KEY ?? fallbackKey ?? "").trim();
  if (apiKey === "") {
    throw new AgentReportError(
      `No provider key. Set UPTIMIZR_AGENT_API_KEY (or ` +
        `${kind === "anthropic" ? "ANTHROPIC_API_KEY" : "OPENAI_API_KEY"}) for the ${kind} ` +
        "provider, or run with UPTIMIZR_AGENT_PROVIDER=scripted for a model-free run.",
    );
  }
  return {
    kind,
    model: env.UPTIMIZR_AGENT_MODEL?.trim() || DEFAULT_MODELS[kind],
    endpoint: env.UPTIMIZR_AGENT_ENDPOINT?.trim() || DEFAULT_ENDPOINTS[kind],
    apiKey,
  };
}

/** Build the backend a resolved configuration describes. */
function defaultCreateProvider(
  config: ResolvedProvider,
  context: ProviderContext,
  fetchImpl: typeof fetch,
): LlmProvider {
  if (config.kind === "scripted") return createScriptedReportProvider(context);
  return createHostedProvider({
    api: config.kind,
    endpoint: config.endpoint,
    apiKey: config.apiKey ?? "",
    model: config.model,
    maxTokens: PROVIDER_MAX_TOKENS,
    fetchImpl,
  });
}

// ---------------------------------------------------------------------------
// Help
// ---------------------------------------------------------------------------

/** `uptimizr agent report --help`. */
export function reportUsage(): string {
  return [
    "uptimizr agent report — run a read-only analytics agent once and write a Markdown report.",
    "",
    "Usage:",
    "  uptimizr agent report --skill <name> [options]",
    "  uptimizr agent report --list-skills",
    "",
    "Options:",
    "  --skill <name>       the investigation to run (required; see --list-skills)",
    "  --scene <id>         scope the report to one scene",
    "  --window <NdNhNw>    analysis window counting back from now (default 7d; e.g. 24h, 2w)",
    "  --since <epochMs>    explicit window start (with --until; mutually exclusive with --window)",
    "  --until <epochMs>    explicit window end (defaults to now)",
    "  --out <file|->       write the Markdown here (default: -, stdout)",
    "  --json <file|->      also write the structured report (tool calls, args, durations,",
    "                       token usage when the provider reports it)",
    "  --webhook <url>      POST {markdown, report} to this http(s) URL, signed when",
    "                       UPTIMIZR_WEBHOOK_SECRET is set",
    `  --max-steps <n>      cap on provider turns (default ${DEFAULT_MAX_STEPS})`,
    "  --dry-run            print the prompt and the tool list; call no provider",
    "  --help               show this help",
    "",
    "Environment:",
    "  UPTIMIZR_COLLECTOR_URL   base URL of the collector (required), e.g. http://localhost:4318",
    "  UPTIMIZR_API_KEY         project API key (required). A `query`-only key is enough —",
    "                           mint one with `uptimizr new-key <projectId> --capabilities query`.",
    "  UPTIMIZR_AGENT_PROVIDER  anthropic (default) | openai | scripted",
    "  UPTIMIZR_AGENT_MODEL     model id (default: claude-sonnet-5 / gpt-4o-mini)",
    "  UPTIMIZR_AGENT_API_KEY   provider key (falls back to ANTHROPIC_API_KEY / OPENAI_API_KEY)",
    "  UPTIMIZR_AGENT_ENDPOINT  provider base URL (default: the provider's own)",
    "  UPTIMIZR_WEBHOOK_SECRET  HMAC-SHA-256 secret for the X-Uptimizr-Signature header",
    "",
    "Exit codes:",
    `  ${EXIT.ok}  report produced, every tool call succeeded`,
    `  ${EXIT.usage}  usage or configuration error (nothing ran)`,
    `  ${EXIT.provider}  the provider call or the webhook delivery failed`,
    `  ${EXIT.incomplete}  report produced but incomplete (a tool call failed, or no answer)`,
    "",
    "Scheduling is yours: run it from cron, a systemd timer or a GitHub Action. The",
    "collector runs no LLM loop of its own, and no provider configuration is persisted.",
  ].join("\n");
}

/**
 * `uptimizr agent report --list-skills`.
 *
 * A skill declares its own arguments, but this command does not expose one flag
 * per argument: `scene` comes from `--scene` and `range` is filled in from the
 * resolved window (`--window`, or `--since`/`--until`). Printing `[--range]`
 * would advertise a flag that does not exist, so arguments are named the way an
 * operator actually supplies them.
 */
export function listSkills(): string {
  const lines: string[] = ["Available skills:", ""];
  for (const skill of AGENT_SKILLS) {
    const args = skill.args
      .map((arg) => {
        if (arg.name === "range") return "(range from --window)";
        return arg.required ? `--${arg.name} <required>` : `[--${arg.name}]`;
      })
      .join(" ");
    lines.push(`  ${skill.name}${args ? `  ${args}` : ""}`);
    lines.push(`    ${skill.title} — ${skill.description}`);
    lines.push(`    Tools: ${skill.tools.join(", ")}`);
    lines.push("");
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// The command
// ---------------------------------------------------------------------------

/** Read a required environment variable, or explain exactly what to set. */
function requireEnv(env: NodeJS.ProcessEnv, name: string, hint: string): string {
  const value = env[name]?.trim();
  if (!value) throw new AgentReportError(`${name} is not set. ${hint}`);
  return value;
}

/** Fetch and render the project context, degrading to `""` on any failure. */
async function readProjectContext(
  client: CollectorClient,
  nowMs: number,
  stderr: (line: string) => void,
): Promise<string> {
  try {
    const document = await client.get("api/v1/context");
    return renderContextForPrompt(document as PromptContextDocument, nowMs);
  } catch (err) {
    // A collector older than ADR 0051 §5 has no /context. That is not an error:
    // the run proceeds with exactly the prompt it would have had before.
    stderr(`! project context unavailable (${(err as Error).message}); continuing without it`);
    return "";
  }
}

/** Write a Markdown/JSON output to a file, or to stdout for `-`. */
function emit(
  target: string,
  content: string,
  deps: Pick<AgentReportDeps, "stdout" | "stderr" | "writeFile">,
  label: string,
): void {
  if (target === "-") {
    deps.stdout(content.endsWith("\n") ? content : `${content}\n`);
    return;
  }
  const path = resolvePath(process.cwd(), target);
  try {
    deps.writeFile(path, content.endsWith("\n") ? content : `${content}\n`);
  } catch (err) {
    throw new AgentReportError(`Could not write ${label} to ${path}: ${(err as Error).message}`);
  }
  deps.stderr(`✓ ${label} written to ${path}`);
}

/**
 * Deliver the report to a webhook: one POST of `{markdown, report}`, signed with
 * `UPTIMIZR_WEBHOOK_SECRET` over the exact bytes sent.
 *
 * Unsigned delivery is allowed but warned about, because a receiver that cannot
 * verify the body has no way to tell a real digest from a forged one.
 */
async function deliverWebhook(
  rawUrl: string,
  markdown: string,
  report: AgentReportJson,
  deps: Pick<AgentReportDeps, "env" | "fetchImpl" | "stderr">,
): Promise<void> {
  // Already validated before the run; re-parsed here so this function is safe
  // to call on its own.
  const url = parseWebhookUrl(rawUrl);
  const body = JSON.stringify({ markdown, report });
  const secret = deps.env.UPTIMIZR_WEBHOOK_SECRET?.trim();
  const headers: Record<string, string> = {
    "content-type": "application/json",
    [WEBHOOK_DELIVERY_HEADER]: newDeliveryId(),
  };
  if (secret) {
    headers[WEBHOOK_SIGNATURE_HEADER] = signWebhookBody(secret, body);
  } else {
    deps.stderr(
      "! UPTIMIZR_WEBHOOK_SECRET is not set — the delivery will be unsigned and the " +
        "receiver cannot verify it came from this collector.",
    );
  }

  let response: Response;
  try {
    response = await deps.fetchImpl(url, { method: "POST", headers, body });
  } catch (err) {
    throw new AgentReportError(
      `Webhook delivery to ${url.origin}${url.pathname} failed: ${(err as Error).message}`,
      EXIT.provider,
    );
  }
  if (!response.ok) {
    throw new AgentReportError(
      `Webhook delivery to ${url.origin}${url.pathname} returned ${response.status}.`,
      EXIT.provider,
    );
  }
  deps.stderr(`✓ report delivered to ${url.origin}${url.pathname} (${response.status})`);
}

/**
 * Run `uptimizr agent report`.
 *
 * Returns the process exit code rather than calling `process.exit`, so the whole
 * command is exercisable in-process by the test suite. Every failure the
 * operator can act on surfaces as one stderr line, never a stack trace, and
 * never containing a key.
 */
export async function runAgentReport(
  argv: readonly string[],
  overrides: Partial<AgentReportDeps> = {},
): Promise<number> {
  const deps: AgentReportDeps = {
    env: process.env,
    now: () => Date.now(),
    fetchImpl: fetch,
    stdout: (text) => process.stdout.write(text),
    stderr: (line) => process.stderr.write(`${line}\n`),
    writeFile: (path, content) => writeFileSync(path, content, "utf8"),
    createProvider: (config, context) =>
      defaultCreateProvider(config, context, overrides.fetchImpl ?? fetch),
    ...overrides,
  };

  try {
    return await execute(argv, deps);
  } catch (err) {
    if (err instanceof AgentReportError) {
      deps.stderr(`✗ ${err.message}`);
      return err.exitCode;
    }
    throw err;
  }
}

async function execute(argv: readonly string[], deps: AgentReportDeps): Promise<number> {
  const { flags, switches } = parseAgentReportArgs(argv);

  if (switches.has("help")) {
    deps.stdout(`${reportUsage()}\n`);
    return EXIT.ok;
  }
  if (switches.has("list-skills")) {
    deps.stdout(listSkills());
    return EXIT.ok;
  }

  const skillName = flags.skill;
  if (!skillName) {
    throw new AgentReportError(
      "--skill is required. Run `uptimizr agent report --list-skills` to see the available ones.",
    );
  }
  const skill = getAgentSkill(skillName);
  if (!skill) {
    throw new AgentReportError(
      `Unknown skill ${JSON.stringify(skillName)}. Available: ` +
        `${AGENT_SKILLS.map((s) => s.name).join(", ")}.`,
    );
  }
  const scene = flags.scene?.trim() || undefined;
  for (const arg of skill.args) {
    if (arg.required && arg.name === "scene" && !scene) {
      throw new AgentReportError(`Skill "${skill.name}" needs --scene <id>: ${arg.description}`);
    }
  }

  const nowMs = deps.now();
  const window = resolveWindow(flags, nowMs);
  const maxSteps = parseMaxSteps(flags["max-steps"]);
  // Validate the webhook URL before spending a provider call on a report that
  // could not be delivered anyway. `parseWebhookUrl` is the shared helper (it
  // throws a plain Error so #311's webhook path can reuse it), so its message is
  // re-raised here as the operator-facing kind.
  if (flags.webhook !== undefined) {
    try {
      parseWebhookUrl(flags.webhook);
    } catch (err) {
      throw new AgentReportError((err as Error).message);
    }
  }

  const collectorUrl = requireEnv(
    deps.env,
    "UPTIMIZR_COLLECTOR_URL",
    "Point it at your collector, e.g. http://localhost:4318.",
  );
  const apiKey = requireEnv(
    deps.env,
    "UPTIMIZR_API_KEY",
    "A read-only key is enough: `uptimizr new-key <projectId> --capabilities query`.",
  );
  // Advisory, every run: this command only ever reads, so a key that can also
  // annotate or read raw sessions is more authority than it needs (ADR 0051 §7).
  deps.stderr(
    "· uptimizr agent report is read-only; a `query`-only key is recommended " +
      "(uptimizr new-key <projectId> --capabilities query).",
  );

  const tools = readTools;
  const client = createCollectorClient({ collectorUrl, apiKey }, deps.fetchImpl);
  const projectContext = await readProjectContext(client, nowMs, deps.stderr);
  const systemPrompt = buildReportSystemPrompt({
    nowMs,
    window,
    scene,
    projectContext,
  });
  const userTurn = skill.render({ scene, range: describeWindow(window) });

  if (switches.has("dry-run")) {
    deps.stdout(
      [
        `# Dry run — skill \`${skill.name}\``,
        "",
        `Collector: ${collectorUrl}`,
        `Window:    ${iso(window.since)} → ${iso(window.until)} (${window.label})`,
        `Scene:     ${scene ?? "(all)"}`,
        `Provider:  ${deps.env.UPTIMIZR_AGENT_PROVIDER ?? "anthropic"} — not called`,
        `Max steps: ${maxSteps}`,
        `Tools available: ${tools.length} (the skill's method uses ${skill.tools.join(", ")})`,
        "",
        "## System prompt",
        "",
        systemPrompt,
        "",
        "## User turn",
        "",
        userTurn,
        "",
      ].join("\n"),
    );
    return EXIT.ok;
  }

  const providerConfig = resolveProvider(deps.env);
  const providerContext: ProviderContext = { skill, tools, window, scene };
  const reads: RecordedRead[] = [];
  const tally: ProviderTally = { turns: 0, usage: null };
  const messages: AgentMessage[] = [
    { role: "system", content: systemPrompt },
    { role: "user", content: userTurn },
  ];

  deps.stderr(
    `· running ${skill.name} against ${collectorUrl} ` +
      `with ${providerConfig.kind} (${providerConfig.model})`,
  );

  const startedAt = Date.now();
  let result;
  try {
    result = await runAgent({
      provider: instrumentProvider(
        deps.createProvider(providerConfig, providerContext),
        tally,
        deps.stderr,
      ),
      client: instrumentClient(client, reads, deps.stderr),
      tools,
      maxSteps,
      messages,
    });
  } catch (err) {
    // Provider failures carry the endpoint's own error text, which never
    // contains the key (the adapter sends it as a header).
    throw new AgentReportError(
      `The ${providerConfig.kind} provider failed: ${(err as Error).message}`,
      EXIT.provider,
    );
  }
  const finishedAt = Date.now();

  const toolCalls = collectToolCalls(result.messages, reads);
  const report: AgentReportJson = {
    schema: REPORT_SCHEMA,
    skill: skill.name,
    title: skill.title,
    scene: scene ?? null,
    window,
    collectorUrl,
    provider: { kind: providerConfig.kind, model: providerConfig.model },
    startedAt: iso(startedAt),
    finishedAt: iso(finishedAt),
    durationMs: finishedAt - startedAt,
    steps: result.steps,
    maxSteps,
    stoppedOnMaxSteps: result.stoppedOnMaxSteps,
    usage: tally.usage,
    context: { available: projectContext !== "", chars: projectContext.length },
    toolCalls,
    answer: result.content,
  };
  const markdown = renderReportMarkdown(report);

  emit(flags.out ?? "-", markdown, deps, "report");
  if (flags.json !== undefined) {
    emit(flags.json, `${JSON.stringify(report, null, 2)}`, deps, "JSON report");
  }
  if (flags.webhook !== undefined) {
    await deliverWebhook(flags.webhook, markdown, report, deps);
  }

  const failed = toolCalls.filter((call) => !call.ok);
  if (failed.length > 0) {
    deps.stderr(
      `✗ ${failed.length} of ${toolCalls.length} tool call(s) failed — the report is incomplete.`,
    );
    return EXIT.incomplete;
  }
  if (report.answer.trim() === "") {
    deps.stderr("✗ the model returned no answer — the report is incomplete.");
    return EXIT.incomplete;
  }
  return EXIT.ok;
}

/** Parse `--max-steps`, or fall back to the loop's own default. */
function parseMaxSteps(raw: string | undefined): number {
  if (raw === undefined) return DEFAULT_MAX_STEPS;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new AgentReportError(`--max-steps must be a positive integer (got "${raw}").`);
  }
  return value;
}
