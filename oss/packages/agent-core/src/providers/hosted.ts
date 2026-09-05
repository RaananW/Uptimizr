/**
 * Bring-your-own hosted LLM adapter (ADR 0050 §4/§5).
 *
 * The user supplies an OpenAI-compatible **or** Anthropic endpoint + key, stored
 * only in their browser. The browser calls the user's own provider directly —
 * Uptimizr operates no proxy. Only the prompt and the aggregated tool results
 * the loop produces leave the browser (never raw events or PII), and only to the
 * user's chosen provider after explicit opt-in.
 *
 * Both providers require CORS to be reachable from a browser:
 *  - OpenAI-compatible: the endpoint must send permissive `Access-Control-*`
 *    headers (some gateways/self-hosted servers do; api.openai.com does not).
 *  - Anthropic: pass the `anthropic-dangerous-direct-browser-access` header
 *    (added below) which enables their browser CORS path.
 * See the docs (guides/assistant) for the exact requirements.
 *
 * **Streaming.** When the caller supplies `ProviderRequest.onToken`, the adapter
 * asks the provider for a streamed (`text/event-stream`) response, forwards each
 * text delta as it arrives, and still resolves with the complete, assembled
 * `ProviderResponse` (tool calls included). Without a listener it makes the
 * same single non-streamed POST as before. The SSE payload is model output, so
 * it is parsed with string membership and linear scans only (no regex — CodeQL
 * ReDoS), see `./sse.ts`.
 */

import type { LlmProvider, ProviderRequest, ProviderResponse } from "../provider.js";
import type { HostedApi } from "./config.js";
import {
  createOpenAiStreamAssembler,
  parseOpenAiCompletion,
  toOpenAiMessages,
  toOpenAiTools,
  type OpenAiCompletion,
  type OpenAiStreamChunk,
} from "./openai.js";
import {
  createAnthropicStreamAssembler,
  parseAnthropicCompletion,
  toAnthropicRequest,
  type AnthropicCompletion,
  type AnthropicStreamEvent,
} from "./anthropic.js";
import { readSseStream } from "./sse.js";

/** Configuration for a bring-your-own hosted provider. */
export interface HostedProviderConfig {
  /** Which wire format the endpoint speaks. */
  api: HostedApi;
  /**
   * Base URL of the user's provider. The provider appends the well-known path
   * (`/chat/completions` or `/messages`) if the URL doesn't already end in it.
   */
  endpoint: string;
  /** The user's provider API key (in-browser only). */
  apiKey: string;
  /** Model identifier to request. */
  model: string;
  /** Max tokens to generate (Anthropic requires it; default 1024). */
  maxTokens?: number;
  /** Anthropic API version header (default "2023-06-01"). */
  anthropicVersion?: string;
  /** Injectable fetch for testing; defaults to the global `fetch`. */
  fetchImpl?: typeof fetch;
}

/** Thrown when the user's provider responds with a non-2xx status. */
export class HostedProviderError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "HostedProviderError";
  }
}

const DEFAULT_MAX_TOKENS = 1024;
const DEFAULT_ANTHROPIC_VERSION = "2023-06-01";

/** The OpenAI-compatible end-of-stream sentinel (`data: [DONE]`). */
const OPENAI_DONE_SENTINEL = "[DONE]";

function joinUrl(base: string, suffix: string): string {
  let end = base.length;
  while (end > 0 && base[end - 1] === "/") end--;
  const trimmed = base.slice(0, end);
  return trimmed.endsWith(suffix) ? trimmed : `${trimmed}${suffix}`;
}

/**
 * Create a hosted provider bound to one `(api, endpoint, apiKey, model)`. The
 * returned {@link LlmProvider} issues one direct request per turn to the user's
 * provider and normalises the reply. Pass `onToken` on a request to receive the
 * answer incrementally (see the module docs).
 */
export function createHostedProvider(config: HostedProviderConfig): LlmProvider {
  const fetchImpl = config.fetchImpl ?? fetch;
  return {
    complete(request: ProviderRequest): Promise<ProviderResponse> {
      return config.api === "anthropic"
        ? completeAnthropic(config, fetchImpl, request)
        : completeOpenAi(config, fetchImpl, request);
    },
  };
}

async function completeOpenAi(
  config: HostedProviderConfig,
  fetchImpl: typeof fetch,
  request: ProviderRequest,
): Promise<ProviderResponse> {
  const url = joinUrl(config.endpoint, "/chat/completions");
  const onToken = request.onToken;
  // No tools this turn (e.g. the loop's forced synthesis pass) → omit `tools`
  // and `tool_choice` entirely so the model answers in plain text rather than
  // being nudged to keep calling functions.
  const body = {
    model: config.model,
    messages: toOpenAiMessages(request.messages),
    ...(request.tools.length > 0
      ? { tools: toOpenAiTools(request.tools), tool_choice: "auto" as const }
      : {}),
    // Only ask for a streamed reply when someone is listening.
    ...(onToken ? { stream: true } : {}),
  };
  const res = await fetchImpl(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${config.apiKey}`,
    },
    body: JSON.stringify(body),
    signal: request.signal,
  });
  await assertOk(res);
  if (onToken && isEventStream(res)) {
    const assembler = createOpenAiStreamAssembler();
    await readSseStream(
      res.body ?? new ReadableStream<Uint8Array>(),
      (event) => {
        // `data: [DONE]` closes an OpenAI stream; anything else is a JSON chunk.
        if (event.data === OPENAI_DONE_SENTINEL) return;
        const chunk = parseJsonEvent<OpenAiStreamChunk>(event.data);
        if (!chunk) return;
        const delta = assembler.push(chunk);
        if (delta) onToken(delta);
      },
      request.signal,
    );
    return parseOpenAiCompletion(assembler.finish());
  }
  // A provider that ignores `stream` (or no listener) → one JSON body. Forward
  // the whole answer as a single delta so a listener still sees it.
  const completion = (await res.json()) as OpenAiCompletion;
  const parsed = parseOpenAiCompletion(completion);
  if (onToken && parsed.content) onToken(parsed.content);
  return parsed;
}

async function completeAnthropic(
  config: HostedProviderConfig,
  fetchImpl: typeof fetch,
  request: ProviderRequest,
): Promise<ProviderResponse> {
  const url = joinUrl(config.endpoint, "/messages");
  const onToken = request.onToken;
  const shaped = toAnthropicRequest(request.messages, request.tools);
  const body = {
    model: config.model,
    max_tokens: config.maxTokens ?? DEFAULT_MAX_TOKENS,
    ...shaped,
    ...(onToken ? { stream: true } : {}),
  };
  const res = await fetchImpl(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": config.apiKey,
      "anthropic-version": config.anthropicVersion ?? DEFAULT_ANTHROPIC_VERSION,
      // Enables Anthropic's browser CORS path for direct client-side calls.
      "anthropic-dangerous-direct-browser-access": "true",
    },
    body: JSON.stringify(body),
    signal: request.signal,
  });
  await assertOk(res);
  if (onToken && isEventStream(res)) {
    const assembler = createAnthropicStreamAssembler();
    let streamError: Error | undefined;
    await readSseStream(
      res.body ?? new ReadableStream<Uint8Array>(),
      (event) => {
        const parsed = parseJsonEvent<AnthropicStreamEvent & { error?: { message?: string } }>(
          event.data,
        );
        if (!parsed) return;
        // Anthropic reports mid-stream failures as an `error` event.
        if (parsed.type === "error") {
          streamError = new HostedProviderError(parsed.error?.message ?? "stream error", 200);
          return;
        }
        const delta = assembler.push(parsed);
        if (delta) onToken(delta);
      },
      request.signal,
    );
    if (streamError) throw streamError;
    return parseAnthropicCompletion(assembler.finish());
  }
  const completion = (await res.json()) as AnthropicCompletion;
  const parsed = parseAnthropicCompletion(completion);
  if (onToken && parsed.content) onToken(parsed.content);
  return parsed;
}

/** Reject a non-2xx response with the provider's own error text. */
async function assertOk(res: Response): Promise<void> {
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new HostedProviderError(detail || res.statusText, res.status);
  }
}

/** Whether the response is an SSE stream (plain substring check on the header). */
function isEventStream(res: Response): boolean {
  const type = res.headers.get("content-type") ?? "";
  return type.includes("text/event-stream");
}

/** Parse one SSE `data:` payload as JSON; malformed payloads are skipped. */
function parseJsonEvent<T extends object>(data: string): T | undefined {
  try {
    const parsed = JSON.parse(data) as unknown;
    return parsed && typeof parsed === "object" ? (parsed as T) : undefined;
  } catch {
    return undefined;
  }
}
