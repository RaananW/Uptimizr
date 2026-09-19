export { readMcpConfig, type McpConfig } from "./config.js";
export {
  createCollectorClient,
  CollectorError,
  readTools,
  rawTools,
  type CollectorClient,
  type CollectorClientConfig,
  type QueryParams,
  type ReadTool,
  type ReadToolRequest,
} from "@uptimizr/agent-core";
// The metadata write tools (#310) — deliberately a separate export from
// `readTools` above, so an integration's read-only stance stays inspectable
// (ADR 0017): events are read-only, metadata writes sit behind `annotate`.
export { writeTools, mutatingWriteTools, type WriteTool } from "@uptimizr/agent-core";
export { createMcpServer, fetchKeyCapabilities, type CreateMcpServerOptions } from "./server.js";
export {
  buildCapabilities,
  type BuildCapabilitiesOptions,
  type CapabilitiesDescriptor,
  type CapabilityToolDescriptor,
  type CapabilityParamDescriptor,
} from "./capabilities.js";
export { registerResources, CAPABILITIES_URI, SCENES_URI, SKILLS_URI } from "./resources.js";
export { registerPrompts } from "./prompts.js";
export { version } from "./version.js";
