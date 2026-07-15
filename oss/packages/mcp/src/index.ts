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
export { version } from "./version.js";
