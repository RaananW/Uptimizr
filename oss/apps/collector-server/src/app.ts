import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import rateLimit, { normalizeIP } from "@fastify/rate-limit";
import fastifyStatic from "@fastify/static";
import Fastify, { type FastifyInstance } from "fastify";
import {
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from "fastify-type-provider-zod";
import type { CollectorConfig } from "./config.js";
import type { CollectorStore } from "./store.js";
import { createLiveBus, type LiveBus } from "./liveBus.js";
import { attachApiKey } from "./auth.js";
import { registerAuditHooks, startAuditRetention } from "./audit.js";
import { buildDashboardCsp } from "./csp.js";
import { collectRoutes } from "./routes/collect.js";
import { liveRoutes } from "./routes/live.js";
import { collectRouteSchemas, metaRoutes } from "./routes/meta.js";
import { queryRoutes } from "./routes/query.js";
import { queryDslRoutes } from "./routes/query-dsl.js";

export interface BuildAppDeps {
  store: CollectorStore;
  config: CollectorConfig;
  /**
   * In-process live event bus (ADR 0032). Injectable for tests; a default
   * in-process bus is created from `config.liveWindowMs` when omitted.
   */
  liveBus?: LiveBus;
  /** Pass `true` (or Fastify logger options) to enable request logging. */
  logger?: boolean;
}

/**
 * Strip the live-SSE `?token=` from a logged URL. The token is a short-lived
 * bearer credential; it must never land in access logs (or proxy logs).
 */
function redactToken(url: string): string {
  return url.replace(/([?&]token=)[^&]*/gi, "$1[redacted]");
}

/**
 * Request logger options that (a) never log the raw client IP / remote address
 * (privacy model — ADR 0003) and (b) redact the live-SSE token from URLs. Used
 * when `logger: true`; explicit logger options are passed through untouched.
 */
function loggerOptions(logger: boolean | undefined): boolean | Record<string, unknown> {
  if (logger !== true) return logger ?? false;
  return {
    serializers: {
      req(request: { method: string; url: string }) {
        return { method: request.method, url: redactToken(request.url) };
      },
    },
  };
}

/**
 * Build the collector Fastify instance. Pure factory — takes its dependencies so
 * it can be exercised with `app.inject()` and a fake store in tests, and so the
 * store/DB stays swappable.
 */
export async function buildApp(deps: BuildAppDeps): Promise<FastifyInstance> {
  const { store, config } = deps;
  const liveBus = deps.liveBus ?? createLiveBus({ windowMs: config.liveWindowMs });
  const app = Fastify({
    logger: loggerOptions(deps.logger),
    // Honor `X-Forwarded-*` only when explicitly configured, so the visitor hash
    // and rate-limit bucket key on the real client IP behind a TLS proxy.
    trustProxy: config.trustProxy,
    // Cap request bodies; ingestion batches are small JSON documents.
    bodyLimit: config.bodyLimit,
  }).withTypeProvider<ZodTypeProvider>();

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  // When serving the bundled static dashboard, apply a Content-Security-Policy
  // tuned for a Next.js static export: inline bootstrap scripts are pinned by
  // SHA-256 hash (a static export cannot mint per-request nonces), and the rest
  // is locked down. `COLLECTOR_CSP=off` reverts to no policy as an escape hatch.
  const contentSecurityPolicy =
    config.dashboardDir && config.cspMode === "strict"
      ? buildDashboardCsp(config.dashboardDir, config.corsOrigins)
      : false;
  await app.register(helmet, config.dashboardDir ? { contentSecurityPolicy } : {});
  await app.register(cors, {
    origin: config.corsOrigins.length > 0 ? config.corsOrigins : false,
    // @fastify/cors defaults `methods` to GET,HEAD,POST — which omits PUT and so
    // breaks the browser preflight for scene-proxy registration
    // (PUT /api/v1/scenes/:id/representation). List the verbs the HTTP API uses.
    methods: ["GET", "HEAD", "POST", "PUT"],
    // The SDK ingests via `navigator.sendBeacon`, which always sends in
    // credentials mode `include`. With a non-safelisted `application/json` body
    // that triggers a credentialed CORS preflight, so the response must echo
    // `Access-Control-Allow-Credentials: true` or the browser drops the beacon —
    // breaking cross-origin ingestion (the common self-host layout: app and
    // collector on different origins). Safe here because `origin` is an explicit
    // allow-list, never `*`. Anonymous ingestion needs no cookies; this only
    // satisfies the preflight that sendBeacon forces.
    credentials: true,
  });
  // Resolve `x-api-key` once, before the rate limiter runs, so (a) a key with
  // its own budget is throttled per key rather than per client IP and (b) the
  // handlers and the audit hook reuse one metadata lookup per request (#309).
  // Instance-level `onRequest` hooks run before the route-level hook the
  // rate-limit plugin installs, so registration order here is load-bearing.
  app.decorateRequest("resolvedKey", null);
  app.decorateRequest("auditRowCount", null);
  app.decorateRequest("auditParams", null);
  app.addHook("onRequest", async (request) => {
    await attachApiKey(request, store);
  });

  await app.register(rateLimit, {
    // A key carrying its own `rate_limit_max` / `rate_limit_window_ms` is
    // bucketed on the key id with those values; everything else (including
    // keyless ingest) keeps the global per-client-IP budget.
    max: (request) => request.resolvedKey?.rateLimit?.max ?? config.rateLimitMax,
    timeWindow: (request) => request.resolvedKey?.rateLimit?.windowMs ?? config.rateLimitWindowMs,
    // `normalizeIP` is exactly what the plugin's own default key generator uses,
    // so requests without a per-key budget keep their existing IPv6-aware bucket.
    keyGenerator: (request) =>
      request.resolvedKey?.rateLimit ? `key:${request.resolvedKey.keyId}` : normalizeIP(request.ip),
  });

  // Audit every authenticated, non-dashboard request (ADR 0051 §7). Registered
  // after the rate limiter so a throttled request is still recorded.
  registerAuditHooks(app, store, config);
  const stopAuditRetention = startAuditRetention(app, store, config);
  app.addHook("onClose", async () => stopAuditRetention());

  // Record every route's Zod schemas as they are registered, so the generated
  // OpenAPI document describes each parameter with the *same* schema that
  // validates the request (ADR 0051 §1). The hook must be installed before the
  // route plugins below; the array it fills is complete once `app.ready()` has
  // resolved, which is always before `metaRoutes` serves its first request.
  const routeSchemas = collectRouteSchemas(app);

  app.get("/health", async () => ({ status: "ok" }));

  await app.register(collectRoutes, { store, config, liveBus });
  await app.register(liveRoutes, { store, config, liveBus });
  await app.register(queryRoutes, { store, config });
  // The query DSL (ADR 0051 §3): one route that can run any registry metric.
  await app.register(queryDslRoutes, { store });
  await app.register(metaRoutes, { routeSchemas });

  // All-in-one: serve a pre-built static dashboard from `dashboardDir`. The API
  // routes above (`/health`, `/api/v1/*`) are matched first; everything else
  // falls through to the static files. Unmatched GET navigations (the SPA deep
  // links `/projects/:id`...) are served `index.html` so refresh/shared links
  // resolve client-side.
  if (config.dashboardDir) {
    await app.register(fastifyStatic, {
      root: config.dashboardDir,
      prefix: "/",
      wildcard: false,
    });
    app.setNotFoundHandler((req, reply) => {
      if (req.method === "GET" && !req.url.startsWith("/api/v1/") && req.url !== "/health") {
        return reply.type("text/html").sendFile("index.html");
      }
      return reply.code(404).send({ error: "Not Found" });
    });
  }

  return app;
}
