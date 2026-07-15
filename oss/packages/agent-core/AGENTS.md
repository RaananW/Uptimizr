# AGENTS.md — @uptimizr/agent-core

> Packaged agent guide. For the human reference see [README.md](./README.md); for design
> rationale see the project ADRs at https://github.com/RaananW/Uptimizr/tree/main/docs/adr.

## What this package is

The **framework-agnostic, browser-safe core** shared by every Uptimizr analytics agent. It defines
the agent tool surface **once** (ADR 0050 §1) so `@uptimizr/mcp`, the dashboard assistant, and the
demo assistant never drift apart. It owns:

- the **read-only tool catalog** (`readTools`) — one entry per documented collector query endpoint;
- a headless **LLM provider-adapter interface** (`LlmProvider`) — messages + tool schemas in, tool
  calls or final text out;
- the headless **tool-calling loop** (`runAgent`) — LLM ↔ tools ↔ collector.

The core ships **no model and no key**. It only ever reads a consumer's **own** collector via the
`CollectorClient` (`GET`-only, `x-api-key`).

## Rules for agents

- **Read-only and privacy-preserving.** Never add ingestion, mutation, or raw per-session event
  tools. The surface is aggregate-only; no data leaves the consumer's infrastructure (ADR 0003 /
  ADR 0017). A new tool = a new entry in `readTools` mapping to a documented query endpoint — no
  aggregation/business logic (that lives in the collector, ADR 0005).
- **Browser-safe.** No Node dependencies, no `types: ["node"]`; only `zod` at runtime. Anything that
  needs `process.env`, stdio, or the filesystem belongs in a consumer package (e.g. `@uptimizr/mcp`),
  not here.
- Tool definitions are pure (`buildRequest`) and must stay unit-testable without a live collector.
- Keep provider adapters thin and out of this package: implement `LlmProvider` in the consumer.

## Programmatic API

`readTools`, `createCollectorClient(config)`, `toToolSchemas(tools?)`, `runAgent(options)`, plus the
`LlmProvider` / `AgentMessage` / `AgentToolCall` / `ProviderResponse` types.

## More

- Package reference: [README.md](./README.md)
- Integration guide: https://github.com/RaananW/Uptimizr/blob/main/docs/integration.md
