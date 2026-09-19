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
import { generateApiKey, type ApiKeyCapability } from "@uptimizr/db";
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
  EVAL_SCENE_REGIONS,
  EVAL_SCENES,
} from "./fixtures.js";

/**
 * Collector configuration for an eval run: headless, no CORS, and rate limits
 * lifted so a 40-case run with several tool calls each is never throttled.
 *
 * Raw-session retention is **on** so the `query:raw` half of the gate can be
 * exercised (ADR 0051 §7). That is not a widening of the agent surface: the
 * default key the harness hands out still holds `query` alone, so every
 * ordinary case sees exactly the aggregate-only collector it saw before, and a
 * case that asks for a narrative must opt in to {@link EvalHarness.rawClient}.
 */
const EVAL_CONFIG: CollectorConfig = {
  host: "127.0.0.1",
  port: 0,
  corsOrigins: [],
  visitorHashSecret: "agent-eval-visitor-salt",
  enableRawSessionRetention: true,
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

/** How to start a harness. */
export interface StartHarnessOptions {
  /**
   * Capabilities the run's key resolves with. Defaults to `["query"]` — the
   * read-only key every scored question uses. The metadata cases of #310 pass
   * `["query", "annotate"]` (and, for the refusal case, deliberately do not) so
   * both sides of the capability gate are exercised against the real collector.
   */
  capabilities?: readonly ApiKeyCapability[];
}

/** A booted, seeded collector plus the clients an agent run uses. */
export interface EvalHarness {
  /**
   * Client over the in-process collector (Fastify `inject`), bound to a key
   * holding {@link StartHarnessOptions.capabilities} — `query` by default, the
   * ordinary aggregate surface.
   */
  client: CollectorClient;
  /**
   * The same collector through a key holding `query,query:raw`. Only a case
   * that needs a raw-gated tool should use it; everything else is scored against
   * the aggregate-only surface, which is the one a project owner hands out by
   * default (ADR 0003).
   */
  rawClient: CollectorClient;
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
  /** Dispatch one request, applying the real client's error and parse rules. */
  const send = async (
    method: "GET" | "POST" | "PUT" | "DELETE",
    url: string,
    body?: unknown,
  ): Promise<unknown> => {
    const response = await app.inject({
      method,
      url,
      headers: { "x-api-key": apiKey },
      ...(body === undefined ? {} : { payload: body as object }),
    });
    if (response.statusCode >= 400) {
      throw new CollectorError(response.body || String(response.statusCode), response.statusCode);
    }
    // A successful delete answers 204, which has no body to parse.
    return response.statusCode === 204 ? null : response.json();
  };

  const resolve = (path: string, params: QueryParams = {}): string => {
    const url = new URL(path.replace(/^\//, ""), "http://collector.invalid/");
    for (const [key, value] of Object.entries(params)) {
      if (value != null) url.searchParams.set(key, String(value));
    }
    return `${url.pathname}${url.search}`;
  };

  return {
    get: (path, params = {}) => send("GET", resolve(path, params)),
    // The write methods let the metadata tools of #310 be scored against the
    // same fixture-backed collector the read tools are. Whether a write is
    // *allowed* remains the collector's decision, from the key's capabilities.
    post: (path, body) => send("POST", resolve(path), body),
    put: (path, body) => send("PUT", resolve(path), body),
    delete: (path) => send("DELETE", resolve(path)),
  };
}

/**
 * Seed the fixtures into a fresh in-memory DuckDB store, boot the collector on
 * top of it, and return a read-only client bound to it. Every call gets its own
 * store and its own API key, so runs are independent and order-insensitive.
 */
export async function startHarness(options: StartHarnessOptions = {}): Promise<EvalHarness> {
  const capabilities = options.capabilities ?? (["query"] as const);
  const apiKey = generateApiKey();
  const rawApiKey = generateApiKey();
  const duckdb = await createDuckdbStore(":memory:");
  const store: CollectorStore = {
    ...duckdb,
    resolveApiKey: async (key: string) => {
      if (key === apiKey) {
        return {
          projectId: EVAL_PROJECT_ID,
          keyId: "eval-key",
          capabilities: [...capabilities],
          label: "agent-eval",
          rateLimit: null,
        };
      }
      if (key === rawApiKey) {
        return {
          projectId: EVAL_PROJECT_ID,
          keyId: "eval-raw-key",
          capabilities: ["query", "query:raw"],
          label: "agent-eval-raw",
          rateLimit: null,
        };
      }
      return null;
    },
    projectExists: async (projectId: string) => projectId === EVAL_PROJECT_ID,
  };
  await store.insertEvents(EVAL_EVENTS);
  await store.putSceneProxy(EVAL_PROJECT_ID, EVAL_SCENE_PROXY, EVAL_SCENE_PROXY_LABEL);
  // Named regions (ADR 0051 §2) so spatial answers can be graded on the words a
  // developer uses for places, not only on voxel coordinates.
  await store.putSceneRegions(EVAL_PROJECT_ID, EVAL_SCENES.lobby, EVAL_SCENE_REGIONS);

  const app = await buildApp({ store, config: EVAL_CONFIG });
  await app.ready();

  return {
    client: injectClient(app, apiKey),
    rawClient: injectClient(app, rawApiKey),
    close: () => app.close(),
  };
}
