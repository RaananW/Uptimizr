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
   * `false` (default) trusts only the direct socket peer. Accepts `true`/`false`
   * or an IP/subnet/comma-list passed through to Fastify. Hop counts are not
   * accepted — see `parseTrustProxy`.
   */
  trustProxy: boolean | string;
  /** Max accepted request body size in bytes (defends against oversized payloads). */
  bodyLimit: number;
  /** Content-Security-Policy for the bundled dashboard: `strict` (default) or `off`. */
  cspMode: "strict" | "off";
  /**
   * How long agent-audit rows are kept, in days (ADR 0051 §7). A periodic,
   * idempotent delete drops anything older. `0` disables the sweep and keeps
   * rows indefinitely.
   */
  auditRetentionDays: number;
  /**
   * Also audit the dashboard's own requests. Off by default: the dashboard
   * identifies itself with `x-uptimizr-client: dashboard` and its panel queries
   * would otherwise drown the log the feature exists to make readable. Turn it
   * on to audit every authenticated request without exception.
   */
  auditDashboardRequests: boolean;
  /**
   * Run the conditional-subscription scheduler (#311, ADR 0051 §6). **On by
   * default**, and free until a project actually has an enabled subscription:
   * the scheduler's whole startup cost is one store read, and it schedules
   * nothing when that read comes back empty. Set `COLLECTOR_SUBSCRIPTIONS=0` to
   * keep the API (create, list, test) while running no timers at all — the right
   * setting when several collector instances share one database and only one of
   * them should evaluate.
   */
  subscriptions: boolean;
  /**
   * How many subscription evaluations may run at once (default 4). Each is one
   * grouped store read, so this is the knob that keeps a hundred standing
   * subscriptions from behaving like a hundred concurrent dashboard users.
   */
  subscriptionsMaxConcurrent: number;
  /**
   * Hosts a subscription webhook may POST to (`COLLECTOR_WEBHOOK_ALLOWED_HOSTS`,
   * comma-separated; `*` allows any host).
   *
   * **Empty by default, which disables webhook egress entirely.** A subscription
   * is created over HTTP by an `annotate`-capable key, so its URL is
   * request-controlled input to an outbound request — the scheme check in
   * `parseWebhookUrl` is not on its own an SSRF boundary. Naming the hosts is
   * the operator's explicit consent to reach them; until then a firing is still
   * recorded and fanned out over SSE, and nothing leaves the process.
   */
  webhookAllowedHosts: string[];
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
 * a boolean, or an IP/subnet/comma-separated list passed through verbatim.
 * Empty/unset means do not trust proxy headers.
 *
 * A bare hop count (`COLLECTOR_TRUST_PROXY=1`) used to be accepted, but Fastify
 * 5.12.1 disabled numeric hop-count trust: it cannot validate the immediate peer,
 * so a direct client could spoof `X-Forwarded-*` by supplying enough hops.
 * Fastify now fails closed on a number and silently ignores the headers — which
 * would quietly bucket the visitor hash and rate limit on the proxy's IP. Reject
 * it here instead, so a stale deployment fails loudly at startup rather than
 * degrading in production.
 */
function parseTrustProxy(value: string | undefined): boolean | string {
  if (value == null || value.trim() === "") return false;
  const trimmed = value.trim();
  const lower = trimmed.toLowerCase();
  if (lower === "true") return true;
  if (lower === "false") return false;
  const n = Number(trimmed);
  if (Number.isInteger(n) && String(n) === trimmed) {
    throw new Error(
      `COLLECTOR_TRUST_PROXY no longer accepts a hop count (got "${trimmed}"). ` +
        "Fastify disabled numeric hop-count trust because it cannot validate the " +
        "immediate peer. Set the trusted proxy IP/CIDR (or a comma-separated list) " +
        "instead, or `true` when the collector is not directly reachable.",
    );
  }
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
    auditRetentionDays: Math.max(0, Number(env.AUDIT_RETENTION_DAYS ?? 30) || 0),
    auditDashboardRequests: bool(env.AUDIT_DASHBOARD_REQUESTS),
    // Default on: an operator who never creates a subscription pays one store
    // read at boot, and `0`/`false` turns the scheduler off without touching the
    // API surface.
    subscriptions: env.COLLECTOR_SUBSCRIPTIONS == null ? true : bool(env.COLLECTOR_SUBSCRIPTIONS),
    subscriptionsMaxConcurrent: Math.max(
      1,
      Number(env.COLLECTOR_SUBSCRIPTIONS_MAX_CONCURRENT ?? 4) || 4,
    ),
    webhookAllowedHosts: (env.COLLECTOR_WEBHOOK_ALLOWED_HOSTS ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
    dashboardDir: env.COLLECTOR_DASHBOARD_DIR ? resolve(env.COLLECTOR_DASHBOARD_DIR) : undefined,
  };
}
