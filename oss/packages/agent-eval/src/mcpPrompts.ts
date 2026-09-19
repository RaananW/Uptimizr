/**
 * Render the curated MCP prompt templates as plain question text.
 *
 * `@uptimizr/mcp` serves the packaged methodology skills (ADR 0051 §7) as prompt
 * templates — the canned investigations an MCP client offers a user, and
 * therefore some of the most important questions the agent will ever be asked.
 *
 * The bank renders those skills straight from `@uptimizr/agent-core`, which is
 * where their text lives. This module renders them the *other* way, through the
 * MCP binding, so the coverage suite can assert the two surfaces agree — if they
 * ever diverge, the bank has stopped measuring what a real client sends:
 * `registerPrompts` is called with a minimal recorder standing in for an
 * `McpServer`, capturing each template's handler, and
 * {@link renderMcpPrompt} runs the handler and returns the user message it
 * produces. Reword a `SKILL.md` and both renderings change with it — there is
 * nothing to keep in step.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerPrompts } from "@uptimizr/mcp";

/** What a registered prompt handler returns (the shape this module reads). */
interface PromptResult {
  messages: { role: string; content: { type: string; text?: string } }[];
}

type PromptHandler = (args: Record<string, string | undefined>) => PromptResult;

function collectPrompts(): Map<string, PromptHandler> {
  const handlers = new Map<string, PromptHandler>();
  const recorder = {
    registerPrompt(name: string, _meta: unknown, handler: PromptHandler) {
      handlers.set(name, handler);
    },
  };
  registerPrompts(recorder as unknown as McpServer);
  return handlers;
}

const PROMPTS = collectPrompts();

/** The names of the curated prompts, in registration order. */
export const MCP_PROMPT_NAMES: readonly string[] = [...PROMPTS.keys()];

/**
 * Render one curated prompt's user message. Throws on an unknown name (a typo in
 * the bank should fail loudly) or on a prompt that produced no text.
 */
export function renderMcpPrompt(
  name: string,
  args: Record<string, string | undefined> = {},
): string {
  const handler = PROMPTS.get(name);
  if (!handler) {
    throw new Error(
      `unknown MCP prompt "${name}" (known: ${MCP_PROMPT_NAMES.join(", ") || "none"})`,
    );
  }
  const text = handler(args).messages.find((m) => m.role === "user")?.content.text;
  if (!text) throw new Error(`MCP prompt "${name}" rendered no user text`);
  return text;
}
