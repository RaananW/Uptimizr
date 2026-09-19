---
"@uptimizr/collector-server": minor
"@uptimizr/agent-core": minor
"@uptimizr/react": patch
"@uptimizr/mcp": patch
---

`uptimizr agent report` — headless, scheduled analytics reports (ADR 0051 §6).

A new collector CLI subcommand runs the headless `runAgent` loop **once**, in the operator's own
process, over the generated read-only tool catalog against the collector's query API, and writes a
Markdown report to a file, stdout or a signed webhook:

```bash
uptimizr agent report --skill weekly_scene_health --scene lobby --window 7d \
  --out report.md --json report.json --webhook https://hooks.example.com/uptimizr
```

The collector gains no in-process LLM loop and scheduling stays the operator's (cron, a systemd
timer, a GitHub Action). Provider configuration is read from the environment only and never
persisted, and the provider key never reaches a log, a report or an error message. The system
prompt carries the rendered `GET /api/v1/context` document, and every report ends with a **Method**
section listing each tool call and its arguments, so an unattended, model-written document stays
auditable. `--dry-run` prints the exact prompt without calling a provider, and
`UPTIMIZR_AGENT_PROVIDER=scripted` exercises the whole path with no model, no key and no egress.

`@uptimizr/agent-core` gains the pieces both clients now share: `AGENT_SKILLS` (the curated
investigations, previously inlined in `@uptimizr/mcp`'s prompt templates, which now register from
them), the `ANALYTICS_AGENT_GUIDELINES` / `renderCurrentTimeLine` system-prompt fragments the
browser assistant already used, and an optional `ProviderResponse.usage` that the hosted adapters
fill from the provider's own token accounting. No prompt text changes for any existing consumer.
