import { createRequire } from "node:module";

/**
 * The running collector's package version, reported in the project context
 * document (`GET /api/v1/context`, ADR 0051 §5) so an agent can tell an old
 * self-hosted collector from a current one before it blames the data.
 *
 * Read from the package's own `package.json` at load time rather than hard-coded,
 * so a Changesets release bump cannot drift from what the server reports. The
 * lookup resolves relative to this module, which sits one directory below the
 * package root both in `src/` (under Vitest) and in `dist/` (built). Any failure
 * degrades to `"unknown"`: the version is descriptive metadata, and a collector
 * that cannot read its own manifest must still serve.
 */
function readVersion(): string {
  try {
    const manifest = createRequire(import.meta.url)("../package.json") as { version?: unknown };
    return typeof manifest.version === "string" ? manifest.version : "unknown";
  } catch {
    return "unknown";
  }
}

/** Semver of the running `@uptimizr/collector-server`, or `"unknown"`. */
export const COLLECTOR_VERSION: string = readVersion();
