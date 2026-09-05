/**
 * Headless LLM provider-adapter interface for Uptimizr agents.
 *
 * The agent core is provider-agnostic: it hands a provider the running
 * conversation plus the read-only tool schemas and receives back either tool
 * calls to execute or a final natural-language answer. Concrete adapters
 * (WebLLM/WebGPU, an OpenAI-compatible endpoint, an Anthropic endpoint, …) live
 * outside this package and are user-selected and user-controlled — the core
 * ships no model and no key (ADR 0050 §4).
 */

/** A single message in the agent conversation. */
export type AgentMessage =
  | { role: "system"; content: string }
  | { role: "user"; content: string }
  | { role: "assistant"; content: string; toolCalls?: AgentToolCall[] }
  | { role: "tool"; toolCallId: string; name: string; content: string };

/** A tool invocation requested by the model. */
export interface AgentToolCall {
  /** Provider-assigned id, echoed back on the matching tool result message. */
  id: string;
  /** Name of the tool to invoke (must match a catalog tool). */
  name: string;
  /** Arguments for the tool, validated against the tool's input schema. */
  arguments: Record<string, unknown>;
}

/**
 * A tool advertised to the model: its name, a short description, and a
 * JSON-Schema description of its parameters (derived from the catalog's Zod
 * shapes, see {@link toToolSchemas}).
 */
export interface AgentToolSchema {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

/** The two possible outcomes of a provider turn. */
export type ProviderResponse =
  | { kind: "tool_calls"; toolCalls: AgentToolCall[]; content?: string }
  | { kind: "final"; content: string };

/** A single provider completion request. */
export interface ProviderRequest {
  /** The conversation so far (system + user + prior assistant/tool turns). */
  messages: AgentMessage[];
  /** The read-only tools the model may call this turn. */
  tools: AgentToolSchema[];
  /** Optional cancellation signal, forwarded by the loop. */
  signal?: AbortSignal;
  /**
   * Optional streaming channel. When present, a provider that can stream calls
   * it with each **assistant text delta** as the model produces it, in order,
   * so a UI can render the reply incrementally. The returned
   * {@link ProviderResponse} is still the complete, authoritative result: its
   * `content` is the full assembled text (the concatenation of every delta) and
   * any tool calls are reported there only, never through this callback — tool
   * call JSON is not user-visible text.
   *
   * The channel is strictly additive: a provider that does not stream simply
   * never calls it and returns its `Promise<ProviderResponse>` exactly as
   * before, and a caller that omits it gets the non-streaming behaviour.
   * Providers SHOULD avoid requesting a streamed wire response when no callback
   * is supplied (nobody is listening).
   */
  onToken?: (delta: string) => void;
}

/**
 * A pluggable LLM backend. Implementations translate {@link ProviderRequest}
 * into their own wire format and normalise the reply into a
 * {@link ProviderResponse}. Streaming is opt-in per call via
 * {@link ProviderRequest.onToken}; the promise-based shape never changes.
 */
export interface LlmProvider {
  complete(request: ProviderRequest): Promise<ProviderResponse>;
}
