export { readMcpConfig, type McpConfig } from "./config.js";
export {
  createCollectorClient,
  CollectorError,
  readTools,
  type CollectorClient,
  type CollectorClientConfig,
  type QueryParams,
  type ReadTool,
  type ReadToolRequest,
} from "@uptimizr/agent-core";
export { createMcpServer } from "./server.js";
export {
  buildCapabilities,
  type CapabilitiesDescriptor,
  type CapabilityToolDescriptor,
  type CapabilityParamDescriptor,
} from "./capabilities.js";
export { registerResources, CAPABILITIES_URI, SCENES_URI } from "./resources.js";
export { registerPrompts } from "./prompts.js";
export { version } from "./version.js";
