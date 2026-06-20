// The dashboard's collector client lives in `@uptimizr/react` so the standalone
// dashboard and any app embedding the panels share one implementation of the
// query client and its response types. This module re-exports that single
// source and adds the dashboard-only, build-time collector-URL defaults.

export * from "@uptimizr/react";

/**
 * Whether a collector URL was pinned at build time via
 * `NEXT_PUBLIC_COLLECTOR_URL`. When it wasn't (e.g. a static dashboard served
 * by the collector itself), the UI defaults the collector URL to the origin the
 * page was served from instead of a hard-coded localhost value.
 */
export const COLLECTOR_URL_IS_PINNED = Boolean(process.env.NEXT_PUBLIC_COLLECTOR_URL);

/** Default collector base URL, overridable at build time. */
export const DEFAULT_COLLECTOR_URL =
  process.env.NEXT_PUBLIC_COLLECTOR_URL ?? "http://localhost:4318";

/**
 * Optional dev-only default API key, overridable at build time.
 *
 * A read API key is a credential. The published static export (`DASHBOARD_STATIC=1`)
 * is a redistributable artifact, so a key must never be inlined into its JS
 * bundle — operators paste the key into the connection bar at runtime instead.
 * Outside a static build (local `next dev`), the prefill is kept as a convenience.
 */
export const DEFAULT_API_KEY =
  process.env.DASHBOARD_STATIC === "1" ? "" : (process.env.NEXT_PUBLIC_API_KEY ?? "");

/**
 * Base URL of the Uptimizr playground, used to embed the feature-testing overlay
 * for a scene (`?scene=&engine=`). Local-dev default matches the playground's
 * fixed Vite port; empty disables the embedded overlay in a deployed dashboard.
 */
export const DEFAULT_PLAYGROUND_URL =
  process.env.NEXT_PUBLIC_PLAYGROUND_URL ?? "http://localhost:5173";
