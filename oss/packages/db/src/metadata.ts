/**
 * Engine-neutral metadata helpers and types (ADR 0020).
 *
 * API-key hashing/generation are pure crypto and the project / API-key / scene
 * representation shapes are storage-independent. Both the OSS DuckDB store and
 * the scale-tier Postgres metadata clients reuse these, so the type contracts live
 * once and OSS carries no Postgres dependency.
 */

import { createHash, randomBytes } from "node:crypto";
import type { Aabb, SceneProxy } from "@uptimizr/schema";

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
 * What a project API key is allowed to do. `query` keys may read the analytics
 * API (the default — public ingestion is keyless, so issued keys are for
 * reads); `ingest` keys are reserved for server-side write paths.
 */
export type ApiKeyCapability = "ingest" | "query";

export interface ApiKeyRecord {
  id: string;
  projectId: string;
  keyPrefix: string;
  createdAt: Date;
  revokedAt: Date | null;
  /** What this key is allowed to do. Defaults to `query`. */
  capability: ApiKeyCapability;
}

/**
 * The result of resolving a plaintext API key: the project it authenticates and
 * the capability that scopes what it may do at the request boundary.
 */
export interface ResolvedApiKey {
  projectId: string;
  capability: ApiKeyCapability;
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
