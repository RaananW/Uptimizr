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
 */

import type { LlmProvider, ProviderRequest, ProviderResponse } from "../provider.js";
import type { HostedApi } from "./config.js";
import {
  parseOpenAiCompletion,
  toOpenAiMessages,
  toOpenAiTools,
  type OpenAiCompletion,
} from "./openai.js";
import {
  parseAnthropicCompletion,
  toAnthropicRequest,
  type AnthropicCompletion,
} from "./anthropic.js";

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

function joinUrl(base: string, suffix: string): string {
  let end = base.length;
  while (end > 0 && base[end - 1] === "/") end--;
  const trimmed = base.slice(0, end);
  return trimmed.endsWith(suffix) ? trimmed : `${trimmed}${suffix}`;
}

/**
 * Create a hosted provider bound to one `(api, endpoint, apiKey, model)`. The
 * returned {@link LlmProvider} issues one direct request per turn to the user's
 * provider and normalises the reply.
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
  // No tools this turn (e.g. the loop's forced synthesis pass) → omit `tools`
  // and `tool_choice` entirely so the model answers in plain text rather than
  // being nudged to keep calling functions.
  const body = {
    model: config.model,
    messages: toOpenAiMessages(request.messages),
    ...(request.tools.length > 0
      ? { tools: toOpenAiTools(request.tools), tool_choice: "auto" as const }
      : {}),
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
  const completion = (await readJson(res)) as OpenAiCompletion;
  return parseOpenAiCompletion(completion);
}

async function completeAnthropic(
  config: HostedProviderConfig,
  fetchImpl: typeof fetch,
  request: ProviderRequest,
): Promise<ProviderResponse> {
  const url = joinUrl(config.endpoint, "/messages");
  const shaped = toAnthropicRequest(request.messages, request.tools);
  const body = {
    model: config.model,
    max_tokens: config.maxTokens ?? DEFAULT_MAX_TOKENS,
    ...shaped,
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
  const completion = (await readJson(res)) as AnthropicCompletion;
  return parseAnthropicCompletion(completion);
}

async function readJson(res: Response): Promise<unknown> {
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new HostedProviderError(detail || res.statusText, res.status);
  }
  return res.json();
}
