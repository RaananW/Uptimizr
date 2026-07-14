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

## Programmatic use

The package also exports its building blocks for embedding in your own server:

```ts
import { createCollectorClient, createMcpServer, readMcpConfig } from "@uptimizr/mcp";
```
