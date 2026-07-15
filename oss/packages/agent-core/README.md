# @uptimizr/agent-core

The **framework-agnostic, browser-safe core** for Uptimizr analytics agents. It defines the agent
tool surface **once** so every consumer — the [`@uptimizr/mcp`](../mcp/README.md) server, the
dashboard assistant, and the backend-less demo assistant — asks the same questions of the same
read-only collector query API (ADR 0050 §1).

It owns three things:

1. **The read-only tool catalog** (`readTools`) — one entry per documented aggregate query
   endpoint. Pure Zod shapes, no Node dependencies, unit-testable without a live collector.
2. **A headless LLM provider-adapter interface** (`LlmProvider`) — send messages + tool schemas,
   receive tool calls or a final answer. The core ships **no model and no key**; adapters
   (WebLLM/WebGPU, an OpenAI-compatible or Anthropic endpoint) are user-selected and
   user-controlled (ADR 0050 §4).
3. **The headless tool-calling loop** (`runAgent`) — drives the LLM ↔ tools ↔ collector round trip,
   framework-agnostic and runnable in a browser, a Node service, a CLI, or a bot.

Everything here is **strictly read-only**: the loop only ever issues collector `GET`s through the
catalog. There are **no** ingestion, mutation, or raw per-session event tools (ADR 0003 / ADR 0017).

## Install

```bash
npm install @uptimizr/agent-core
```

## Use

```ts
import { createCollectorClient, runAgent, type LlmProvider } from "@uptimizr/agent-core";

// 1. A read-only client bound to your own collector + project key.
const client = createCollectorClient({
  collectorUrl: "https://collect.example.com",
  apiKey: "utk_…",
});

// 2. Your chosen LLM backend, adapted to the provider interface.
const provider: LlmProvider = {
  async complete({ messages, tools }) {
    // Call WebLLM / an OpenAI-compatible or Anthropic endpoint here, passing
    // `tools` as the tool/function schemas, and normalise the reply into either
    //   { kind: "tool_calls", toolCalls: [...] }  or  { kind: "final", content }.
    return { kind: "final", content: "…" };
  },
};

// 3. Run the loop. It executes any tool calls against the collector for you.
const result = await runAgent({
  provider,
  client,
  messages: [
    { role: "system", content: "You are a 3D analytics assistant." },
    { role: "user", content: "What were the most-clicked meshes this week?" },
  ],
});

console.log(result.content); // the model's final answer
```

## Tool catalog (read-only)

`list_sessions`, `pointer_heatmap`, `world_heatmap`, `camera_heatmap`, `click_rays`, `flow_links`,
`top_meshes`, `perf_summary`, `list_scenes`, `timeseries`, `event_counts`, `session_meta`,
`scene_representation`, `funnel`, `aggregate_paths`, `rendering_technology`, `xr_rotation`,
`xr_sources`, `xr_abandonment`, `xr_locomotion`. Most accept `since`/`until` (epoch ms) plus
endpoint-specific filters (`scene`, `session`, `source`, `bins`, `cellSize`, `limit`, `cameraMode`,
`rapidTurn`, `steps`). Each maps one-to-one to a documented
collector query endpoint (see the [integration guide](https://github.com/RaananW/Uptimizr/blob/main/docs/integration.md)).

## API

| Export                         | Purpose                                                           |
| ------------------------------ | ----------------------------------------------------------------- |
| `readTools`                    | The read-only tool catalog (one entry per query endpoint).        |
| `createCollectorClient(cfg)`   | Thin `GET`-only collector client (`fetch`-based, injectable).     |
| `toToolSchemas(tools?)`        | Convert catalog tools to JSON-Schema tool descriptors for an LLM. |
| `runAgent(options)`            | The headless tool-calling loop.                                   |
| `LlmProvider` / `AgentMessage` | The provider-adapter interface and message types.                 |

The loop stops when the provider returns a final answer or after `maxSteps` turns
(`DEFAULT_MAX_STEPS`, default 8). Unknown tools and invalid arguments are surfaced back to the model
as tool-error messages so it can recover, never thrown.

## More

- Design rationale: [ADR 0050](https://github.com/RaananW/Uptimizr/blob/main/docs/adr/0050-in-browser-analytics-assistant.md)
- MCP server built on this catalog: [`@uptimizr/mcp`](../mcp/README.md)
- Integration & API reference: https://github.com/RaananW/Uptimizr/blob/main/docs/integration.md
