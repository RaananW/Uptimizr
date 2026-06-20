#!/usr/bin/env node
// Single-command launcher for trying Uptimizr in the Babylon.js Playground.
//
//   pnpm playground            # http URL (works in Chrome/Firefox)
//   pnpm playground --tunnel   # public https URL (also works in Safari / for sharing)
//
// It boots the full local stack (ClickHouse + Postgres, collector, dashboard),
// builds the standalone @uptimizr/babylon bundle, and serves a SINGLE local
// origin that (a) hands out the bundle and (b) proxies ingestion to the
// collector — adding the CORS + Private-Network-Access headers the Playground
// (an https page hitting your machine) needs. It then prints a ready-to-paste
// snippet plus the dashboard URL where the captured sessions show up.

import { spawn } from "node:child_process";
import { createServer, request as httpRequest } from "node:http";
import { connect } from "node:net";
import {
  createReadStream,
  existsSync,
  readFileSync,
  copyFileSync,
  mkdirSync,
  writeFileSync,
} from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const PLAYGROUND_ORIGIN = "https://playground.babylonjs.com";
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const envPath = join(repoRoot, ".env");
const registryPath = join(repoRoot, ".uptimizr", "projects.json");
const bundlePath = join(repoRoot, "oss/packages/sdk-babylon/dist/uptimizr-babylon.js");
const globalBundlePath = join(
  repoRoot,
  "oss/packages/sdk-babylon/dist/uptimizr-babylon.global.js",
);
const replayBundlePath = join(repoRoot, "oss/packages/replay/dist/uptimizr-replay.global.js");

const args = process.argv.slice(2);
const useTunnel = args.includes("--tunnel");
const sharePort = Number(readFlag(args, "--port") ?? 4400);

/** Read a `--flag=value` or `--flag value` style argument. */
function readFlag(argv, flag) {
  const eq = argv.find((a) => a.startsWith(`${flag}=`));
  if (eq) return eq.slice(flag.length + 1);
  const i = argv.indexOf(flag);
  return i >= 0 && i + 1 < argv.length && !argv[i + 1].startsWith("--") ? argv[i + 1] : undefined;
}

/** Minimal KEY=VALUE parser for the root .env (quotes stripped, # comments ignored). */
function parseEnvFile(file) {
  const out = {};
  if (!existsSync(file)) return out;
  for (const raw of readFileSync(file, "utf8").split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    out[key] = val;
  }
  return out;
}

const log = (msg) => console.log(`\n\x1b[36m▸\x1b[0m ${msg}`);
const ok = (msg) => console.log(`  \x1b[32m✓\x1b[0m ${msg}`);

/** Upsert a project entry into the local registry the dashboard reads. */
function recordProject(entry) {
  mkdirSync(dirname(registryPath), { recursive: true });
  let list = [];
  if (existsSync(registryPath)) {
    try {
      const parsed = JSON.parse(readFileSync(registryPath, "utf8"));
      if (Array.isArray(parsed)) list = parsed;
    } catch {
      list = [];
    }
  }
  const next = [...list.filter((p) => p && p.id !== entry.id), entry];
  writeFileSync(registryPath, `${JSON.stringify(next, null, 2)}\n`);
}

const children = [];
let shuttingDown = false;

/** Spawn a long-running child, inherit stdio, and remember it for cleanup. */
function spawnLong(name, command, commandArgs, env) {
  const child = spawn(command, commandArgs, {
    cwd: repoRoot,
    env: { ...process.env, ...env },
    stdio: ["ignore", "inherit", "inherit"],
  });
  child.on("exit", (code) => {
    if (!shuttingDown) console.error(`\n[${name}] exited (code ${code ?? "?"}).`);
  });
  children.push(child);
  return child;
}

/** Run a one-shot command to completion; reject on a non-zero exit. */
function run(command, commandArgs, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, commandArgs, {
      cwd: repoRoot,
      env: { ...process.env, ...env },
      stdio: ["ignore", "inherit", "inherit"],
    });
    child.on("exit", (code) =>
      code === 0
        ? resolve()
        : reject(new Error(`${command} ${commandArgs.join(" ")} → exit ${code}`)),
    );
    child.on("error", reject);
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Poll an HTTP URL until `predicate(statusCode)` holds or we time out. */
async function waitForHttp(url, predicate, { timeoutMs = 60000, label } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const status = await new Promise((resolve) => {
      const req = httpRequest(url, { method: "GET" }, (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      });
      req.on("error", () => resolve(0));
      req.end();
    });
    if (predicate(status)) return;
    await sleep(750);
  }
  throw new Error(`Timed out waiting for ${label ?? url}`);
}

/** Poll a TCP port until it accepts a connection or we time out. */
async function waitForTcp(port, host, { timeoutMs = 60000, label } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const reachable = await new Promise((resolve) => {
      const socket = connect(port, host);
      socket.once("connect", () => {
        socket.destroy();
        resolve(true);
      });
      socket.once("error", () => resolve(false));
    });
    if (reachable) return;
    await sleep(750);
  }
  throw new Error(`Timed out waiting for ${label ?? `${host}:${port}`}`);
}

/** Set the CORS + Private-Network-Access headers a public https page needs to reach localhost. */
function setCrossOriginHeaders(res, origin) {
  // `navigator.sendBeacon` (the SDK's primary transport) always sends in
  // credentials mode "include", so a credentialed response must echo the exact
  // origin and set Allow-Credentials — a wildcard origin is rejected.
  if (origin) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Access-Control-Allow-Credentials", "true");
    res.setHeader("Vary", "Origin");
  } else {
    res.setHeader("Access-Control-Allow-Origin", "*");
  }
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,PUT,PATCH,DELETE,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "content-type,x-api-key");
  res.setHeader("Access-Control-Allow-Private-Network", "true");
  res.setHeader("Access-Control-Max-Age", "86400");
}

/**
 * Combined origin: serves the bundle and proxies everything else to the
 * collector, injecting the cross-origin headers the Playground requires. One
 * origin keeps the paste-in snippet to a single base URL.
 */
function startShareServer(collectorPort) {
  const server = createServer((req, res) => {
    const origin = req.headers.origin;
    const url = req.url ?? "/";

    if (req.method === "OPTIONS") {
      setCrossOriginHeaders(res, origin);
      res.writeHead(204);
      res.end();
      return;
    }

    if (
      url === "/uptimizr-babylon.js" ||
      url.startsWith("/uptimizr-babylon.js?") ||
      url === "/uptimizr-babylon.global.js" ||
      url.startsWith("/uptimizr-babylon.global.js?") ||
      url === "/uptimizr-replay.global.js" ||
      url.startsWith("/uptimizr-replay.global.js?")
    ) {
      const isReplay = url.startsWith("/uptimizr-replay.global.js");
      const isGlobal = url.startsWith("/uptimizr-babylon.global.js");
      const file = isReplay ? replayBundlePath : isGlobal ? globalBundlePath : bundlePath;
      if (!existsSync(file)) {
        res.writeHead(503);
        res.end("bundle not built yet");
        return;
      }
      setCrossOriginHeaders(res, null);
      res.setHeader("Content-Type", "text/javascript; charset=utf-8");
      res.setHeader("Cache-Control", "no-store");
      createReadStream(file).pipe(res);
      return;
    }

    if (url === "/health" || url.startsWith("/api/")) {
      const proxyReq = httpRequest(
        {
          host: "127.0.0.1",
          port: collectorPort,
          method: req.method,
          path: url,
          headers: { ...req.headers, host: `127.0.0.1:${collectorPort}` },
        },
        (proxyRes) => {
          const headers = { ...proxyRes.headers };
          headers["access-control-allow-private-network"] = "true";
          // Force a credentialed, origin-specific response so sendBeacon's
          // include-mode request is accepted regardless of what the collector set.
          if (origin) {
            headers["access-control-allow-origin"] = origin;
            headers["access-control-allow-credentials"] = "true";
            headers["vary"] = "Origin";
          } else if (!headers["access-control-allow-origin"]) {
            headers["access-control-allow-origin"] = "*";
          }
          res.writeHead(proxyRes.statusCode ?? 502, headers);
          proxyRes.pipe(res);
        },
      );
      proxyReq.on("error", () => {
        res.writeHead(502);
        res.end("collector unavailable");
      });
      req.pipe(proxyReq);
      return;
    }

    res.writeHead(404);
    res.end("not found");
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(sharePort, () => resolve(server));
  });
}

/** Start a cloudflared quick tunnel (downloaded on demand via npx) and resolve its public https URL. */
function startTunnel(targetUrl) {
  log("Opening a public https tunnel (cloudflared via npx; first run downloads the binary)…");
  const child = spawn("npx", ["-y", "cloudflared", "tunnel", "--url", targetUrl], {
    cwd: repoRoot,
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.push(child);

  return new Promise((resolve, reject) => {
    let settled = false;
    const onData = (buf) => {
      const match = String(buf).match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
      if (match && !settled) {
        settled = true;
        resolve(match[0]);
      }
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    child.on("exit", (code) => {
      if (!settled)
        reject(new Error(`cloudflared exited (code ${code ?? "?"}) before printing a URL`));
    });
    setTimeout(() => {
      if (!settled) reject(new Error("Timed out waiting for the cloudflared URL"));
    }, 60000);
  });
}

function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log("\nShutting down…");
  for (const child of children) child.kill("SIGTERM");
  setTimeout(() => process.exit(0), 500);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

async function main() {
  console.log("\n\x1b[1mUptimizr → Babylon Playground launcher\x1b[0m");

  // 0. Ensure a .env exists (first run convenience).
  if (!existsSync(envPath)) {
    copyFileSync(join(repoRoot, ".env.example"), envPath);
    ok("created .env from .env.example");
  }
  const env = parseEnvFile(envPath);
  const collectorPort = Number(env.COLLECTOR_PORT ?? 4318);
  const clickhouseUrl = env.CLICKHOUSE_URL ?? "http://localhost:8123";
  const postgresPort = Number(env.POSTGRES_HOST_PORT ?? 5432);

  // 1. Databases.
  log("Starting databases (ClickHouse + Postgres)…");
  await run("docker", [
    "compose",
    "--env-file",
    ".env",
    "-f",
    "infra/docker/docker-compose.yml",
    "up",
    "-d",
  ]);
  await waitForHttp(`${clickhouseUrl}/ping`, (s) => s === 200, {
    label: "ClickHouse",
    timeoutMs: 90000,
  });
  await waitForTcp(postgresPort, "127.0.0.1", { label: "Postgres", timeoutMs: 90000 });
  ok("databases healthy");

  // 2. Migrate, and seed a project the first time (only if none is recorded in .env).
  log("Applying migrations…");
  await run("pnpm", ["db:migrate"]);
  let projectId = parseEnvFile(envPath).VITE_PROJECT_ID;
  if (!projectId) {
    log("Seeding a demo project…");
    await run("pnpm", ["db:seed"]);
    projectId = parseEnvFile(envPath).VITE_PROJECT_ID;
  }
  if (!projectId) throw new Error("No VITE_PROJECT_ID in .env after seeding — cannot continue.");
  ok(`project ${projectId}`);

  // Register the seeded project(s) so the dashboard dropdown lists them on first
  // run. `pnpm db:seed` provisions a viewer + a walkable project (ADR 0026); the
  // walkable vars are absent on older `.env` files, so record it only if present.
  const seededEnv = parseEnvFile(envPath);
  const seededKey = seededEnv.VITE_API_KEY;
  if (seededKey) {
    recordProject({
      id: projectId,
      name: "Demo Project (Viewer)",
      apiKey: seededKey,
      createdAt: new Date().toISOString(),
    });
  }
  const walkableId = seededEnv.VITE_PROJECT_ID_WALKABLE;
  const walkableKey = seededEnv.VITE_API_KEY_WALKABLE;
  if (walkableId && walkableKey) {
    recordProject({
      id: walkableId,
      name: "Demo Project (Walkable)",
      apiKey: walkableKey,
      createdAt: new Date().toISOString(),
    });
  }

  // 3. Build the standalone bundles (collector + replay, and their workspace deps).
  log("Building the standalone @uptimizr/babylon and @uptimizr/replay bundles…");
  await run("pnpm", [
    "--filter",
    "@uptimizr/babylon...",
    "--filter",
    "@uptimizr/replay...",
    "build",
  ]);
  ok("bundles built");

  // 4. Collector — allowlist the Playground origin so its POSTs pass CORS.
  const corsOrigins = [
    ...new Set([
      ...(env.COLLECTOR_CORS_ORIGINS ?? "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean),
      PLAYGROUND_ORIGIN,
    ]),
  ].join(",");
  log("Starting the collector…");
  spawnLong("collector", "pnpm", ["dev:collector"], {
    COLLECTOR_CORS_ORIGINS: corsOrigins,
    // Enable the per-session events endpoint so replay can re-drive a session.
    ENABLE_RAW_SESSION_RETENTION: "true",
  });
  await waitForHttp(`http://127.0.0.1:${collectorPort}/health`, (s) => s === 200, {
    label: "collector",
    timeoutMs: 60000,
  });
  ok(`collector on :${collectorPort}`);

  // 5. Dashboard (let `next dev` own NODE_ENV).
  log("Starting the dashboard…");
  const dashboardEnv = { ...process.env, UPTIMIZR_PROJECTS_FILE: registryPath };
  delete dashboardEnv.NODE_ENV;
  spawnLong("dashboard", "pnpm", ["dev:dashboard"], dashboardEnv);

  // 6. Combined share origin.
  await startShareServer(collectorPort);
  ok(`share origin on :${sharePort}`);

  // 7. Public URL (tunnel) or local http.
  const baseUrl = useTunnel
    ? await startTunnel(`http://localhost:${sharePort}`)
    : `http://localhost:${sharePort}`;

  // 8. Print the paste-in snippet + dashboard link.
  // A <script> tag injected through the DOM sidesteps the Playground's TypeScript
  // pass entirely (no `import` keyword for it to rewrite/block); the global build
  // exposes `window.Uptimizr`. Place this where `scene` exists.
  const snippet = [
    `const s = document.createElement("script");`,
    `s.src = "${baseUrl}/uptimizr-babylon.global.js";`,
    `s.onload = () => {`,
    `  Uptimizr.trackScene(scene, {`,
    `    projectId: "${projectId}",`,
    `    endpoint: "${baseUrl}",`,
    `    meta: { sceneId: "playground" },`,
    `  });`,
    `};`,
    `document.head.appendChild(s);`,
  ].join("\n");

  // Replay snippet: load the replay global build and re-drive a captured session
  // in this scene. Grab a session id from the dashboard's Sessions table.
  const replaySnippet = [
    `const r = document.createElement("script");`,
    `r.src = "${baseUrl}/uptimizr-replay.global.js";`,
    `r.onload = () => {`,
    `  UptimizrReplay.replayInScene({`,
    `    scene,`,
    `    endpoint: "${baseUrl}",`,
    `    apiKey: "${seededKey ?? "<PROJECT_API_KEY>"}",`,
    `    sessionId: "<SESSION_ID>", // copy one from the dashboard Sessions table`,
    `    debug: true, // log fetch/play progress to the console`,
    `  });`,
    `};`,
    `document.head.appendChild(r);`,
  ].join("\n");

  console.log("\n\x1b[1m──────────────────────────────────────────────────────────────\x1b[0m");
  console.log("\x1b[1m Ready. Paste this into your Babylon Playground scene, just before\x1b[0m");
  console.log("\x1b[1m `return scene;` (so `scene` is in scope):\x1b[0m\n");

  console.log("\x1b[33m" + snippet + "\x1b[0m");
  console.log("\n Then interact with the scene. View captured sessions here:");
  console.log("   Dashboard:  \x1b[36mhttp://localhost:3000\x1b[0m");
  console.log("\n To \x1b[1mreplay\x1b[0m a captured session back into the scene, paste this");
  console.log(" (replace <SESSION_ID> with one from the dashboard Sessions table):\n");
  console.log("\x1b[33m" + replaySnippet + "\x1b[0m");
  if (!useTunnel) {
    console.log(
      "\n Note: plain http works in Chrome + Firefox. For Safari (or to share),\n re-run with \x1b[36m--tunnel\x1b[0m for a public https URL.",
    );
  }
  console.log("\n Press Ctrl+C to stop the collector, dashboard, and share server.");
  console.log(" Databases keep running; stop them with \x1b[36mpnpm stack:down\x1b[0m.");
  console.log("\x1b[1m──────────────────────────────────────────────────────────────\x1b[0m\n");
}

main().catch((err) => {
  console.error(`\n\x1b[31m✗ ${err.message}\x1b[0m`);
  shutdown();
  process.exitCode = 1;
});
