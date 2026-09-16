/**
 * Choosing which backend answers the question bank (design sketch §H).
 *
 * Three providers, all behind the same `LlmProvider` seam the dashboard and MCP
 * use:
 *
 * - **`scripted`** — deterministic, no key, no network. What CI runs on every
 *   PR, and what the committed baseline is recorded against.
 * - **`hosted`** — a real frontier model through
 *   `@uptimizr/agent-core/providers/hosted`: Anthropic (default, `claude-sonnet-5`)
 *   or any OpenAI-compatible endpoint. Configured **only** from the environment;
 *   the key is read once into the adapter and is never written to the report, the
 *   baseline, a log line or an error message.
 * - **`webllm`** — a curated local model in a headless browser. Not wired up
 *   here: see `scripts/webllm-eval.ts` for why (WebGPU headless) and what the
 *   weekly job would need.
 */

import { createHostedProvider } from "@uptimizr/agent-core/providers/hosted";
import type { LlmProvider } from "@uptimizr/agent-core";

/** The backends the runner can be pointed at. */
export type ProviderKind = "scripted" | "hosted";

/** Default model when `UPTIMIZR_EVAL_MODEL` is unset, per wire format. */
const DEFAULT_MODELS = {
  anthropic: "claude-sonnet-5",
  openai: "gpt-4o-mini",
} as const;

/** Default endpoint when `UPTIMIZR_EVAL_ENDPOINT` is unset, per wire format. */
const DEFAULT_ENDPOINTS = {
  anthropic: "https://api.anthropic.com/v1",
  openai: "https://api.openai.com/v1",
} as const;

/** The subset of `process.env` this module reads. */
export type Env = Record<string, string | undefined>;

/** A resolved hosted configuration, minus the key (which is never surfaced). */
export interface HostedDescription {
  api: "anthropic" | "openai";
  model: string;
  endpoint: string;
}

/**
 * The provider API key, from the eval-specific variable first and the provider's
 * conventional variable as a fallback, so a developer who already exports
 * `ANTHROPIC_API_KEY` can run the hosted eval without a second export.
 */
function readApiKey(env: Env, api: "anthropic" | "openai"): string | undefined {
  const fallback = api === "anthropic" ? env.ANTHROPIC_API_KEY : env.OPENAI_API_KEY;
  const key = env.UPTIMIZR_EVAL_API_KEY ?? fallback;
  return key && key.trim() !== "" ? key : undefined;
}

/** Which wire format the hosted run should speak. */
export function hostedApiFrom(env: Env): "anthropic" | "openai" {
  return env.UPTIMIZR_EVAL_PROVIDER?.toLowerCase() === "openai" ? "openai" : "anthropic";
}

/** Whether a hosted run is possible at all (i.e. a key is present). */
export function hostedKeyAvailable(env: Env): boolean {
  return readApiKey(env, hostedApiFrom(env)) !== undefined;
}

/** The hosted configuration, for the report header. Never includes the key. */
export function describeHosted(env: Env): HostedDescription {
  const api = hostedApiFrom(env);
  return {
    api,
    model: env.UPTIMIZR_EVAL_MODEL ?? DEFAULT_MODELS[api],
    endpoint: env.UPTIMIZR_EVAL_ENDPOINT ?? DEFAULT_ENDPOINTS[api],
  };
}

/**
 * Build the hosted provider from the environment, or throw a message that names
 * the variables to set — and nothing else. The key never leaves this function
 * except into the adapter it configures.
 */
export function createHostedProviderFromEnv(env: Env): LlmProvider {
  const { api, model, endpoint } = describeHosted(env);
  const apiKey = readApiKey(env, api);
  if (!apiKey) {
    throw new Error(
      "no provider key: set UPTIMIZR_EVAL_API_KEY (or ANTHROPIC_API_KEY / OPENAI_API_KEY) " +
        "to run the hosted eval.",
    );
  }
  // 1024 output tokens is enough for a paragraph-and-figures analytics answer and
  // keeps a full bank run cheap; the loop's own step cap bounds the turn count.
  return createHostedProvider({ api, endpoint, apiKey, model, maxTokens: 1024 });
}
