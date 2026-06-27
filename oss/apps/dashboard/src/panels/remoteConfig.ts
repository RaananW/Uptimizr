// Runtime / remote panel-loading configuration (ADR 0041).
//
// Build-time registration (ADR 0036) stays the default: panels in `builtinPanels`
// are bundled into the dashboard. This module reads the OPT-IN config that lets a
// self-hoster also load panels from a remote manifest at runtime, without
// rebuilding. Both knobs are build-time env vars (so they survive the static
// export) but the loading they enable happens client-side at runtime.
//
// Trust: a remote panel runs with the dashboard's full privileges. Only point
// `NEXT_PUBLIC_PANELS_MANIFEST_URL` at sources you trust; the optional
// `NEXT_PUBLIC_PANELS_ALLOWED_ORIGINS` allowlist is a guardrail, not a sandbox.

/** Resolved remote-panel config. `enabled` is false when no manifest is set. */
export interface RemotePanelConfig {
  /** Whether any manifest URL is configured. */
  readonly enabled: boolean;
  /** Manifest URLs to fetch (comma-separated in the env var). */
  readonly manifestUrls: string[];
  /** Optional allowlist of module origins (comma-separated in the env var). */
  readonly allowOrigins: string[];
}

function parseList(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

/**
 * Read the remote-panel config from the build-time environment.
 *
 * - `NEXT_PUBLIC_PANELS_MANIFEST_URL` — one or more manifest URLs (comma-separated).
 *   Unset ⇒ remote loading is disabled and the dashboard behaves exactly as before.
 * - `NEXT_PUBLIC_PANELS_ALLOWED_ORIGINS` — optional comma-separated origin allowlist
 *   applied to every remote module URL.
 */
export function getRemotePanelConfig(): RemotePanelConfig {
  const manifestUrls = parseList(process.env.NEXT_PUBLIC_PANELS_MANIFEST_URL);
  const allowOrigins = parseList(process.env.NEXT_PUBLIC_PANELS_ALLOWED_ORIGINS);
  return {
    enabled: manifestUrls.length > 0,
    manifestUrls,
    allowOrigins,
  };
}
