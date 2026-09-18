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
export { registryToTools, metricToTool, describeMetric } from "./registryTools.js";
export type {
  AgentMessage,
  AgentToolCall,
  AgentToolSchema,
  LlmProvider,
  ProviderRequest,
  ProviderResponse,
} from "./provider.js";
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
