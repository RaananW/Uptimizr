/**
 * Shared fixtures for the suites that sweep **every** registry endpoint
 * (`queryResponseSchemas.test.ts`, `resultFormat.test.ts`).
 *
 * Both need the same three things: a collector config, a scene proxy so the
 * `scene_representation` resource has something to return, and the rule for
 * turning a registry `endpoint.path` into a request URL. Keeping them here means
 * a new endpoint that needs a required parameter is taught about once.
 *
 * Not a test file — the filename has no `.test.` segment, so Vitest does not
 * collect it.
 */

import type { MetricDefinition } from "@uptimizr/metrics";
import { PARITY_RANGE } from "@uptimizr/db";
import type { CollectorConfig } from "../../config.js";

/** A collector config with every gate open and every secret a test secret. */
export const TEST_CONFIG: CollectorConfig = {
  host: "127.0.0.1",
  port: 0,
  corsOrigins: [],
  visitorHashSecret: "test-secret",
  enableRawSessionRetention: false,
  liveWindowMs: 30_000,
  liveTokenSecret: "test-live-secret",
  liveTokenSecretIsDedicated: true,
  liveTokenTtlMs: 900_000,
  liveMaxConnections: 200,
  livePresenceIntervalMs: 2_000,
  rateLimitMax: 1000,
  rateLimitWindowMs: 60_000,
  ingestRateLimitMax: 1000,
  ingestRateLimitWindowMs: 60_000,
  trustProxy: false,
  bodyLimit: 1_048_576,
  cspMode: "strict",
  auditRetentionDays: 30,
  auditDashboardRequests: false,
  mcpHttpEnabled: false,
  mcpMaxSessions: 50,
  mcpSessionTtlMs: 1_800_000,
};

/** Fixture scene proxy, so the `scene_representation` resource has a hit. */
export const TEST_PROXY = {
  version: 1 as const,
  sceneId: "lobby",
  kind: "aabb" as const,
  bounds: [-2, 0, -2, 2, 3, 2] as [number, number, number, number, number, number],
  upAxis: "y" as const,
  unitScale: 1,
  meshes: [
    {
      name: "floor",
      aabb: [-2, 0, -2, 2, 0.1, 2] as [number, number, number, number, number, number],
    },
  ],
  meshCount: 1,
  contentHash: "abc123",
  capturedAt: 1_750_000_000_000,
};

/** Path params every registry endpoint that declares one can be satisfied with. */
export const PATH_PARAM_VALUES: Readonly<Record<string, string>> = {
  ":sessionId": "s1",
  ":id": "s1",
  ":sceneId": "lobby",
};

/**
 * Query parameters an endpoint needs beyond the shared range. Only the genuinely
 * required ones: `mesh` for the per-mesh UV heatmap and `steps` for the funnel.
 */
export const REQUIRED_QUERY: Readonly<Record<string, Record<string, string>>> = {
  "/api/v1/heatmaps/mesh-uv": { mesh: "box" },
  "/api/v1/funnel": {
    steps: JSON.stringify([{ type: "session_start" }, { type: "pointer_click" }]),
  },
};

/** The two resource reads, which legitimately 404 when nothing is registered. */
export const RESOURCE_METRICS: ReadonlySet<string> = new Set([
  "session_meta",
  "scene_representation",
]);

/**
 * Fill a registry path's `:params` and append the query string for a request.
 * `extra` adds (or overrides) query parameters — `format`, for instance.
 */
export function requestUrl(
  metric: MetricDefinition,
  extra: Readonly<Record<string, string>> = {},
): string {
  let path = metric.endpoint!.path;
  for (const [token, value] of Object.entries(PATH_PARAM_VALUES)) {
    path = path.replace(token, value);
  }
  const params = new URLSearchParams({
    since: String(PARITY_RANGE.since),
    until: String(PARITY_RANGE.until),
    ...(REQUIRED_QUERY[metric.endpoint!.path] ?? {}),
    ...extra,
  });
  return `${path}?${params.toString()}`;
}
