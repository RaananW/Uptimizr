---
"@uptimizr/metrics": minor
"@uptimizr/agent-core": minor
"@uptimizr/mcp": minor
"@uptimizr/db": patch
"@uptimizr/react": patch
---

Agent tools accept the `table` and `summary` result envelopes, and default to `table`.

A generated tool's `outputSchema` was the registry row array, so a call with `format=summary` or
`format=table` — the envelopes the guides tell agents to prefer — came back as a result the MCP SDK
rejected with `-32602 Output validation error`, on stdio and over `/mcp` alike. The schema now
describes all three envelopes, and `@uptimizr/mcp` returns the one that was asked for as
`structuredContent` (`full` keeps its `{ rows }` wrapping) instead of stripping it to rows.

**Behaviour change:** a tool called without `format` now asks the collector for `table` — the same
rows plus the `meta` block (metric, range, applied filters, sample size, row count, truncation flag,
limits) — where it used to ask for nothing and get bare rows. `full` is still available and
unchanged, and the collector's own default is still `full`, so an HTTP client such as the dashboard
is unaffected: the default lives in the tool and travels as an explicit `format=table`. A consumer
that reads a tool's `structuredContent` as an array must either ask for `format: "full"` or read
`.rows`. The argument stays optional, so no call becomes invalid.

The Zod envelope schemas now live in `@uptimizr/metrics` (`resultEnvelopeSchema`,
`tableEnvelopeSchema`, `summaryEnvelopeSchema`, `structuredEnvelopeSchema`, `resultFormatSchema`),
which is what lets the browser-safe agent packages describe them without depending on
`@uptimizr/db`. `@uptimizr/db/summary` re-exports them under its existing names, so that package's
public API is unchanged; the summariser that builds an envelope has not moved.

`@uptimizr/react`'s assistant inherits the new default: its tool calls now carry `format=table`, so
the model sees the `meta` context with its rows.
