import { resolve } from "node:path";

/**
 * Collector server configuration, read from the environment (see `.env.example`).
 * Fails fast when a required secret is missing.
 */
export interface CollectorConfig {
  host: string;
  port: number;
  /** Allowed CORS origins. Empty disables cross-origin browser access. */
  corsOrigins: string[];
  /** Secret seed for the daily-rotating cookieless visitor hash. */
  visitorHashSecret: string;
  /** Opt-in raw per-session retention; gates the replay/timeline endpoint (ADR 0003). */
  enableRawSessionRetention: boolean;
  /** Liveness window in ms for live presence/follow (ADR 0032 §1). */
  liveWindowMs: number;
  /** Secret for signing short-lived live SSE tokens (ADR 0032 §7). */
  liveTokenSecret: string;
  /**
   * Whether a dedicated `LIVE_TOKEN_SECRET` was supplied. When false the live
   * token secret falls back to {@link visitorHashSecret}; the server warns at
   * startup so production deployments give the two secrets independent values.
   */
  liveTokenSecretIsDedicated: boolean;
  /** Live SSE token lifetime in ms (ADR 0032 §7). */
  liveTokenTtlMs: number;
  /** Max concurrent live SSE connections per collector (ADR 0032 §6). */
  liveMaxConnections: number;
  /** Interval between pushed presence snapshots / SSE heartbeats, in ms. */
  livePresenceIntervalMs: number;
  /** Max requests per window per client for rate limiting. */
  rateLimitMax: number;
  /** Rate-limit window in ms. */
  rateLimitWindowMs: number;
  /** Stricter, dedicated per-client request budget for the public ingest route. */
  ingestRateLimitMax: number;
  /** Ingest rate-limit window in ms. */
  ingestRateLimitWindowMs: number;
  /**
   * Trust `X-Forwarded-*` headers from a reverse proxy / load balancer. Required
   * when the collector runs behind TLS termination so the per-visitor hash and
   * the rate-limit bucket key on the real client IP rather than the proxy's.
   * `false` (default) trusts only the direct socket peer. Accepts `true`/`false`,
   * a hop count, or an IP/subnet/comma-list passed through to Fastify.
   */
  trustProxy: boolean | number | string;
  /** Max accepted request body size in bytes (defends against oversized payloads). */
  bodyLimit: number;
  /** Content-Security-Policy for the bundled dashboard: `strict` (default) or `off`. */
  cspMode: "strict" | "off";
  /**
   * Absolute path to a pre-built static dashboard (`out/`) to serve as an
   * all-in-one bundle. Unset (the default) keeps the collector headless.
   */
  dashboardDir?: string;
}

type Env = Record<string, string | undefined>;

function bool(value: string | undefined): boolean {
  return value === "1" || value?.toLowerCase() === "true";
}

/**
 * Parse `COLLECTOR_TRUST_PROXY` into a value Fastify's `trustProxy` accepts:
 * a boolean, a hop count, or an IP/subnet/comma-separated list passed through
 * verbatim. Empty/unset means do not trust proxy headers.
 */
function parseTrustProxy(value: string | undefined): boolean | number | string {
  if (value == null || value.trim() === "") return false;
  const trimmed = value.trim();
  const lower = trimmed.toLowerCase();
  if (lower === "true") return true;
  if (lower === "false") return false;
  const n = Number(trimmed);
  if (Number.isInteger(n) && String(n) === trimmed) return n;
  return trimmed;
}

export function loadConfig(env: Env = process.env): CollectorConfig {
  const visitorHashSecret = env.VISITOR_HASH_SECRET;
  if (!visitorHashSecret) {
    throw new Error("VISITOR_HASH_SECRET is required but was not set");
  }

  const liveTokenSecretIsDedicated = Boolean(env.LIVE_TOKEN_SECRET);

  return {
    host: env.COLLECTOR_HOST ?? "0.0.0.0",
    port: Number(env.COLLECTOR_PORT ?? 4318),
    corsOrigins: (env.COLLECTOR_CORS_ORIGINS ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
    visitorHashSecret,
    enableRawSessionRetention: bool(env.ENABLE_RAW_SESSION_RETENTION),
    liveWindowMs: Number(env.LIVE_WINDOW_MS ?? 30_000),
    liveTokenSecret: env.LIVE_TOKEN_SECRET ?? visitorHashSecret,
    liveTokenSecretIsDedicated,
    liveTokenTtlMs: Number(env.LIVE_TOKEN_TTL_MS ?? 900_000),
    liveMaxConnections: Number(env.LIVE_MAX_CONNECTIONS ?? 200),
    livePresenceIntervalMs: Number(env.LIVE_PRESENCE_INTERVAL_MS ?? 2_000),
    rateLimitMax: Number(env.COLLECTOR_RATE_LIMIT_MAX ?? 600),
    rateLimitWindowMs: Number(env.COLLECTOR_RATE_LIMIT_WINDOW_MS ?? 60_000),
    ingestRateLimitMax: Number(env.COLLECTOR_INGEST_RATE_LIMIT_MAX ?? 300),
    ingestRateLimitWindowMs: Number(env.COLLECTOR_INGEST_RATE_LIMIT_WINDOW_MS ?? 60_000),
    trustProxy: parseTrustProxy(env.COLLECTOR_TRUST_PROXY),
    bodyLimit: Number(env.COLLECTOR_BODY_LIMIT ?? 1_048_576),
    cspMode: env.COLLECTOR_CSP === "off" ? "off" : "strict",
    dashboardDir: env.COLLECTOR_DASHBOARD_DIR ? resolve(env.COLLECTOR_DASHBOARD_DIR) : undefined,
  };
}
