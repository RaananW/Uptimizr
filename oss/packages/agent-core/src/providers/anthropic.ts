/**
 * Pure translation between the agent-core conversation shape and the Anthropic
 * Messages API wire format. No I/O, no dependencies — the hosted adapter owns
 * the actual `fetch`. Anthropic differs from OpenAI in three ways this module
 * hides: the system prompt is a top-level field (not a message), tool calls are
 * `tool_use` content blocks, and tool results are `tool_result` blocks carried
 * in a following user turn.
 */

import type {
  AgentMessage,
  AgentToolCall,
  AgentToolSchema,
  ProviderResponse,
} from "../provider.js";

/** An Anthropic content block (the subset used here). */
export type AnthropicContentBlock =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> }
  | { type: "tool_result"; tool_use_id: string; content: string };

/** An Anthropic request message. */
export interface AnthropicMessage {
  role: "user" | "assistant";
  content: AnthropicContentBlock[];
}

/** An Anthropic tool advertisement. */
export interface AnthropicTool {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

/** The parts of an Anthropic request this module builds. */
export interface AnthropicRequestBody {
  system?: string;
  messages: AnthropicMessage[];
  /** Omitted when no tools are advertised (e.g. a forced plain-text turn). */
  tools?: AnthropicTool[];
}

/** The subset of an Anthropic Messages response this module reads. */
export interface AnthropicCompletion {
  content?: AnthropicContentBlock[];
}

/**
 * Build the Anthropic request pieces (system prompt, messages, tools) from the
 * agent conversation and tool schemas.
 */
export function toAnthropicRequest(
  messages: readonly AgentMessage[],
  tools: readonly AgentToolSchema[],
): AnthropicRequestBody {
  const systemParts: string[] = [];
  const out: AnthropicMessage[] = [];

  for (const message of messages) {
    switch (message.role) {
      case "system":
        systemParts.push(message.content);
        break;
      case "user":
        out.push({ role: "user", content: [{ type: "text", text: message.content }] });
        break;
      case "assistant": {
        const blocks: AnthropicContentBlock[] = [];
        if (message.content) blocks.push({ type: "text", text: message.content });
        for (const call of message.toolCalls ?? []) blocks.push(toToolUse(call));
        out.push({ role: "assistant", content: blocks });
        break;
      }
      case "tool":
        out.push({
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: message.toolCallId, content: message.content },
          ],
        });
        break;
    }
  }

  return {
    ...(systemParts.length > 0 ? { system: systemParts.join("\n\n") } : {}),
    messages: out,
    // Omit `tools` when there are none (e.g. the loop's forced synthesis pass)
    // so the model answers in plain text instead of being offered functions.
    ...(tools.length > 0
      ? {
          tools: tools.map((tool) => ({
            name: tool.name,
            description: tool.description,
            input_schema: tool.parameters,
          })),
        }
      : {}),
  };
}

function toToolUse(call: AgentToolCall): AnthropicContentBlock {
  return { type: "tool_use", id: call.id, name: call.name, input: call.arguments ?? {} };
}

/**
 * Normalise an Anthropic Messages response into a {@link ProviderResponse}.
 * Any `tool_use` blocks become tool calls; otherwise the joined text blocks are
 * the final answer.
 */
export function parseAnthropicCompletion(completion: AnthropicCompletion): ProviderResponse {
  const blocks = completion.content ?? [];
  const toolCalls = blocks
    .filter((b): b is Extract<AnthropicContentBlock, { type: "tool_use" }> => b.type === "tool_use")
    .map((b) => ({ id: b.id, name: b.name, arguments: b.input ?? {} }));
  const text = blocks
    .filter((b): b is Extract<AnthropicContentBlock, { type: "text" }> => b.type === "text")
    .map((b) => b.text)
    .join("");

  if (toolCalls.length > 0) {
    return { kind: "tool_calls", toolCalls, ...(text ? { content: text } : {}) };
  }
  return { kind: "final", content: text };
}
