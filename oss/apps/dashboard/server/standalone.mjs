#!/usr/bin/env node
// Standalone static server for the exported Uptimizr dashboard (ADR 0029 A.3).
//
// Serves the prebuilt static export (`out/`) on its own port for users who want
// the UI as a separate process from the collector. Zero dependencies — just
// Node's http/fs — so the published package stays light. The collector URL is
// supplied at runtime (the in-UI connection bar), so the same assets work
// against any collector without a rebuild.
//
// Usage:
//   uptimizr-dashboard                 # serve out/ on :3000
//   uptimizr-dashboard --port 8080     # or DASHBOARD_PORT / PORT env
import { createReadStream, existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { extname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = fileURLToPath(new URL(".", import.meta.url));
// The bin lives at <pkg>/server/, so the export sits at <pkg>/out/.
const ROOT = resolve(here, "..", "out");

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".map": "application/json; charset=utf-8",
  ".wasm": "application/wasm",
};

function parsePort() {
  const flagIdx = process.argv.indexOf("--port");
  const fromFlag = flagIdx !== -1 ? process.argv[flagIdx + 1] : undefined;
  const raw = fromFlag ?? process.env.DASHBOARD_PORT ?? process.env.PORT ?? "3000";
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    console.error(`Invalid port: ${raw}`);
    process.exit(1);
  }
  return port;
}

/** Resolve a request path to a file inside ROOT, or null if it escapes ROOT. */
function safeResolve(urlPath) {
  // Strip query/hash and decode, then normalize away any `..` segments.
  const decoded = decodeURIComponent(urlPath.split("?")[0].split("#")[0]);
  const rel = normalize(decoded).replace(/^(\.\.[/\\])+/, "");
  const abs = join(ROOT, rel);
  if (abs !== ROOT && !abs.startsWith(ROOT + (process.platform === "win32" ? "\\" : "/"))) {
    return null;
  }
  return abs;
}

/**
 * Build a Content-Security-Policy for the exported dashboard. A Next.js static
 * export has no server to mint per-request nonces, so its inline bootstrap
 * scripts are pinned by SHA-256 hash instead of allowed via `'unsafe-inline'`.
 * We enumerate the inline scripts across the exported HTML at startup.
 */
function scriptHashes() {
  const hashes = new Set();
  let files;
  try {
    files = readdirSync(ROOT).filter((f) => f.endsWith(".html"));
  } catch {
    return [];
  }
  for (const file of files) {
    try {
      const html = readFileSync(join(ROOT, file), "utf8");
      const re = /<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi;
      let m;
      while ((m = re.exec(html)) !== null) {
        if (m[1].length === 0) continue;
        hashes.add(`'sha256-${createHash("sha256").update(m[1], "utf8").digest("base64")}'`);
      }
    } catch {
      // Skip unreadable files; remaining hashes still apply.
    }
  }
  return [...hashes];
}

function securityHeaders() {
  const scriptSrc = ["'self'", ...scriptHashes()].join(" ");
  const csp = [
    "default-src 'self'",
    "base-uri 'self'",
    "object-src 'none'",
    "frame-ancestors 'none'",
    "form-action 'self'",
    `script-src ${scriptSrc}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    "worker-src 'self' blob:",
    // The collector URL is supplied at runtime, so analytics queries / SSE may
    // target any origin the operator points the connection bar at.
    "connect-src 'self' https: http: ws: wss:",
  ].join("; ");
  return {
    "content-security-policy": csp,
    "x-content-type-options": "nosniff",
    "x-frame-options": "DENY",
    "referrer-policy": "no-referrer",
  };
}

const SECURITY_HEADERS = securityHeaders();

function send(res, status, filePath) {
  const type = MIME[extname(filePath).toLowerCase()] ?? "application/octet-stream";
  res.writeHead(status, { ...SECURITY_HEADERS, "content-type": type });
  createReadStream(filePath).pipe(res);
}

const indexHtml = join(ROOT, "index.html");

const server = createServer((req, res) => {
  if (req.method !== "GET" && req.method !== "HEAD") {
    res.writeHead(405, { "content-type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ error: "Method Not Allowed" }));
    return;
  }

  const abs = safeResolve(req.url ?? "/");
  if (abs === null) {
    res.writeHead(403, { "content-type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ error: "Forbidden" }));
    return;
  }

  // Directory → its index.html; existing file → that file.
  let target = abs;
  if (existsSync(target) && statSync(target).isDirectory()) {
    target = join(target, "index.html");
  }
  if (existsSync(target) && statSync(target).isFile()) {
    send(res, 200, target);
    return;
  }

  // SPA deep-link fallback (`/projects/:id/...`): serve the app entry so the
  // client router can resolve the route on a refresh or shared link.
  send(res, 200, indexHtml);
});

function main() {
  if (!existsSync(indexHtml)) {
    console.error(
      `No static export found at ${ROOT}.\n` +
        `Build it first: pnpm --filter @uptimizr/dashboard build:static`,
    );
    process.exit(1);
  }
  const port = parsePort();
  const host = process.env.DASHBOARD_HOST ?? "0.0.0.0";
  server.listen(port, host, () => {
    console.log(`Uptimizr dashboard serving ${ROOT}`);
    console.log(`  http://localhost:${port}`);
    console.log(`Set the collector URL in the dashboard's connection bar.`);
  });
  const close = () => server.close(() => process.exit(0));
  process.on("SIGINT", close);
  process.on("SIGTERM", close);
}

main();
