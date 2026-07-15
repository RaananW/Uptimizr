import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CollectorClient } from "@uptimizr/agent-core";
import { buildCapabilities } from "./capabilities.js";

/** URI of the static, machine-readable capabilities/schema descriptor. */
export const CAPABILITIES_URI = "uptimizr://capabilities";
/** URI of the live list of scenes with recent activity. */
export const SCENES_URI = "uptimizr://scenes";

/**
 * Register read-only MCP resources so an agent can **self-discover** the surface
 * (ADR 0050 §7):
 *
 * - `uptimizr://capabilities` — a static descriptor (event types, tool catalog,
 *   parameter semantics) built from the shared catalog + `@uptimizr/schema`. No
 *   collector call; it documents *what can be asked*.
 * - `uptimizr://scenes` — the live set of scene ids with activity, fetched via
 *   the read-only collector client, so the `scene` parameter can be filled in
 *   with real values.
 *
 * Both are read-only; resources never mutate or expose raw per-session events.
 */
export function registerResources(server: McpServer, client: CollectorClient): void {
  server.registerResource(
    "capabilities",
    CAPABILITIES_URI,
    {
      title: "Uptimizr capabilities",
      description:
        "Machine-readable descriptor of the read-only analytics surface: event types, the tool " +
        "catalog, and parameter semantics. Read this first to learn what you can ask.",
      mimeType: "application/json",
    },
    async (uri) => ({
      contents: [
        {
          uri: uri.href,
          mimeType: "application/json",
          text: JSON.stringify(buildCapabilities(), null, 2),
        },
      ],
    }),
  );

  server.registerResource(
    "scenes",
    SCENES_URI,
    {
      title: "Active scenes",
      description:
        "Live list of developer-assigned scene ids with recent activity — the valid values for " +
        "the `scene` parameter across the tools.",
      mimeType: "application/json",
    },
    async (uri) => {
      const data = await client.get("api/v1/scenes", {});
      return {
        contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify(data) }],
      };
    },
  );
}
