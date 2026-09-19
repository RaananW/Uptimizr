import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { AGENT_SKILLS, type AgentSkill } from "@uptimizr/agent-core";
import { z } from "zod";

/**
 * Curated prompt templates for common 3D-analytics investigations (ADR 0050 §7).
 * Each renders a single user message that steers the agent to call the existing
 * read-only tools in a sensible order — no data is fetched here; the agent runs
 * the tools. Templates are intentionally tool-agnostic about exact arguments so
 * the agent can adapt (e.g. resolve the current epoch-ms range itself).
 *
 * The templates themselves are the **agent skills** of `@uptimizr/agent-core`
 * (`AGENT_SKILLS`). They live there because the headless `uptimizr agent report`
 * CLI seeds its transcript with the same text (ADR 0051 §6, design sketch §F.4)
 * and the eval bank asks the same questions; this module is the MCP *binding* —
 * it turns each skill's argument list into a Zod `argsSchema` and its `render`
 * into the single user message `prompts/get` returns. Reword a skill once and
 * every client changes with it.
 */

/** Build a prompt template's Zod `argsSchema` from a skill's argument list. */
function argsSchemaFor(skill: AgentSkill): Record<string, z.ZodType> {
  const shape: Record<string, z.ZodType> = {};
  for (const arg of skill.args) {
    shape[arg.name] = arg.required
      ? z.string().describe(arg.description)
      : z.string().optional().describe(arg.description);
  }
  return shape;
}

/** Register the curated prompt templates on the server. */
export function registerPrompts(server: McpServer): void {
  for (const skill of AGENT_SKILLS) {
    server.registerPrompt(
      skill.name,
      {
        title: skill.title,
        description: skill.description,
        argsSchema: argsSchemaFor(skill) as never,
      },
      ((args: Record<string, string | undefined>) => ({
        messages: [
          {
            role: "user" as const,
            content: { type: "text" as const, text: skill.render(args) },
          },
        ],
      })) as never,
    );
  }
}
