# AGENTS.md — @uptimizr/agent-core

> Packaged agent guide. For the human reference see [README.md](./README.md); for design
> rationale see the project ADRs at https://github.com/RaananW/Uptimizr/tree/main/docs/adr.

## What this package is

The **framework-agnostic, browser-safe core** shared by every Uptimizr analytics agent. It defines
the agent tool surface **once** (ADR 0050 §1) so `@uptimizr/mcp`, the dashboard assistant, and the
demo assistant never drift apart. It owns:

- the **read-only tool catalog** (`readTools`) — one entry per documented collector query endpoint,
  **generated** from the `@uptimizr/db` semantic metric registry (ADR 0051 §1), so coverage of the
  collector's read surface cannot drift;
- a headless **LLM provider-adapter interface** (`LlmProvider`) — messages + tool schemas in, tool
  calls or final text out;
- the headless **tool-calling loop** (`runAgent`) — LLM ↔ tools ↔ collector.

The core ships **no model and no key**. It only ever reads a consumer's **own** collector via the
`CollectorClient` (`GET`-only, `x-api-key`).

## Rules for agents

- **Read-only and privacy-preserving.** Never add ingestion, mutation, or raw per-session event
  tools. The surface is aggregate-only; no data leaves the consumer's infrastructure (ADR 0003 /
  ADR 0017). A new tool = a new **metric registry entry** in `@uptimizr/db` for a documented query
  endpoint — never a hand-written catalog entry here — and no aggregation/business logic (that lives
  in the collector, ADR 0005).
- **Browser-safe.** No Node dependencies, no `types: ["node"]`. At runtime this package uses `zod`
  plus the pure, data-only `@uptimizr/db/registry` subpath — never the `@uptimizr/db` root barrel,
  which owns the DuckDB store. `src/__tests__/browserSafety.test.ts` bundles the package for the
  browser and fails if that changes. Anything that needs `process.env`, stdio, or the filesystem
  belongs in a consumer package (e.g. `@uptimizr/mcp`), not here.
- Tool definitions are pure (`buildRequest`) and must stay unit-testable without a live collector.
- The 20 tool names (and argument schemas) that shipped before the registry are a public contract:
  `src/__tests__/shippedToolCompat.test.ts` pins them against a frozen fixture. Widening a tool with
  a new **optional** argument is fine; renaming one or making an argument required is not.
- Keep provider adapters thin and out of this package: implement `LlmProvider` in the consumer.

## Programmatic API

`readTools`, `coreReadTools`, `selectReadTools(kind)`, `filterReadTools(names)`,
`registryToTools(metrics?)`, `createCollectorClient(config)`, `toToolSchemas(tools?)`,
`runAgent(options)`, plus the `LlmProvider` / `AgentMessage` / `AgentToolCall` /
`ProviderResponse` types.

The catalog is ~69 tools. A small local model cannot hold every schema in its function-calling
prompt — hand a run `coreReadTools` or `filterReadTools([...])` rather than the full catalog.

## More

- Package reference: [README.md](./README.md)
- Integration guide: https://github.com/RaananW/Uptimizr/blob/main/docs/integration.md
