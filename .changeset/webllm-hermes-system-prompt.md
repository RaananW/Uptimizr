---
"@uptimizr/agent-core": patch
---

Fix the local (WebLLM) assistant backend throwing `CustomSystemPromptError`
("When using Hermes-2-Pro function calling via ChatCompletionRequest.tools,
cannot specify customized system prompt.") when asking a question. WebLLM's
Hermes function-calling path injects its own system prompt and rejects a
caller-supplied `system` message while tools are present, so the WebLLM adapter
now folds the assistant's system instructions into the first user turn when
tools are sent. Hosted backends (OpenAI/Anthropic) are unchanged.
