/**
 * The deterministic, secret-free provider the CI gate runs (design sketch §H).
 *
 * It is a real {@link LlmProvider} driven through the real `runAgent` loop
 * against the real collector — only the "model" is replaced by a rule. On its
 * first turn it asks for one tool per any-of set in the case, with arguments
 * assembled from the case's context (range, scene, session) and its
 * `expectedArgs`; on its second it answers from **what the collector actually
 * returned**, never from the case's expected values.
 *
 * That last point is what makes the mock worth running: the answer is a
 * rendering of live tool output, so a case whose `expectedAnswer` does not
 * follow from the data it asks for fails here, in CI, with no key and no
 * network — and the scoring code is exercised end to end on every PR.
 */

import type {
  AgentMessage,
  AgentToolCall,
  LlmProvider,
  ProviderRequest,
  ProviderResponse,
  ReadTool,
} from "@uptimizr/agent-core";
import type { EvalCase } from "../cases.js";
import { EVAL_RANGE } from "../fixtures.js";
import { REQUIRED_TOOL_ARGS } from "../toolArgs.js";

/**
 * Build the arguments for one tool call: the case's range/scene/session context
 * where the tool accepts it, the tool's required-argument defaults, and finally
 * the case's own `expectedArgs`, which always win.
 */
export function scriptedArgsFor(evalCase: EvalCase, tool: ReadTool): Record<string, unknown> {
  const schema = tool.inputSchema;
  const context = evalCase.context;
  const args: Record<string, unknown> = {};

  if ("since" in schema) args.since = context.since ?? EVAL_RANGE.since;
  if ("until" in schema) args.until = context.until ?? EVAL_RANGE.until;
  if (context.scene && "scene" in schema) args.scene = context.scene;
  if (context.session && "session" in schema) args.session = context.session;
  if (context.scene && "sceneId" in schema) args.sceneId = context.scene;
  if (context.session && "sessionId" in schema) args.sessionId = context.session;

  for (const [key, value] of Object.entries(REQUIRED_TOOL_ARGS[tool.name] ?? {})) {
    if (key in schema && !(key in args)) args[key] = value;
  }
  for (const [key, value] of Object.entries(evalCase.expectedArgs[tool.name] ?? {})) {
    args[key] = value;
  }
  return args;
}

/** Render one tool result message as a line of the scripted answer. */
function resultLine(message: AgentMessage & { role: "tool" }): string {
  return `${message.name}: ${message.content}`;
}

/**
 * A scripted provider for one case. `tools` is the catalog the run exposes;
 * a case naming a tool outside it throws, so a bank that drifts from the
 * generated catalog fails loudly rather than silently scoring zero.
 */
export function createScriptedProvider(
  evalCase: EvalCase,
  tools: readonly ReadTool[],
): LlmProvider {
  const byName = new Map(tools.map((tool) => [tool.name, tool]));

  return {
    async complete(request: ProviderRequest): Promise<ProviderResponse> {
      const results = request.messages.filter(
        (m): m is AgentMessage & { role: "tool" } => m.role === "tool",
      );

      // Nothing gathered yet (and tools are on the table): call the first tool of
      // every any-of set, which is the bank's canonical route to the answer.
      if (results.length === 0 && request.tools.length > 0) {
        const toolCalls: AgentToolCall[] = evalCase.expectedTools.map((anyOf, index) => {
          const name = anyOf[0]!;
          const tool = byName.get(name);
          if (!tool) {
            throw new Error(
              `case "${evalCase.id}" expects tool "${name}", which is not in the catalog`,
            );
          }
          return {
            id: `${evalCase.id}-${index}`,
            name,
            arguments: scriptedArgsFor(evalCase, tool),
          };
        });
        return { kind: "tool_calls", toolCalls };
      }

      // Deliberately NOT an echo of the question: the answer must be composed
      // only of what the collector returned, so a required phrase in the bank has
      // to be a token the data really carries rather than one the question
      // happened to use.
      const body = results.map(resultLine).join("\n");
      return {
        kind: "final",
        content: `Results from ${results.length} collector call(s):\n${body}`,
      };
    },
  };
}
