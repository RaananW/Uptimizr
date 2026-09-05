// @uptimizr/react/assistant — the in-browser analytics assistant surface
// (ADR 0050 §2, ADR 0047).
//
// A SEPARATE entry point from the core `@uptimizr/react` barrel on purpose:
// importing it is what pulls the assistant + agent-core code into your graph.
// The core entry stays free of any LLM/agent code, so a consumer who renders
// only the panels pays nothing for the assistant. The heavy `@mlc-ai/web-llm`
// runtime stays an OPTIONAL peer, loaded lazily by agent-core only when a local
// model actually runs — exactly like `@uptimizr/react/panels-3d` code-splits
// Babylon.
//
//   import { AssistantPanel, useAssistant } from "@uptimizr/react/assistant";

export { useAssistant } from "./useAssistant";
export type {
  UseAssistantOptions,
  UseAssistantResult,
  AssistantStatus,
  AssistantToolActivity,
  ToolCallStatus,
} from "./useAssistant";
export { AssistantPanel } from "./AssistantPanel";
export type { AssistantPanelProps } from "./AssistantPanel";
export { DEFAULT_SYSTEM_PROMPT, composeSystemPrompt } from "./prompt";

// Re-export the agent-core backend types a consumer needs to build/inspect a
// backend config, so they don't have to also import `@uptimizr/agent-core`.
export type {
  AssistantBackendConfig,
  BackendKind,
  HostedApi,
  HostedBackendConfig,
  WebLlmBackendConfig,
  WebLlmCachePolicy,
  CuratedModel,
  InitProgress,
} from "@uptimizr/agent-core/providers";
