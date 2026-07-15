import { z } from "zod";
import type { CollectorClient } from "./client.js";
import type { AgentMessage, AgentToolCall, AgentToolSchema, LlmProvider } from "./provider.js";
import { readTools, type ReadTool } from "./tools.js";

/** Default cap on provider turns before the loop gives up (guards against loops). */
export const DEFAULT_MAX_STEPS = 8;

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
 */
export async function runAgent(options: RunAgentOptions): Promise<RunAgentResult> {
  const { provider, client, signal } = options;
  const tools = options.tools ?? readTools;
  const maxSteps = options.maxSteps ?? DEFAULT_MAX_STEPS;
  const toolsByName = new Map(tools.map((t) => [t.name, t]));
  const toolSchemas = toToolSchemas(tools);
  const messages: AgentMessage[] = [...options.messages];

  let steps = 0;
  while (steps < maxSteps) {
    steps += 1;
    const response = await provider.complete({ messages, tools: toolSchemas, signal });

    if (response.kind === "final") {
      messages.push({ role: "assistant", content: response.content });
      return { content: response.content, messages, steps, stoppedOnMaxSteps: false };
    }

    messages.push({
      role: "assistant",
      content: response.content ?? "",
      toolCalls: response.toolCalls,
    });

    for (const call of response.toolCalls) {
      messages.push(await executeToolCall(client, toolsByName.get(call.name), call));
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
    return result(JSON.stringify(data));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return result(`Error: ${message}`);
  }
}
