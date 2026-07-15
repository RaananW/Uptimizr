/**
 * Pure translation between the agent-core conversation shape and the OpenAI
 * Chat Completions wire format. Shared by the bring-your-own hosted adapter
 * (OpenAI-compatible mode) and the WebLLM adapter — the MLC runtime exposes an
 * OpenAI-compatible `chat.completions.create`. No I/O, no dependencies: just
 * shape mapping, so both adapters agree on tool-calling semantics.
 */

import type {
  AgentMessage,
  AgentToolCall,
  AgentToolSchema,
  ProviderResponse,
} from "../provider.js";

/** OpenAI chat message (request side). */
export interface OpenAiMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  tool_calls?: OpenAiToolCall[];
  tool_call_id?: string;
  name?: string;
}

/** OpenAI tool-call (both request echo and response). */
export interface OpenAiToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

/** OpenAI tool advertisement (function schema). */
export interface OpenAiTool {
  type: "function";
  function: { name: string; description: string; parameters: Record<string, unknown> };
}

/** The subset of an OpenAI chat-completion response this module reads. */
export interface OpenAiCompletion {
  choices?: Array<{
    message?: {
      content?: string | null;
      tool_calls?: OpenAiToolCall[] | null;
    };
  }>;
}

/** Map the agent conversation to OpenAI request messages. */
export function toOpenAiMessages(messages: readonly AgentMessage[]): OpenAiMessage[] {
  return messages.map((message): OpenAiMessage => {
    switch (message.role) {
      case "assistant":
        return {
          role: "assistant",
          content: message.content,
          ...(message.toolCalls && message.toolCalls.length > 0
            ? { tool_calls: message.toolCalls.map(toOpenAiToolCall) }
            : {}),
        };
      case "tool":
        return {
          role: "tool",
          content: message.content,
          tool_call_id: message.toolCallId,
          name: message.name,
        };
      default:
        return { role: message.role, content: message.content };
    }
  });
}

function toOpenAiToolCall(call: AgentToolCall): OpenAiToolCall {
  return {
    id: call.id,
    type: "function",
    function: { name: call.name, arguments: JSON.stringify(call.arguments ?? {}) },
  };
}

/** Map the read-only tool schemas to OpenAI `tools`. */
export function toOpenAiTools(tools: readonly AgentToolSchema[]): OpenAiTool[] {
  return tools.map((tool) => ({
    type: "function",
    function: { name: tool.name, description: tool.description, parameters: tool.parameters },
  }));
}

/** Parse tool-call arguments that arrive as a JSON string (OpenAI encoding). */
function parseArguments(raw: string | undefined): Record<string, unknown> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/**
 * Normalise an OpenAI completion into a {@link ProviderResponse}. Tool calls
 * take precedence; otherwise the message content is the final answer.
 */
export function parseOpenAiCompletion(completion: OpenAiCompletion): ProviderResponse {
  const message = completion.choices?.[0]?.message;
  const toolCalls = message?.tool_calls ?? [];
  const content = message?.content ?? "";

  if (toolCalls.length > 0) {
    return {
      kind: "tool_calls",
      toolCalls: toolCalls.map((call) => ({
        id: call.id,
        name: call.function.name,
        arguments: parseArguments(call.function.arguments),
      })),
      ...(content ? { content } : {}),
    };
  }

  return { kind: "final", content };
}
