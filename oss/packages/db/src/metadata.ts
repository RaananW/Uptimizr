/**
 * Engine-neutral metadata helpers and types (ADR 0020).
 *
 * API-key hashing/generation are pure crypto and the project / API-key / scene
 * representation shapes are storage-independent. Both the OSS DuckDB store and
 * the scale-tier Postgres metadata clients reuse these, so the type contracts live
 * once and OSS carries no Postgres dependency.
 */

import { createHash, randomBytes } from "node:crypto";
import type {
  Aabb,
  Annotation,
  AnnotationTargetKind,
  GlossaryEntry,
  MetadataAuthorKind,
  SavedAnalysis,
  SavedAnalysisQuery,
  SceneProxy,
} from "@uptimizr/schema";
import { LIMITS } from "@uptimizr/schema";

// --- API keys (pure crypto) ---

/** SHA-256 hash of an API key. Only the hash is ever stored (never plaintext). */
export function hashApiKey(plaintext: string): string {
  return createHash("sha256").update(plaintext).digest("hex");
}

/** Display prefix used to identify a key without revealing it. */
export function apiKeyPrefix(plaintext: string): string {
  return plaintext.slice(0, 12);
}

/** Generate a new opaque API key (`utk_` + 32 random bytes, base64url). */
export function generateApiKey(): string {
  return `utk_${randomBytes(32).toString("base64url")}`;
}

// --- Project / API-key records ---

export interface Project {
  id: string;
  name: string;
  /** Owning organization (scale tier). `null` for single-tenant/OSS projects. */
  orgId: string | null;
  createdAt: Date;
}

/**
 * What a project API key is allowed to do (ADR 0051 §7). A key carries a **set**
 * of these:
 *
 * - `query` — read the aggregate analytics API (the default; public ingestion is
 *   keyless, so issued keys are for reads).
 * - `ingest` — reserved for server-side write paths.
 * - `annotate` — write project **metadata** (annotations, glossary, saved
 *   analyses, panel specs). Never events: events stay append-only and read-only.
 * - `query:raw` — read raw per-session streams (the replay timeline and the live
 *   per-session follow). Honoured **only** when `ENABLE_RAW_SESSION_RETENTION` is
 *   on (ADR 0003); never granted by a plain `query` key.
 */
export type ApiKeyCapability = "ingest" | "query" | "annotate" | "query:raw";

/** Every capability token, in canonical order. */
export const API_KEY_CAPABILITIES: readonly ApiKeyCapability[] = [
  "ingest",
  "query",
  "annotate",
  "query:raw",
] as const;

/** The capability a key gets when none is requested (reads only). */
export const DEFAULT_API_KEY_CAPABILITIES: readonly ApiKeyCapability[] = ["query"] as const;

/** Whether `value` is a known capability token. */
export function isApiKeyCapability(value: string): value is ApiKeyCapability {
  return (API_KEY_CAPABILITIES as readonly string[]).includes(value);
}

/**
 * Per-key request budget. `null` on a key means "use the collector's global
 * `COLLECTOR_RATE_LIMIT_*` defaults".
 */
export interface ApiKeyRateLimit {
  /** Max requests per {@link windowMs}. */
  max: number;
  /** Window length in milliseconds. */
  windowMs: number;
}

/**
 * Parse the stored capability set. Capabilities are persisted as a canonical
 * comma-separated token list (`"query,annotate"`) in a plain text column, which
 * every engine — including ClickHouse and SQL Server — stores and compares
 * natively without a JSON type.
 *
 * Both arguments are tolerated as `null`/empty so the same function serves the
 * migration-backfill path and the read path:
 *
 * 1. a populated `capabilities` column wins;
 * 2. otherwise the legacy singular `capability` column is promoted to a
 *    one-element set (keys issued before the capability set shipped);
 * 3. otherwise the default (`["query"]`).
 *
 * Unknown tokens are dropped rather than throwing — an older collector must not
 * crash on a key minted by a newer one — and the result is deduplicated and
 * ordered canonically so comparisons and `whoami` output are stable.
 */
export function parseApiKeyCapabilities(
  capabilities: string | null | undefined,
  legacyCapability?: string | null,
): ApiKeyCapability[] {
  const raw = capabilities?.trim() ? capabilities : (legacyCapability ?? "");
  const tokens = raw
    .split(",")
    .map((t) => t.trim())
    .filter(isApiKeyCapability);
  const unique = API_KEY_CAPABILITIES.filter((c) => tokens.includes(c));
  return unique.length > 0 ? unique : [...DEFAULT_API_KEY_CAPABILITIES];
}

/**
 * Render a capability set for storage: deduplicated, canonically ordered, and
 * comma-separated. Throws on an unknown token so a bad CLI argument fails at the
 * boundary instead of silently minting a key with no capabilities.
 */
export function serializeApiKeyCapabilities(
  capabilities: readonly ApiKeyCapability[] | undefined,
): string {
  const requested = capabilities?.length ? capabilities : DEFAULT_API_KEY_CAPABILITIES;
  for (const cap of requested) {
    if (!isApiKeyCapability(cap)) {
      throw new Error(
        `Unknown API key capability ${JSON.stringify(cap)}. ` +
          `Expected one of: ${API_KEY_CAPABILITIES.join(", ")}.`,
      );
    }
  }
  return API_KEY_CAPABILITIES.filter((c) => requested.includes(c)).join(",");
}

/**
 * Parse a user-supplied capability list (`"query,annotate"`) into a validated
 * set. Used by the CLI; throws with an actionable message on an unknown token.
 */
export function parseCapabilityList(input: string): ApiKeyCapability[] {
  const tokens = input
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean);
  if (tokens.length === 0) return [...DEFAULT_API_KEY_CAPABILITIES];
  for (const token of tokens) {
    if (!isApiKeyCapability(token)) {
      throw new Error(
        `Unknown API key capability ${JSON.stringify(token)}. ` +
          `Expected a comma-separated list of: ${API_KEY_CAPABILITIES.join(", ")}.`,
      );
    }
  }
  return API_KEY_CAPABILITIES.filter((c) => (tokens as string[]).includes(c));
}

/** Whether a resolved key holds `capability`. */
export function hasCapability(
  key: { capabilities: readonly ApiKeyCapability[] },
  capability: ApiKeyCapability,
): boolean {
  return key.capabilities.includes(capability);
}

export interface ApiKeyRecord {
  id: string;
  projectId: string;
  keyPrefix: string;
  createdAt: Date;
  revokedAt: Date | null;
  /** What this key is allowed to do. Defaults to `["query"]`. */
  capabilities: ApiKeyCapability[];
  /** Operator-supplied name for the key (e.g. `"weekly-report-agent"`). */
  label: string | null;
  /** Per-key request budget; `null` falls back to the collector defaults. */
  rateLimit: ApiKeyRateLimit | null;
}

/**
 * The result of resolving a plaintext API key: the project it authenticates, the
 * key's own id (the audit-log subject), the capability set that scopes what it
 * may do at the request boundary, and its optional per-key rate limit.
 */
export interface ResolvedApiKey {
  projectId: string;
  /** Stable id of the key row — the audit-log subject. Never the key itself. */
  keyId: string;
  capabilities: ApiKeyCapability[];
  /** Operator-supplied name, when one was given. */
  label: string | null;
  /** Per-key request budget; `null` falls back to the collector defaults. */
  rateLimit: ApiKeyRateLimit | null;
}

/** Options accepted when minting a key. */
export interface CreateApiKeyOptions {
  /** Capability set. Defaults to `["query"]`. */
  capabilities?: readonly ApiKeyCapability[];
  /** Operator-supplied name for the key. */
  label?: string | null;
  /** Per-key request budget; omit to use the collector defaults. */
  rateLimit?: ApiKeyRateLimit | null;
}

/**
 * Normalize {@link CreateApiKeyOptions} into the column values every store
 * writes, so the four engines agree on defaults and validation.
 */
export function toApiKeyColumns(options: CreateApiKeyOptions = {}): {
  capabilities: string;
  label: string | null;
  rateLimitMax: number | null;
  rateLimitWindowMs: number | null;
} {
  const rateLimit = options.rateLimit ?? null;
  if (rateLimit && (!Number.isFinite(rateLimit.max) || !Number.isFinite(rateLimit.windowMs))) {
    throw new Error("API key rate limit requires finite `max` and `windowMs` values");
  }
  if (rateLimit && (rateLimit.max <= 0 || rateLimit.windowMs <= 0)) {
    throw new Error("API key rate limit requires positive `max` and `windowMs` values");
  }
  return {
    capabilities: serializeApiKeyCapabilities(options.capabilities),
    label: options.label?.trim() ? options.label.trim().slice(0, 200) : null,
    rateLimitMax: rateLimit ? Math.trunc(rateLimit.max) : null,
    rateLimitWindowMs: rateLimit ? Math.trunc(rateLimit.windowMs) : null,
  };
}

/**
 * Rebuild the optional per-key rate limit from two nullable columns. A limit is
 * only in force when **both** halves are present and positive — a half-configured
 * row falls back to the collector defaults rather than silently throttling to
 * zero.
 */
export function toApiKeyRateLimit(
  max: number | null | undefined,
  windowMs: number | null | undefined,
): ApiKeyRateLimit | null {
  if (max == null || windowMs == null) return null;
  const m = Number(max);
  const w = Number(windowMs);
  if (!Number.isFinite(m) || !Number.isFinite(w) || m <= 0 || w <= 0) return null;
  return { max: m, windowMs: w };
}

// --- Agent audit log (ADR 0051 §7) ---

/**
 * Where an audited request entered the collector. Only `http` is written today;
 * `mcp-http` / `mcp-stdio` / `assistant` are reserved for the later stage-3
 * transports so the column's vocabulary does not churn.
 */
export type AuditSurface = "http" | "mcp-http" | "mcp-stdio" | "assistant";

/** One recorded agent request. `params` is bounded and never carries the key. */
export interface AgentAuditEntry {
  id: string;
  projectId: string;
  /** The key row's id — never the key or its hash. */
  keyId: string;
  at: Date;
  surface: AuditSurface;
  /** Endpoint path (`http`) or tool name (MCP/assistant). */
  toolOrPath: string;
  /** Bounded, redacted JSON of the request parameters. */
  params: string;
  /** Rows returned, when the handler produced a countable result. */
  rowCount: number | null;
  durationMs: number;
  /** HTTP status (or an equivalent code for non-HTTP surfaces). */
  status: number;
}

/** What a caller supplies to record an audit row; the store fills in `id`. */
export interface AgentAuditInput {
  projectId: string;
  keyId: string;
  surface: AuditSurface;
  toolOrPath: string;
  params: string;
  rowCount?: number | null;
  durationMs: number;
  status: number;
  /** Defaults to "now" in the store. */
  at?: Date;
}

/** Filters accepted by the audit read path. */
export interface AuditQueryOptions {
  /** Inclusive lower bound, epoch ms. */
  since?: number;
  /** Exclusive upper bound, epoch ms. */
  until?: number;
  limit?: number;
}

/** Hard cap on the serialized `params` blob, so one row can never grow unbounded. */
export const AUDIT_PARAMS_MAX_LENGTH = 512;

/** Hard cap on `tool_or_path`, matching the collector's longest route by a wide margin. */
export const AUDIT_TOOL_MAX_LENGTH = 200;

/**
 * Parameter names never written to the audit log, whatever their value. The
 * audit log is queryable by anyone holding a `query` key, so a credential that
 * leaked into a querystring must not be persisted (ADR 0003).
 */
const AUDIT_REDACTED_KEYS = new Set([
  "key",
  "apikey",
  "api_key",
  "x-api-key",
  "token",
  "secret",
  "password",
  "authorization",
]);

/**
 * Serialize request parameters for the audit log: drop credential-shaped keys,
 * clamp each value, and bound the whole document to
 * {@link AUDIT_PARAMS_MAX_LENGTH}.
 *
 * The result is **always valid JSON**: when the document would exceed the cap,
 * fields are dropped (not the text truncated) and a `_truncated: true` marker is
 * added, so whoever reads the audit log can parse every row. Never throws — an
 * audit write must not be able to fail a request.
 */
export function serializeAuditParams(params: unknown): string {
  const source: Record<string, unknown> =
    params != null && typeof params === "object" && !Array.isArray(params)
      ? (params as Record<string, unknown>)
      : {};

  const safe: Record<string, string | number | boolean> = {};
  let dropped = false;
  for (const [rawKey, value] of Object.entries(source)) {
    if (AUDIT_REDACTED_KEYS.has(rawKey.toLowerCase())) continue;
    if (value == null) continue;
    let clamped: string | number | boolean;
    if (typeof value === "number" || typeof value === "boolean") {
      clamped = value;
    } else if (typeof value === "string") {
      clamped = value.length > 120 ? `${value.slice(0, 120)}…` : value;
    } else {
      // Objects/arrays are summarized rather than embedded, so one nested blob
      // cannot dominate (or blow) the bounded document.
      clamped = `[${Array.isArray(value) ? "array" : typeof value}]`;
    }
    // Add the field only if the document still fits with the truncation marker
    // that would be needed if anything else has to be dropped.
    const candidate = { ...safe, [rawKey]: clamped, _truncated: true };
    if (safeStringify(candidate).length > AUDIT_PARAMS_MAX_LENGTH) {
      dropped = true;
      continue;
    }
    safe[rawKey] = clamped;
  }
  const json = safeStringify(dropped ? { ...safe, _truncated: true } : safe);
  // Belt and braces: a pathological key name could still overshoot.
  return json.length > AUDIT_PARAMS_MAX_LENGTH ? '{"_truncated":true}' : json;
}

/** `JSON.stringify` that yields `{}` instead of throwing on an odd value. */
function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? "{}";
  } catch {
    return "{}";
  }
}

/** Clamp an endpoint path / tool name to {@link AUDIT_TOOL_MAX_LENGTH}. */
export function clampAuditTool(toolOrPath: string): string {
  return toolOrPath.length > AUDIT_TOOL_MAX_LENGTH
    ? toolOrPath.slice(0, AUDIT_TOOL_MAX_LENGTH)
    : toolOrPath;
}

// --- Scene registry (ADR 0010 / 0014) ---

/**
 * One representation per `(projectId, sceneId)`. Gives world-space heatmaps a
 * backdrop — an engine-agnostic {@link SceneProxy} captured from a live scene, a
 * URL to an external display asset, or `"none"` (registered, label only).
 */
export type SceneRepresentationKind = "none" | "proxy" | "asset";

export interface SceneRepresentation {
  projectId: string;
  sceneId: string;
  /** Human-friendly label for the scene (developer-supplied). */
  label: string | null;
  kind: SceneRepresentationKind;
  upAxis: "y" | "z";
  unitScale: number;
  /** Overall world bounds `[minX,minY,minZ,maxX,maxY,maxZ]`, when known. */
  bounds: Aabb | null;
  /** Full proxy geometry when `kind === "proxy"`. */
  proxy: SceneProxy | null;
  /** External asset URL when `kind === "asset"`. */
  assetUrl: string | null;
  /** Content digest of the proxy/asset for cache validation. */
  contentHash: string | null;
  /** Proxy wire-format version, when a proxy is stored. */
  proxyVersion: number | null;
  /** When the geometry was captured (epoch-based; `null` for `"none"`). */
  capturedAt: Date | null;
  updatedAt: Date;
}

// --- Scene regions (ADR 0051 §2 / sketch §B.2) ---

/**
 * One stored region of a scene: a labelled world-space box that names a place
 * ("the entrance", "the checkout counter") so spatial results can be talked
 * about in words. Keyed by `(projectId, sceneId, regionId)`; regions may
 * overlap. The wire shape is `sceneRegionSchema` in `@uptimizr/schema` — this is
 * its storage projection, with the row's `updatedAt` added.
 */
export interface SceneRegionRecord {
  projectId: string;
  sceneId: string;
  regionId: string;
  /** Human-friendly name shown in dashboards, summaries, and agent answers. */
  label: string;
  /** Optional free-text note about what the region is. */
  description: string | null;
  /** World-space box `[minX,minY,minZ,maxX,maxY,maxZ]` (canonical frame). */
  bounds: Aabb;
  updatedAt: Date;
}

/**
 * Lightweight project-wide region listing row: the names only, without the
 * per-region box. Lets a client (or an agent building its project context) learn
 * a project's whole spatial vocabulary in one read instead of one GET per scene.
 */
export interface SceneRegionSummary {
  sceneId: string;
  regionId: string;
  label: string;
}

/** Lightweight registry listing row (omits the heavy `proxy` blob). */
export interface SceneRepresentationSummary {
  sceneId: string;
  label: string | null;
  kind: SceneRepresentationKind;
  bounds: Aabb | null;
  contentHash: string | null;
  capturedAt: Date | null;
  updatedAt: Date;
}

// --- Project metadata: annotations, glossary, saved analyses (ADR 0051 §5) ---

/**
 * The storage projections of `@uptimizr/schema`'s metadata contracts
 * (sketch §E.2). The wire shapes live once, in the schema package; these add
 * only what the *row* knows and the client cannot set — the generated id, who
 * wrote it, and when.
 *
 * Every one of these tables is **project-scoped, bounded and audited**. They
 * are the only writable surface besides ingestion, they never touch the events
 * tables, and the `annotate` capability gates each write (ADR 0051 §7/§9).
 */

/** Who wrote a metadata row — derived by the collector, never by the payload. */
export type { MetadataAuthorKind };

/** What an annotation is about — re-exported so stores need one import. */
export type { AnnotationTargetKind };

/**
 * Attribution attached to every metadata write: the kind of author the
 * collector decided on, and the id of the API key that carried the request
 * (never the key or its hash — ADR 0003). `authorKeyId` is null only for rows
 * written by a store's own tooling (seeding, tests).
 */
export interface MetadataAuthor {
  authorKind: MetadataAuthorKind;
  authorKeyId: string | null;
}

/** One stored annotation. */
export interface AnnotationRecord extends MetadataAuthor {
  id: string;
  projectId: string;
  targetKind: AnnotationTargetKind;
  targetId: string | null;
  /** Start of the annotated period, or null for a standing note. */
  since: Date | null;
  /** End of the annotated period, or null for an open-ended / instant note. */
  until: Date | null;
  text: string;
  createdAt: Date;
  updatedAt: Date;
}

/** What a caller supplies to create an annotation; the store fills id and times. */
export interface CreateAnnotationInput extends MetadataAuthor {
  annotation: Annotation;
}

/**
 * Filters for the annotation read path. All optional: the unfiltered call is
 * "the project's recent annotations", which is what the dashboard time axis and
 * the project context document both ask for.
 */
export interface ListAnnotationsOptions {
  /** Only annotations about this kind of thing. */
  targetKind?: AnnotationTargetKind;
  /** Only annotations about this specific scene/mesh/region/metric. */
  targetId?: string;
  /**
   * Overlap filter, epoch ms: keep annotations whose period intersects
   * `[since, until)`. A standing note (no period) always matches — it is about
   * the project as a whole, not about a moment.
   */
  since?: number;
  until?: number;
  limit?: number;
}

/** One stored glossary entry. Identity is `(projectId, term)`. */
export interface GlossaryEntryRecord {
  projectId: string;
  term: string;
  meaning: string;
  updatedAt: Date;
}

/** What a caller supplies to upsert a glossary entry. */
export interface PutGlossaryEntryInput {
  entry: GlossaryEntry;
}

/** One stored saved analysis. */
export interface SavedAnalysisRecord extends MetadataAuthor {
  id: string;
  projectId: string;
  title: string;
  /** The stored question, parsed back from its JSON column. */
  query: SavedAnalysisQuery;
  conclusion: string | null;
  createdAt: Date;
}

/** What a caller supplies to create a saved analysis. */
export interface CreateSavedAnalysisInput extends MetadataAuthor {
  analysis: SavedAnalysis;
}

/** Row cap for a list read, shared by every metadata list endpoint. */
export interface MetadataListOptions {
  limit?: number;
}

/**
 * Per-project row caps (ADR 0051 §5). Metadata is a curated set of notes, so
 * every store refuses the write that would exceed its table's cap rather than
 * silently growing. The numbers live in `@uptimizr/schema`'s `LIMITS` with the
 * rest of the wire bounds; this is the storage-side view of them.
 */
export const METADATA_LIMITS = {
  annotations: LIMITS.maxProjectAnnotations,
  glossary: LIMITS.maxProjectGlossaryEntries,
  savedAnalyses: LIMITS.maxProjectSavedAnalyses,
} as const;

/** Which metadata table a {@link MetadataLimitError} is about. */
export type MetadataTable = keyof typeof METADATA_LIMITS;

/**
 * Thrown by a store when a write would take a project past the table's cap.
 * The collector maps it to `409 Conflict` — the request was well-formed, the
 * project is simply full, and the caller fixes it by deleting something.
 */
export class MetadataLimitError extends Error {
  constructor(
    readonly table: MetadataTable,
    readonly limit: number,
  ) {
    super(`project has reached its limit of ${limit} ${table} rows`);
    this.name = "MetadataLimitError";
  }
}

/**
 * Clamp a caller-supplied `limit` into `[1, max]`, defaulting when absent.
 * Shared by every store so one engine cannot quietly return more rows than
 * another for the same request.
 */
export function clampMetadataLimit(limit: number | undefined, fallback = 100, max = 500): number {
  if (limit == null || !Number.isFinite(limit)) return fallback;
  return Math.min(Math.max(Math.trunc(limit), 1), max);
}

/**
 * Parse a stored `query` JSON column back into an object. A row written by this
 * collector always parses; a hand-edited or truncated one degrades to `{}`
 * rather than failing the whole listing.
 */
export function parseSavedAnalysisQuery(json: string): SavedAnalysisQuery {
  try {
    const parsed: unknown = JSON.parse(json);
    return parsed != null && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as SavedAnalysisQuery)
      : {};
  } catch {
    return {};
  }
}
