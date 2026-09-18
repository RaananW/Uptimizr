export {
  createCollectorClient,
  CollectorError,
  type CollectorClient,
  type CollectorClientConfig,
  type QueryParams,
} from "./client.js";
export {
  readTools,
  coreReadTools,
  selectReadTools,
  filterReadTools,
  CORE_READ_TOOL_NAMES,
  type ReadTool,
  type ReadToolRequest,
  type ReadToolSetKind,
} from "./tools.js";
export { registryToTools, metricToTool, describeMetric } from "./registryTools.js";
// --- Project context (ADR 0051 §5, design sketch §E.1) ---
// The compact system-prompt rendering of the collector context document.
export { renderContextForPrompt, CONTEXT_PROMPT_MAX_CHARS } from "./context.js";
export type { PromptContextDocument } from "./context.js";
export type {
  AgentMessage,
  AgentToolCall,
  AgentToolSchema,
  LlmProvider,
  ProviderRequest,
  ProviderResponse,
  ProviderUsage,
} from "./provider.js";
// --- Shared system-prompt fragments (ADR 0050 §4, ADR 0051 §6) ---
// What every analytics agent says about the data, shared by the browser
// assistant and the headless report CLI.
export { ANALYTICS_AGENT_GUIDELINES, renderCurrentTimeLine } from "./prompt.js";
// --- Agent skills (ADR 0050 §7, ADR 0051 §6) ---
// The curated investigation methodologies shared by the MCP prompt templates and
// the headless `uptimizr agent report` CLI.
export {
  AGENT_SKILLS,
  AGENT_SKILL_NAMES,
  getAgentSkill,
  renderAgentSkill,
  type AgentSkill,
  type AgentSkillArg,
} from "./skills.js";
export {
  runAgent,
  toToolSchemas,
  truncateToolResult,
  DEFAULT_MAX_STEPS,
  DEFAULT_MAX_TOOL_RESULT_CHARS,
  type AgentStreamEvent,
  type RunAgentOptions,
  type RunAgentResult,
} from "./loop.js";
