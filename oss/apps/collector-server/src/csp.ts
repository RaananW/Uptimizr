import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Content-Security-Policy for the bundled static dashboard.
 *
 * A Next.js static export (`output: "export"`) ships a handful of **inline**
 * bootstrap `<script>` tags. A strict CSP normally allows inline scripts with a
 * per-response *nonce*, but a static export has no server to mint one — the
 * files are byte-for-byte identical on every request. The serving layer (here,
 * or the standalone dashboard server) must therefore allow those exact scripts
 * by their **SHA-256 hash** instead. We enumerate every inline script across the
 * exported HTML at startup and pin its hash, so `script-src` stays free of the
 * blanket `'unsafe-inline'` escape hatch while the app still boots.
 *
 * Everything else is locked down: no plugins (`object-src 'none'`), no framing
 * (`frame-ancestors 'none'`), self-only base URI, and same-origin defaults.
 */

/** Extract the text of every inline (`src`-less) `<script>` in an HTML document. */
function inlineScripts(html: string): string[] {
  const out: string[] = [];
  const re = /<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi;
  let match: RegExpExecArray | null;
  while ((match = re.exec(html)) !== null) {
    const body = match[1] ?? "";
    if (body.length > 0) out.push(body);
  }
  return out;
}

/** CSP `'sha256-...'` source token for an inline script body. */
function sha256Source(scriptBody: string): string {
  const digest = createHash("sha256").update(scriptBody, "utf8").digest("base64");
  return `'sha256-${digest}'`;
}

/**
 * Collect the `'sha256-...'` sources for every inline script in the exported
 * dashboard's HTML files. Reads `*.html` at the export root (the SPA entry plus
 * Next's `404.html` / `_not-found.html`), so any page the host might serve is
 * covered. Best-effort: unreadable files are skipped.
 */
export function dashboardScriptHashes(dashboardDir: string): string[] {
  const hashes = new Set<string>();
  let entries: string[];
  try {
    entries = readdirSync(dashboardDir).filter((f) => f.endsWith(".html"));
  } catch {
    return [];
  }
  for (const file of entries) {
    try {
      const html = readFileSync(join(dashboardDir, file), "utf8");
      for (const body of inlineScripts(html)) hashes.add(sha256Source(body));
    } catch {
      // Skip files we cannot read; the remaining hashes still apply.
    }
  }
  return [...hashes];
}

/**
 * Build the helmet `contentSecurityPolicy` directives for the bundled dashboard.
 * `connectOrigins` (the configured CORS origins) are added to `connect-src` so a
 * dashboard served from a different origin than the collector can still reach the
 * query + live-SSE API.
 */
export function buildDashboardCsp(
  dashboardDir: string,
  connectOrigins: readonly string[],
): { useDefaults: false; directives: Record<string, string[]> } {
  const scriptSrc = ["'self'", ...dashboardScriptHashes(dashboardDir)];
  const connectSrc = ["'self'", ...connectOrigins];
  return {
    useDefaults: false,
    directives: {
      defaultSrc: ["'self'"],
      baseUri: ["'self'"],
      objectSrc: ["'none'"],
      frameAncestors: ["'none'"],
      formAction: ["'self'"],
      scriptSrc,
      // Static export + Babylon panels apply styles the framework injects inline;
      // inline styles are far lower-risk than scripts, so allow them here.
      styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", "data:", "blob:"],
      fontSrc: ["'self'", "data:"],
      workerSrc: ["'self'", "blob:"],
      connectSrc,
    },
  };
}
