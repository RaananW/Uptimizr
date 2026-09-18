/**
 * The fixture-backed collector the eval questions are asked against
 * (ADR 0051 §8, design sketch §H).
 *
 * It boots the **real** collector Fastify app in-process over a real DuckDB
 * store seeded with {@link EVAL_EVENTS}, and hands back a
 * {@link CollectorClient} that speaks to it through Fastify's `inject()`. No
 * socket is opened and no port is bound, so a run never collides with a
 * developer's dev server or a parallel Playwright suite, and the answers an
 * agent is scored on come from the same SQL the dashboard would run — not a
 * mock.
 *
 * The store is `:memory:` DuckDB with a thin auth decorator: project metadata
 * (projects / API keys) is the one thing the parity fixtures do not carry, so
 * `resolveApiKey` / `projectExists` are answered from a per-run random key
 * rather than by writing rows. The key is generated with `@uptimizr/db`'s own
 * generator, lives only in memory for the life of the run, and is never
 * printed or written to the report.
 */

import type { FastifyInstance } from "fastify";
import { generateApiKey } from "@uptimizr/db";
import { buildApp } from "@uptimizr/collector-server/dist/app.js";
import type { CollectorConfig } from "@uptimizr/collector-server/dist/config.js";
import type { CollectorStore } from "@uptimizr/collector-server/dist/store.js";
import { createDuckdbStore } from "@uptimizr/collector-server/dist/duckdbStore.js";
import { CollectorError, type CollectorClient, type QueryParams } from "@uptimizr/agent-core";
import {
  EVAL_EVENTS,
  EVAL_PROJECT_ID,
  EVAL_SCENE_PROXY,
  EVAL_SCENE_PROXY_LABEL,
} from "./fixtures.js";

/**
 * Collector configuration for an eval run: headless, no CORS, raw retention off
 * (the agent surface is aggregate-only, ADR 0003), and rate limits lifted so a
 * 40-case run with several tool calls each is never throttled.
 */
const EVAL_CONFIG: CollectorConfig = {
  host: "127.0.0.1",
  port: 0,
  corsOrigins: [],
  visitorHashSecret: "agent-eval-visitor-salt",
  enableRawSessionRetention: false,
  liveWindowMs: 30_000,
  liveTokenSecret: "agent-eval-live-secret",
  liveTokenSecretIsDedicated: true,
  liveTokenTtlMs: 900_000,
  liveMaxConnections: 1,
  livePresenceIntervalMs: 2_000,
  rateLimitMax: 1_000_000,
  rateLimitWindowMs: 60_000,
  ingestRateLimitMax: 1_000_000,
  ingestRateLimitWindowMs: 60_000,
  trustProxy: false,
  bodyLimit: 1_048_576,
  cspMode: "off",
  // Audit log (#309): keep the default retention and never audit the
  // dashboard's own requests — the harness has no dashboard.
  auditRetentionDays: 30,
  auditDashboardRequests: false,
  mcpHttpEnabled: false,
  mcpMaxSessions: 50,
  mcpSessionTtlMs: 1_800_000,
};

/** A booted, seeded collector plus the read-only client an agent run uses. */
export interface EvalHarness {
  /** Read-only client over the in-process collector (Fastify `inject`). */
  client: CollectorClient;
  /** Shut the Fastify instance down. */
  close(): Promise<void>;
}

/**
 * A {@link CollectorClient} that dispatches through `app.inject()` instead of
 * the network. Mirrors `createCollectorClient`'s contract exactly — same
 * leading-slash handling, same `undefined`-parameter omission, same
 * {@link CollectorError} on a non-2xx — so the agent loop cannot tell the
 * difference between this and a deployed collector.
 */
function injectClient(app: FastifyInstance, apiKey: string): CollectorClient {
  return {
    async get(path: string, params: QueryParams = {}): Promise<unknown> {
      const url = new URL(path.replace(/^\//, ""), "http://collector.invalid/");
      for (const [key, value] of Object.entries(params)) {
        if (value != null) url.searchParams.set(key, String(value));
      }
      const response = await app.inject({
        method: "GET",
        url: `${url.pathname}${url.search}`,
        headers: { "x-api-key": apiKey },
      });
      if (response.statusCode >= 400) {
        throw new CollectorError(response.body || String(response.statusCode), response.statusCode);
      }
      return response.json();
    },
  };
}

/**
 * Seed the fixtures into a fresh in-memory DuckDB store, boot the collector on
 * top of it, and return a read-only client bound to it. Every call gets its own
 * store and its own API key, so runs are independent and order-insensitive.
 */
export async function startHarness(): Promise<EvalHarness> {
  const apiKey = generateApiKey();
  const duckdb = await createDuckdbStore(":memory:");
  const store: CollectorStore = {
    ...duckdb,
    resolveApiKey: async (key: string) =>
      key === apiKey
        ? {
            projectId: EVAL_PROJECT_ID,
            keyId: "eval-key",
            capabilities: ["query"],
            label: "agent-eval",
            rateLimit: null,
          }
        : null,
    projectExists: async (projectId: string) => projectId === EVAL_PROJECT_ID,
  };
  await store.insertEvents(EVAL_EVENTS);
  await store.putSceneProxy(EVAL_PROJECT_ID, EVAL_SCENE_PROXY, EVAL_SCENE_PROXY_LABEL);

  const app = await buildApp({ store, config: EVAL_CONFIG });
  await app.ready();

  return { client: injectClient(app, apiKey), close: () => app.close() };
}
