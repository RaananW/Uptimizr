# @uptimizr/mcp

A **read-only** [Model Context Protocol](https://modelcontextprotocol.io) server over an
Uptimizr collector's query API. It lets an AI agent ask natural-language questions about your
3D analytics ("what was the most-clicked mesh this week?") and have them answered by querying
**your own** collector — nothing is sent to any third party.

The server is a thin wrapper: each tool maps one-to-one to a documented collector query endpoint
(see [integration docs](https://github.com/RaananW/Uptimizr/blob/main/docs/integration.md)). It
performs `GET` requests only — there are **no ingestion, mutation, or raw per-session event
tools**.

## How it connects

The server talks **only to your collector's HTTP query API** — it never opens the database
(DuckDB/ClickHouse/Postgres) directly. The collector stays the single gateway to your data, so an
agent gets exactly the auth, project-scoping, and privacy guarantees a dashboard user does:

```text
AI agent ──stdio──▶ @uptimizr/mcp ──HTTPS GET + x-api-key──▶ collector ──▶ store
```

## Run

```bash
UPTIMIZR_COLLECTOR_URL="https://collect.example.com" \
UPTIMIZR_API_KEY="utk_…" \
npx @uptimizr/mcp
```

| Environment variable     | Required | Notes                                              |
| ------------------------ | -------- | -------------------------------------------------- |
| `UPTIMIZR_COLLECTOR_URL` | yes      | Base URL of **your** collector.                    |
| `UPTIMIZR_API_KEY`       | yes      | Your project API key (`x-api-key`), read-only use. |

### Configure an MCP client

Most MCP clients (Claude Desktop, VS Code, etc.) launch the server over stdio. Example client
config:

```json
{
  "mcpServers": {
    "uptimizr": {
      "command": "npx",
      "args": ["-y", "@uptimizr/mcp"],
      "env": {
        "UPTIMIZR_COLLECTOR_URL": "https://collect.example.com",
        "UPTIMIZR_API_KEY": "utk_…"
      }
    }
  }
}
```

For **GitHub Copilot CLI**, put the same entry in `~/.copilot/mcp-config.json` with
`"type": "local"` and `"tools": ["*"]`, then restart the CLI so it loads the tools:

```json
{
  "mcpServers": {
    "uptimizr": {
      "type": "local",
      "command": "npx",
      "args": ["-y", "@uptimizr/mcp"],
      "env": {
        "UPTIMIZR_COLLECTOR_URL": "http://localhost:4318",
        "UPTIMIZR_API_KEY": "utk_…"
      },
      "tools": ["*"]
    }
  }
}
```

## Tools

Most aggregate tools accept an optional time range (`since` / `until`, epoch ms) and the filters
the underlying endpoint supports (`scene`, `session`, `source`, `bins`, `cellSize`, `interval`,
`type`, `limit`, …). `session_meta` and `scene_representation` take their required IDs only.

| Tool                   | Endpoint                            | Returns                                          |
| ---------------------- | ----------------------------------- | ------------------------------------------------ |
| `list_sessions`        | `/api/v1/sessions`                  | Recent sessions.                                 |
| `pointer_heatmap`      | `/api/v1/heatmaps/pointer`          | 2D pointer heatmap bins.                         |
| `world_heatmap`        | `/api/v1/heatmaps/world`            | 3D world-space pointer voxels.                   |
| `camera_heatmap`       | `/api/v1/heatmaps/camera`           | View-direction (spherical) bins.                 |
| `click_rays`           | `/api/v1/heatmaps/click-rays`       | View-gated click rays.                           |
| `flow_links`           | `/api/v1/heatmaps/flow`             | Gaze→mesh flow links.                            |
| `top_meshes`           | `/api/v1/meshes/top`                | Most-interacted meshes.                          |
| `perf_summary`         | `/api/v1/perf`                      | FPS summary (avg/min/p50).                       |
| `list_scenes`          | `/api/v1/scenes`                    | Active scenes.                                   |
| `timeseries`           | `/api/v1/timeseries`                | Event-volume buckets over time.                  |
| `event_counts`         | `/api/v1/event-counts`              | Per-event-type counts.                           |
| `session_meta`         | `/api/v1/sessions/:id/meta`         | Coarse session descriptor (no raw event stream). |
| `scene_representation` | `/api/v1/scenes/:id/representation` | Registered proxy geometry, if any.               |
| `funnel`               | `/api/v1/funnel`                    | Ordered conversion funnel (`steps` JSON, ADR 0038). |
| `aggregate_paths`      | `/api/v1/paths`                     | Crowd-level desire-line routes (ADR 0037).       |
| `rendering_technology` | `/api/v1/rendering-technology`      | WebGPU/WebGL2 + shading-language mix (ADR 0046).  |
| `xr_rotation`          | `/api/v1/xr/rotation`               | XR head-rotation rate (ADR 0048).                |
| `xr_sources`           | `/api/v1/xr/sources`                | XR input-source usage (ADR 0048).                |
| `xr_abandonment`       | `/api/v1/xr/abandonment`            | XR session abandonment (ADR 0048).               |
| `xr_locomotion`        | `/api/v1/xr/locomotion`             | XR locomotion & comfort (ADR 0048).              |

## Resources & prompts

The server also exposes read-only **resources** for self-discovery — `uptimizr://capabilities`
(a machine-readable descriptor of event types, the tool catalog, and parameter semantics) and
`uptimizr://scenes` (live scene ids) — and curated **prompts** (`weekly_scene_health`,
`attention_hotspots`, `xr_comfort_review`) that drive the tools above. A remote Streamable HTTP
transport is a deferred, auth-gated follow-up (ADR 0050 §7). See the
[MCP guide](https://uptimizr.com/docs/guides/mcp/) for details.

## Programmatic use

```ts
import { createCollectorClient, createMcpServer, readMcpConfig } from "@uptimizr/mcp";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

const client = createCollectorClient(readMcpConfig());
const server = createMcpServer(client);
await server.connect(new StdioServerTransport());
```

The package also exports `readTools`, `CollectorError`, `version`, and the related public types.
The read-only tool catalog (`readTools`) and the `GET`-only collector client are defined in the
framework-agnostic [`@uptimizr/agent-core`](../agent-core/README.md) package and re-exported here,
so the agent tool surface is defined once and shared across the MCP server, the dashboard assistant,
and the demo assistant (ADR 0050). Building a non-MCP agent? Depend on `@uptimizr/agent-core`
directly — it also ships a headless provider-adapter interface and tool-calling loop.

## Develop

```bash
pnpm --filter @uptimizr/mcp build
pnpm --filter @uptimizr/mcp typecheck
pnpm --filter @uptimizr/mcp test
```

Licensed under [Apache-2.0](./LICENSE).
