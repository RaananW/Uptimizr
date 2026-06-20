#!/usr/bin/env node
// Mint a fresh Uptimizr project + API key for a playground/scene.
//
//   pnpm playground:new "My Scene"
//   pnpm playground:new "My Scene" --endpoint http://localhost:4400
//
// Creates a distinct project (its own id + key), records it in the local,
// gitignored registry the dashboard reads (.uptimizr/projects.json), and prints
// a ready-to-paste Babylon Playground snippet pointing at that project. Run it as
// many times as you like — one project per playground keeps their stats separate.

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const envPath = join(repoRoot, ".env");
const registryPath = join(repoRoot, ".uptimizr", "projects.json");

const args = process.argv.slice(2);
const endpoint = (readFlag(args, "--endpoint") ?? "http://localhost:4400").replace(/\/$/, "");
const name = args
  .filter((a, i) => !a.startsWith("--") && args[i - 1] !== "--endpoint")
  .join(" ")
  .trim();

/** Read a `--flag value` style argument. */
function readFlag(argv, flag) {
  const i = argv.indexOf(flag);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : undefined;
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

/** Run the db CLI that creates the project, capturing its stdout JSON line. */
function createProject(projectName, childEnv) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      "pnpm",
      ["--filter", "@uptimizr/db", "run", "new-project", "--", projectName],
      { cwd: repoRoot, env: childEnv, stdio: ["ignore", "pipe", "inherit"] },
    );
    let out = "";
    child.stdout.on("data", (buf) => (out += String(buf)));
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code !== 0) return reject(new Error(`db new-project exited with code ${code}`));
      const line = out.trim().split("\n").filter(Boolean).pop();
      try {
        resolve(JSON.parse(line ?? ""));
      } catch {
        reject(new Error(`Could not parse project info from db CLI output:\n${out}`));
      }
    });
  });
}

async function main() {
  // The db client reads DATABASE_URL et al. from the environment; load the root
  // .env so this works the same way `pnpm db:seed` does.
  const childEnv = { ...process.env, ...parseEnvFile(envPath) };

  const {
    projectId,
    name: createdName,
    apiKey,
  } = await createProject(name || "Playground Project", childEnv);

  recordProject({ id: projectId, name: createdName, apiKey, createdAt: new Date().toISOString() });

  const snippet = [
    `const s = document.createElement("script");`,
    `s.src = "${endpoint}/uptimizr-babylon.global.js";`,
    `s.onload = () => {`,
    `  Uptimizr.trackScene(scene, {`,
    `    projectId: "${projectId}",`,
    `    endpoint: "${endpoint}",`,
    `    meta: { sceneId: ${JSON.stringify(createdName)} },`,
    `  });`,
    `};`,
    `document.head.appendChild(s);`,
  ].join("\n");

  console.log(`\n\x1b[1m✓ Project "${createdName}" ready\x1b[0m  (id ${projectId})`);
  console.log("\n Paste into your Babylon Playground scene, before `return scene;`:\n");
  console.log("\x1b[33m" + snippet + "\x1b[0m");
  console.log(
    `\n In the dashboard (\x1b[36mhttp://localhost:3000\x1b[0m), pick "\x1b[1m${createdName}\x1b[0m" from the Project dropdown.`,
  );
  console.log(` Recorded in \x1b[36m.uptimizr/projects.json\x1b[0m (gitignored).\n`);
}

main().catch((err) => {
  console.error(`\n\x1b[31m✗ ${err.message}\x1b[0m`);
  process.exitCode = 1;
});
