---
title: MCP server (AI agents)
description: Let an AI agent answer natural-language questions about your 3D analytics with the read-only @uptimizr/mcp server.
---

`@uptimizr/mcp` is a **read-only** [Model Context Protocol](https://modelcontextprotocol.io) server over
your collector's query API. It lets an AI agent answer natural-language questions about your 3D analytics
("what was the most-clicked mesh this week?") by querying **your own** collector — nothing is sent to any
third party.

It's a thin wrapper: each tool maps one-to-one to a documented [query endpoint](/docs/api/query/) and
performs `GET` requests only. There are **no ingestion, mutation, or raw per-session event tools**.

The tool catalog itself lives in the framework-agnostic, browser-safe **`@uptimizr/agent-core`**
package, which `@uptimizr/mcp` imports. That means the agent tool surface is defined **once** and
shared by every consumer (the MCP server, the dashboard assistant, and the demo assistant), so they
can never drift apart on capabilities. See [ADR 0050](https://github.com/RaananW/Uptimizr/blob/main/docs/adr/0050-in-browser-analytics-assistant.md).

## How it connects

The MCP server talks **only to your collector's HTTP query API** — it never opens the database
(DuckDB/ClickHouse/Postgres) directly. The collector stays the single gateway to your data, so the
same auth, scoping, and privacy rules apply whether a human uses the dashboard or an agent uses MCP:

```text
AI agent ──stdio──▶ @uptimizr/mcp ──HTTPS GET + x-api-key──▶ collector ──▶ store (DuckDB / ClickHouse)
```

Because the collector resolves the project from the API key, an agent can only ever read **its own
project's** aggregated data — no cross-project access, no raw events, no PII (ADR 0003 / ADR 0017).

## Get an API key

The MCP server needs a **query-capable** project API key (`utk_…`) — the same kind the dashboard
uses to read. Self-hosting locally, `pnpm db:seed` mints one and prints it once (also written to
`.env` as `NEXT_PUBLIC_API_KEY` / `VITE_API_KEY`). Ingest-only keys are rejected for reads.

## Run

```bash
UPTIMIZR_COLLECTOR_URL="https://collect.example.com" \
UPTIMIZR_API_KEY="utk_…" \
npx @uptimizr/mcp
```

No build or clone required — `npx` fetches the published package. Set the two environment variables
to point at **your** collector; nothing is sent anywhere else.

| Environment variable     | Required | Notes                                              |
| ------------------------ | -------- | -------------------------------------------------- |
| `UPTIMIZR_COLLECTOR_URL` | yes      | Base URL of **your** collector.                    |
| `UPTIMIZR_API_KEY`       | yes      | Your project API key (`x-api-key`), read-only use. |

## Configure an MCP client

Most MCP clients launch the server over stdio with the same shape — a `command`, `args`, and the two
`env` vars. Point `UPTIMIZR_COLLECTOR_URL` at a local collector (`http://localhost:4318`) for
development or your deployed collector in production.

### Claude Desktop / VS Code / Cursor

```jsonc
{
  "mcpServers": {
    "uptimizr": {
      "command": "npx",
      "args": ["-y", "@uptimizr/mcp"],
      "env": {
        "UPTIMIZR_COLLECTOR_URL": "https://collect.example.com",
        "UPTIMIZR_API_KEY": "utk_…",
      },
    },
  },
}
```

### GitHub Copilot CLI

Add the same server to `~/.copilot/mcp-config.json` (create the file if it doesn't exist), then
restart the CLI so it loads the tools:

```jsonc
{
  "mcpServers": {
    "uptimizr": {
      "type": "local",
      "command": "npx",
      "args": ["-y", "@uptimizr/mcp"],
      "env": {
        "UPTIMIZR_COLLECTOR_URL": "http://localhost:4318",
        "UPTIMIZR_API_KEY": "utk_…",
      },
      "tools": ["*"],
    },
  },
}
```

Once connected, ask in natural language: _"Using uptimizr, what were the most-clicked meshes this
week and how's the average FPS?"_ — the agent picks the right tools and answers from your data.

## Tools

All tools accept an optional time range (`since` / `until`, epoch ms) and the filters the underlying
endpoint supports (`scene`, `session`, `source`, `bins`, `cellSize`, `limit`, …).

| Tool                   | Endpoint                            | Returns                            |
| ---------------------- | ----------------------------------- | ---------------------------------- |
| `list_sessions`        | `/api/v1/sessions`                  | Recent sessions.                   |
| `pointer_heatmap`      | `/api/v1/heatmaps/pointer`          | 2D pointer heatmap bins.           |
| `world_heatmap`        | `/api/v1/heatmaps/world`            | 3D world-space pointer voxels.     |
| `camera_heatmap`       | `/api/v1/heatmaps/camera`           | View-direction (spherical) bins.   |
| `click_rays`           | `/api/v1/heatmaps/click-rays`       | View-gated click rays.             |
| `flow_links`           | `/api/v1/heatmaps/flow`             | Gaze→mesh flow links.              |
| `top_meshes`           | `/api/v1/meshes/top`                | Most-interacted meshes.            |
| `perf_summary`         | `/api/v1/perf`                      | FPS summary (avg/min/p50).         |
| `list_scenes`          | `/api/v1/scenes`                    | Active scenes.                     |
| `timeseries`           | `/api/v1/timeseries`                | Event-volume buckets over time.    |
| `event_counts`         | `/api/v1/event-counts`              | Per-event-type counts.             |
| `session_meta`         | `/api/v1/sessions/:id/meta`         | Coarse session descriptor.         |
| `scene_representation` | `/api/v1/scenes/:id/representation` | Registered proxy geometry, if any. |
| `funnel`               | `/api/v1/funnel`                    | Ordered conversion funnel (ADR 0038); `steps` is a JSON array. |
| `aggregate_paths`      | `/api/v1/paths`                     | Crowd-level desire-line movement routes (ADR 0037). |
| `rendering_technology` | `/api/v1/rendering-technology`      | Rendering-tech mix — WebGPU/WebGL2, shading language (ADR 0046). |
| `xr_rotation`          | `/api/v1/xr/rotation`               | XR head-rotation rate (motion-sickness proxy, ADR 0048). |
| `xr_sources`           | `/api/v1/xr/sources`                | XR input-source usage — hand / controller / gaze (ADR 0048). |
| `xr_abandonment`       | `/api/v1/xr/abandonment`            | XR session abandonment / drop-off (ADR 0048). |
| `xr_locomotion`        | `/api/v1/xr/locomotion`             | XR locomotion & comfort mix (ADR 0048). |

## Resources

The server also exposes read-only [MCP resources](https://modelcontextprotocol.io/docs/concepts/resources)
so an agent can **self-discover** what it can ask instead of guessing:

| Resource URI              | Type               | Contents                                                                                                                                    |
| ------------------------- | ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `uptimizr://capabilities` | `application/json` | A machine-readable descriptor: schema version, the canonical **event types**, the full **tool catalog**, and the **parameter semantics** glossary. Built from the shared catalog + `@uptimizr/schema`, so it never drifts from the tools actually registered. No collector call. |
| `uptimizr://scenes`       | `application/json` | The **live** list of scene ids with recent activity — the valid values for the `scene` parameter. Fetched via the read-only query API.       |

Point an agent at `uptimizr://capabilities` first: it enumerates every tool, its parameters, and
what each parameter means, so the agent can plan a query without trial and error.

## Prompts

Curated [MCP prompts](https://modelcontextprotocol.io/docs/concepts/prompts) package common analyses
as one-click templates. Each renders a message that steers the agent to call the right read-only
tools in a sensible order — the agent runs the tools; the prompt just frames the task.

| Prompt                | Argument   | What it does                                                                                             |
| --------------------- | ---------- | ------------------------------------------------------------------------------------------------------- |
| `weekly_scene_health` | `scene?`   | A 7-day health report: traffic, event mix, FPS, and top meshes (`event_counts`, `timeseries`, `perf_summary`, `top_meshes`, `list_sessions`). |
| `attention_hotspots`  | `scene`    | Where visitors look and click: `camera_heatmap`, `flow_links`, `click_rays`, `top_meshes`.              |
| `xr_comfort_review`   | `scene?`   | VR/AR comfort & drop-off: `xr_rotation`, `xr_locomotion`, `xr_abandonment`, `xr_sources`.               |

## Transport & roadmap

The server speaks **stdio** — the transport MCP clients (Claude Desktop, VS Code, Cursor, Copilot
CLI) launch. A remote **Streamable HTTP** transport (so browser/remote MCP clients could reach a
self-hosted collector) is a tracked follow-up and is only worth adding behind proper auth
([ADR 0050](https://github.com/RaananW/Uptimizr/blob/main/docs/adr/0050-in-browser-analytics-assistant.md) §7).

## Programmatic use

The package also exports its building blocks for embedding in your own server:

```ts
import { createCollectorClient, createMcpServer, readMcpConfig } from "@uptimizr/mcp";
```

The read-only tool catalog and the `GET`-only collector client come from the framework-agnostic
[`@uptimizr/agent-core`](https://www.npmjs.com/package/@uptimizr/agent-core) package (re-exported
here for convenience). If you're building a non-MCP agent — a browser assistant, a Node service, a
CLI, a bot — depend on `@uptimizr/agent-core` directly: it also ships a headless LLM
provider-adapter interface and tool-calling loop over the same catalog.
