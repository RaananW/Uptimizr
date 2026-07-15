---
"@uptimizr/agent-core": patch
---

Raise the WebLLM local model's context window to 8192 tokens so the analytics
assistant's prompt fits. The curated Hermes model records default to a
4096-token window, which rejected the assistant's system prompt + tool schemas +
results ("Prompt tokens exceed context window size"). The WebLLM adapter now
passes `chatOpts.context_window_size` when creating the engine (tunable via
`createWebLlmProvider({ contextWindowSize })`).
