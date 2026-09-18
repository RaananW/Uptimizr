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
export { createMcpServer, type CreateMcpServerOptions } from "./server.js";
export {
  buildCapabilities,
  type BuildCapabilitiesOptions,
  type CapabilitiesDescriptor,
  type CapabilityToolDescriptor,
  type CapabilityParamDescriptor,
} from "./capabilities.js";
export { registerResources, CAPABILITIES_URI, SCENES_URI } from "./resources.js";
export { registerPrompts } from "./prompts.js";
export { version } from "./version.js";
