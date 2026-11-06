---
title: Ask an AI agent about your 3D analytics
description: Connect Claude or another MCP client to your own 3D analytics and ask questions in plain English, with answers grounded in real metrics, units and caveats.
lastUpdated: 2026-11-06
---

You can ask an AI agent questions about your 3D scene in plain English, such as "which objects do
people see but never touch?", and get an answer from your own data. Uptimizr includes a
[Model Context Protocol (MCP)](https://modelcontextprotocol.io) server, so Claude or any other MCP
client can query your self-hosted collector directly. No export or copy-paste is needed.

## What you can ask

An agent can call any metric the collector serves, so you can ask the questions you'd otherwise answer
by opening several dashboard panels:

- "What was the most-clicked mesh this week?"
- "Which objects do people see but never interact with?"
- "Did frame rate get worse this week, and on which devices?"
- "Where does our configurator funnel lose people?"
- "How much of the product do most visitors actually look at?"
- "Is this VR scene comfortable, or do people turn their heads too fast?"

Answers depend on what you capture. Some reports need opt-in channels: blind spots, for example, need
`capture.meshVisibility`. If a channel is off, the agent can see that and tell you, rather than reading
an empty result as a finding.

## Why this works better than pasting data into a chat

Analytics numbers are easy for a model to misread. "Average FPS is 48" means something different when
it comes from 12 samples, or when the capture channel behind it was never turned on. Uptimizr declares
every metric in a [semantic registry](/docs/guides/agents/#1-the-semantic-metric-registry), so that
context reaches the agent with the data.

| Common problem                               | What the agent gets instead                                                           |
| -------------------------------------------- | ------------------------------------------------------------------------------------- |
| It doesn't know what a column means          | A description and a unit for each column, such as `ms`, `fps` or `world-units`        |
| It quotes a number from too small a sample   | Caveats on each metric, including minimum sample sizes                                |
| It reports a disabled channel's zero as news | The channels each metric depends on, and which ones are off in your project           |
| It invents scene or event names              | A [project context](/docs/api/context/) document with your real scene and event names |
| It's handed thousands of rows                | Bounded `summary` results with shares, caveats and a templated reading                |

This doesn't make an agent's conclusions correct. It gives the model what it needs to read the data
properly, and a person should still check any decision that matters.

## Connect an agent

You need a running [collector](/docs/deploy/collector/) with some data in it.

**1. Create a dedicated read-only key.** Don't reuse the owner key that `uptimizr init` printed,
because it can do much more than an agent needs.

```bash
npx -p @uptimizr/collector-server uptimizr new-key <projectId> \
  --capabilities query --label "mcp-agent"
```

**2. Add the server to your MCP client.** This works for Claude Desktop, VS Code and Cursor:

```json
{
  "mcpServers": {
    "uptimizr": {
      "command": "npx",
      "args": ["-y", "@uptimizr/mcp"],
      "env": {
        "UPTIMIZR_COLLECTOR_URL": "https://collect.example.com",
        "UPTIMIZR_API_KEY": "utk_your_key"
      }
    }
  }
}
```

**3. Ask a question.** Start with something you already know the answer to, so you can check the
result. To connect from another machine, the collector can also
[host the server over HTTP](/docs/guides/mcp/#hosted-transport-streamable-http).

## Run a packaged investigation

Five investigations are included as MCP prompts. Each one gives the agent a method to follow, so you
get the same structured process every time instead of a one-off answer.

| Investigation                   | What it does                                                    |
| ------------------------------- | --------------------------------------------------------------- |
| `attention_hotspots`            | Finds where visitors look and click in a scene                  |
| `conversion_investigation`      | Finds where a funnel loses people, and whether the loss is real |
| `performance_regression_triage` | Confirms, dates and locates a frame-rate or stability drop      |
| `weekly_scene_health`           | Runs a weekly health check on a scene or project                |
| `xr_comfort_audit`              | Audits VR and AR comfort                                        |

You can also run these on a schedule with
[`uptimizr agent report`](/docs/deploy/collector/#scheduled-agent-reports), which writes a Markdown
report that lists every tool call it made.

## What an agent can and can't do

- **It can't change your analytics.** The server has no ingestion tool, and nothing in it can write,
  alter or delete an event.
- **It only sees one project.** The collector resolves the project from the key, so an agent can't
  read another project's data.
- **It reads aggregates by default.** A `query` key can't read raw per-session streams. Adding
  `query:raw` unlocks one extra tool, a compacted account of a single session.
- **Writing notes is opt-in.** With the `annotate` capability, an agent can save notes, definitions
  and analyses in project metadata. Without it, the server is read-only.
- **You can see what it did.** The audit log records activity per key, and you can give each key its
  own rate limit.

## Where your data goes

The MCP server only talks to your collector, and Uptimizr runs no service in between. The model you
use is a separate matter: whichever model the agent runs on sees the results it's given.

| How you connect                                              | What leaves your infrastructure                            |
| ------------------------------------------------------------ | ---------------------------------------------------------- |
| MCP with a hosted model, such as Claude                      | Your prompts and the results, sent to that provider        |
| [In-browser assistant](/docs/guides/assistant/), local model | Nothing: the model runs on your GPU in the browser         |
| In-browser assistant, your own hosted key                    | Your prompts and aggregated results, sent to that provider |

Check your provider's data terms before you connect production analytics. Use the local option if
nothing may leave the browser.

## Other ways to connect

- **No MCP client?** The [in-browser assistant](/docs/guides/assistant/) is built into the dashboard.
  You can [try it in the live demo](https://demo.uptimizr.com), where it runs entirely in your browser.
- **Building your own tool?** The collector serves an
  [OpenAPI 3.1 document](/docs/guides/mcp/#openapi) that carries the same units and caveats, so you
  don't need MCP at all.

## Next steps

- Read the [MCP server guide](/docs/guides/mcp/) for every tool and option.
- See [Building agents on Uptimizr](/docs/guides/agents/) for the full picture.
- Follow the [Quickstart](/docs/quickstart/) if you haven't captured any data yet.
