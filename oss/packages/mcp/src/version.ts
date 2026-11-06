import { createRequire } from "node:module";

/**
 * Read from the package's own `package.json` at load time rather than hard-coded,
 * so a Changesets release bump cannot drift from what the server reports in
 * `initialize`. The lookup resolves relative to this module, which sits one
 * directory below the package root both in `src/` (under Vitest and `tsx`) and in
 * `dist/` (built). Any failure degrades to `"unknown"`: the version is descriptive
 * metadata, and a server that cannot read its own manifest must still serve.
 */
function readVersion(): string {
  try {
    const manifest = createRequire(import.meta.url)("../package.json") as { version?: unknown };
    return typeof manifest.version === "string" ? manifest.version : "unknown";
  } catch {
    return "unknown";
  }
}

/** Package version, stamped into the MCP server identity. */
export const version: string = readVersion();
