export {
  createCollectorClient,
  CollectorError,
  type CollectorClient,
  type CollectorClientConfig,
  type QueryParams,
} from "./client.js";
export {
  readTools,
  rawTools,
  coreReadTools,
  selectReadTools,
  filterReadTools,
  CORE_READ_TOOL_NAMES,
  type ReadTool,
  type ReadToolRequest,
  type ReadToolSetKind,
} from "./tools.js";
export {
  registryToTools,
  metricToTool,
  describeMetric,
  DEFAULT_TOOL_FORMAT,
} from "./registryTools.js";
export { QUERY_TOOL_NAME, queryTool } from "./queryTool.js";
// Metadata write tools (#310) — a separate export from `readTools` on purpose,
// so ADR 0017's read-only stance stays inspectable at a glance.
export {
  writeTools,
  mutatingWriteTools,
  annotateTool,
  defineTermTool,
  saveAnalysisTool,
  listAnnotationsTool,
  listGlossaryTool,
  listAnalysesTool,
  WriteNotSupportedError,
  type WriteTool,
} from "./writeTools.js";
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
