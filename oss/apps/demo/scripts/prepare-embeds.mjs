// Build the two reused apps — the playground (Vite) and the dashboard (Next
// static export) — and stage them under the demo's `public/` so Vite serves
// them at `/playground/` and `/dashboard/` on one origin. The demo app itself
// is unchanged source for both; only build-time env + base path differ.
//
// Both embeds talk to the collector at the demo origin (relative `/api/v1/*`),
// which the service worker intercepts and routes to the in-browser DuckDB store.
// No real backend is involved.
//
// Set `SKIP_EMBEDS=1` to skip the (slow) embed builds — useful when iterating on
// the demo shell. Missing embeds are replaced with a placeholder page so the
// shell still builds and runs.

import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const demoDir = resolve(here, "..");
const repoRoot = resolve(demoDir, "..", "..", "..");
const publicDir = resolve(demoDir, "public");

const playgroundOut = resolve(repoRoot, "examples/playground/dist");
const dashboardOut = resolve(repoRoot, "oss/apps/dashboard/out");
const playgroundDest = resolve(publicDir, "playground");
const dashboardDest = resolve(publicDir, "dashboard");

/** Run a command, inheriting stdio; return whether it succeeded. */
function run(cmd, args, env) {
  const res = spawnSync(cmd, args, {
    cwd: repoRoot,
    stdio: "inherit",
    env: { ...process.env, ...env },
    shell: false,
  });
  return res.status === 0;
}

/** Drop a minimal placeholder so a missing embed doesn't break the shell. */
function writePlaceholder(dest, label) {
  mkdirSync(dest, { recursive: true });
  writeFileSync(
    resolve(dest, "index.html"),
    `<!doctype html><meta charset="utf-8"><title>${label}</title>` +
      `<body style="font:16px system-ui;background:#0b0d12;color:#9aa3b2;display:grid;` +
      `place-items:center;height:100vh;margin:0"><p>${label} embed not built. ` +
      `Run <code>pnpm --filter @uptimizr/demo prepare-embeds</code>.</p></body>`,
  );
}

function stage(out, dest, label) {
  rmSync(dest, { recursive: true, force: true });
  if (existsSync(out)) {
    cpSync(out, dest, { recursive: true });
    console.log(`[demo] staged ${label} -> ${dest}`);
  } else {
    writePlaceholder(dest, label);
    console.warn(`[demo] ${label} build output missing; wrote placeholder`);
  }
}

if (process.env.SKIP_EMBEDS === "1") {
  console.log("[demo] SKIP_EMBEDS=1 — using placeholders for embeds");
  if (!existsSync(resolve(playgroundDest, "index.html"))) writePlaceholder(playgroundDest, "Playground");
  if (!existsSync(resolve(dashboardDest, "index.html"))) writePlaceholder(dashboardDest, "Dashboard");
  process.exit(0);
}

// --- Playground (Vite) -------------------------------------------------------
// Served under `/playground/`; posts events to the origin (`VITE_COLLECTOR_URL`
// empty -> relative `/api/v1/collect`). Read key matches the demo project.
const playgroundOk = run(
  "pnpm",
  ["--filter", "@uptimizr/example-playground", "exec", "vite", "build", "--base=/playground/"],
  {
    VITE_COLLECTOR_URL: "",
    VITE_PROJECT_ID: "demo",
    VITE_API_KEY: "demo-read-key",
    VITE_PROJECT_ID_WALKABLE: "demo",
    VITE_API_KEY_WALKABLE: "demo-read-key",
  },
);
if (!playgroundOk) console.warn("[demo] playground build failed");
stage(playgroundOut, playgroundDest, "Playground");

// --- Dashboard (Next static export) ------------------------------------------
// Served under `/dashboard/` (NEXT_BASE_PATH). No NEXT_PUBLIC_COLLECTOR_URL, so
// the dashboard targets the page origin, which the SW intercepts.
const dashboardOk = run("pnpm", ["--filter", "@uptimizr/dashboard", "exec", "next", "build"], {
  NODE_ENV: "production",
  DASHBOARD_STATIC: "1",
  NEXT_BASE_PATH: "/dashboard",
});
if (!dashboardOk) console.warn("[demo] dashboard build failed");
stage(dashboardOut, dashboardDest, "Dashboard");

if (!playgroundOk || !dashboardOk) {
  console.warn("[demo] one or more embeds failed to build; placeholders may be in use");
}
