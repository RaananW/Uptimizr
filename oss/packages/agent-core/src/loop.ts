import { z } from "zod";
import type { CollectorClient } from "./client.js";
import type { AgentMessage, AgentToolCall, AgentToolSchema, LlmProvider } from "./provider.js";
import { readTools, type ReadTool } from "./tools.js";

/** Default cap on provider turns before the loop gives up (guards against loops). */
export const DEFAULT_MAX_STEPS = 8;

/**
 * Default cap on the number of characters of a single tool result fed back to
 * the model. Large analytics JSON blobs can blow a small local model's context
 * window (8192 tokens for the curated Hermes records) and degrade it into
 * empty/looping output, so results above this length are truncated with a clear
 * marker. Chosen to comfortably fit several tool results plus the prompt.
 */
export const DEFAULT_MAX_TOOL_RESULT_CHARS = 8000;

/**
 * Directive sent — as a trailing `user` message — on the forced, tools-disabled
 * synthesis turn (see {@link runAgent}). It tells the model to stop calling
 * tools and answer in plain prose from the data it already gathered. Kept out of
 * the returned transcript: only the resulting answer is persisted.
 */
const FORCE_FINAL_DIRECTIVE =
  "Now answer the user's question directly in plain text, using the tool results already " +
  "gathered above. Do not call any tools. If the data is insufficient, say so briefly.";

/**
 * Truncate an over-long tool result to `max` characters, appending a clear
 * marker noting how many characters were dropped. Below the cap the content is
 * returned untouched (full fidelity). Plain string slicing only — no regex, so
 * there is no ReDoS surface on model-influenced tool output.
 */
export function truncateToolResult(content: string, max: number): string {
  if (content.length <= max) return content;
  const dropped = content.length - max;
  return `${content.slice(0, max)}…[truncated ${dropped} chars]`;
}

/**
 * Convert the read-only tool catalog into provider-facing tool schemas. Each
 * tool's Zod raw shape becomes a JSON-Schema object the model can reason about.
 */
export function toToolSchemas(tools: readonly ReadTool[] = readTools): AgentToolSchema[] {
  return tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    parameters: z.toJSONSchema(z.object(tool.inputSchema)) as Record<string, unknown>,
  }));
}

/** Options for a single {@link runAgent} invocation. */
export interface RunAgentOptions {
  /** The LLM backend to drive the conversation. */
  provider: LlmProvider;
  /** Read-only collector client used to execute tool calls. */
  client: CollectorClient;
  /** The conversation so far (typically a system + user message to start). */
  messages: AgentMessage[];
  /** Tool catalog to expose; defaults to the shared read-only catalog. */
  tools?: readonly ReadTool[];
  /** Maximum provider turns before returning. Defaults to {@link DEFAULT_MAX_STEPS}. */
  maxSteps?: number;
  /**
   * When the model ends a run without a usable answer — either an empty `final`
   * or by exhausting `maxSteps` while still tool-calling — make ONE extra
   * `provider.complete()` with tools disabled, forcing it to synthesize a plain
   * prose answer from the tool results it already gathered. At most one such
   * forced turn per run. Defaults to `true`. Set `false` to keep the old
   * empty-answer behavior. Benefits every consumer (dashboard assistant, MCP).
   */
  forceFinalAnswer?: boolean;
  /**
   * Maximum characters of a single tool result fed back to the model; longer
   * results are truncated with a marker to protect small models' context.
   * Defaults to {@link DEFAULT_MAX_TOOL_RESULT_CHARS}.
   */
  maxToolResultChars?: number;
  /** Optional cancellation signal forwarded to the provider. */
  signal?: AbortSignal;
}

/** The outcome of a completed agent run. */
export interface RunAgentResult {
  /** The model's final natural-language answer (empty if it never produced one). */
  content: string;
  /** The full transcript, including assistant tool calls and tool results. */
  messages: AgentMessage[];
  /** How many provider turns were taken. */
  steps: number;
  /** True when the loop stopped because it hit `maxSteps` rather than a final answer. */
  stoppedOnMaxSteps: boolean;
}

/**
 * Run the headless tool-calling loop: ask the provider for the next step, and
 * while it requests tool calls, execute each against the read-only collector
 * client and feed the results back. Returns once the provider yields a final
 * answer or the step cap is reached.
 *
 * The loop only ever issues collector `GET`s through the catalog's
 * `buildRequest` — it can neither ingest nor mutate data (ADR 0003 / 0017).
 *
 * When a run would otherwise end without a usable answer (an empty `final`, or
 * the step cap reached while still tool-calling) and `forceFinalAnswer` is on
 * (default), it makes ONE extra tools-disabled `provider.complete()` so the
 * model synthesizes a prose answer from the tool results it already gathered —
 * at most one such forced turn per run.
 */
export async function runAgent(options: RunAgentOptions): Promise<RunAgentResult> {
  const { provider, client, signal } = options;
  const tools = options.tools ?? readTools;
  const maxSteps = options.maxSteps ?? DEFAULT_MAX_STEPS;
  const forceFinalAnswer = options.forceFinalAnswer ?? true;
  const maxToolResultChars = options.maxToolResultChars ?? DEFAULT_MAX_TOOL_RESULT_CHARS;
  const toolsByName = new Map(tools.map((t) => [t.name, t]));
  const toolSchemas = toToolSchemas(tools);
  const messages: AgentMessage[] = [...options.messages];

  let steps = 0;
  let alreadyForced = false;

  /**
   * One tools-disabled synthesis turn: ask the provider to answer in prose from
   * the tool results already in `messages`. Sends no tools (so adapters omit
   * function-calling entirely) plus a trailing directive that is NOT persisted
   * into the transcript. Returns the answer text (possibly empty). Runs at most
   * once per {@link runAgent} call via the shared `alreadyForced` guard.
   */
  async function forceFinalSynthesis(): Promise<string> {
    alreadyForced = true;
    const forcedMessages: AgentMessage[] = [
      ...messages,
      { role: "user", content: FORCE_FINAL_DIRECTIVE },
    ];
    const response = await provider.complete({ messages: forcedMessages, tools: [], signal });
    return response.kind === "final" ? response.content : (response.content ?? "");
  }

  while (steps < maxSteps) {
    steps += 1;
    const response = await provider.complete({ messages, tools: toolSchemas, signal });

    if (response.kind === "final") {
      // The model may emit an empty final early — the reported failure where the
      // user sees no answer. Force one tools-disabled synthesis pass to recover a
      // real answer from any gathered tool results before returning empty.
      if (response.content.trim() === "" && forceFinalAnswer && !alreadyForced) {
        const forced = await forceFinalSynthesis();
        if (forced.trim() !== "") {
          messages.push({ role: "assistant", content: forced });
          return { content: forced, messages, steps, stoppedOnMaxSteps: false };
        }
      }
      messages.push({ role: "assistant", content: response.content });
      return { content: response.content, messages, steps, stoppedOnMaxSteps: false };
    }

    messages.push({
      role: "assistant",
      content: response.content ?? "",
      toolCalls: response.toolCalls,
    });

    for (const call of response.toolCalls) {
      messages.push(
        await executeToolCall(client, toolsByName.get(call.name), call, maxToolResultChars),
      );
    }
  }

  // Hit the step cap while still tool-calling: force one tools-disabled synthesis
  // pass so the model composes an answer from what it gathered instead of the
  // loop returning nothing.
  if (forceFinalAnswer && !alreadyForced) {
    const forced = await forceFinalSynthesis();
    if (forced.trim() !== "") {
      messages.push({ role: "assistant", content: forced });
      return { content: forced, messages, steps, stoppedOnMaxSteps: true };
    }
  }

  return { content: "", messages, steps, stoppedOnMaxSteps: true };
}

/**
 * Execute one tool call and return the `tool` result message. Unknown tools and
 * invalid arguments produce an error result (rather than throwing) so the model
 * can see the failure and recover on the next turn. Collector errors are
 * likewise surfaced as text.
 */
async function executeToolCall(
  client: CollectorClient,
  tool: ReadTool | undefined,
  call: AgentToolCall,
  maxToolResultChars: number,
): Promise<AgentMessage> {
  const result = (content: string): AgentMessage => ({
    role: "tool",
    toolCallId: call.id,
    name: call.name,
    content,
  });

  if (!tool) {
    return result(`Error: unknown tool "${call.name}".`);
  }

  const parsed = z.object(tool.inputSchema).safeParse(call.arguments ?? {});
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("; ");
    return result(`Error: invalid arguments for "${call.name}": ${issues}`);
  }

  try {
    const { path, params } = tool.buildRequest(parsed.data as Record<string, unknown>);
    const data = await client.get(path, params);
    return result(truncateToolResult(JSON.stringify(data), maxToolResultChars));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return result(`Error: ${message}`);
  }
}
