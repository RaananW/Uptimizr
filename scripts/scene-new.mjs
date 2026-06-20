#!/usr/bin/env node
// Add a new playground scene end-to-end:
//
//   pnpm scene:new "Showroom"
//   pnpm scene:new "Showroom" --engines babylon,three --camera viewer
//   pnpm scene:new "Office" --camera first-person --engines babylon,three
//
// This mints a dedicated collector project (one project per scene), appends the
// scene to the committed catalog (examples/playground/scenes.json), records the
// scene→project binding in the local gitignored registry (.uptimizr/projects.json,
// read by the dashboard + the playground's Vite virtual module), and scaffolds a
// per-engine builder stub under examples/playground/src/scenes/<id>/<engine>.{ts,tsx}.
//
// The scaffolded builders initially re-export the built-in engine demo so analytics
// flow immediately — edit them to build your own geometry.

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const envPath = join(repoRoot, ".env");
const registryPath = join(repoRoot, ".uptimizr", "projects.json");
const playgroundRoot = join(repoRoot, "examples", "playground");
const catalogPath = join(playgroundRoot, "scenes.json");
const scenesDir = join(playgroundRoot, "src", "scenes");

const KNOWN_ENGINES = new Set(["babylon", "babylon-lite", "three", "playcanvas", "r3f", "aframe"]);
// Engines capable of the first-person (walkable) camera model (mirrors the catalog).
const WALKABLE_ENGINES = new Set(["babylon", "three", "playcanvas"]);

const args = process.argv.slice(2);
const endpoint = (readFlag(args, "--endpoint") ?? "http://localhost:4400").replace(/\/$/, "");
const cameraMode = readFlag(args, "--camera") ?? "viewer";
const enginesArg = readFlag(args, "--engines") ?? "babylon";
const name = positional(args).join(" ").trim();

/** Read a `--flag value` style argument. */
function readFlag(argv, flag) {
  const i = argv.indexOf(flag);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : undefined;
}

/** Positional args (everything that isn't a `--flag` or a flag's value). */
function positional(argv) {
  const out = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      i++; // skip the flag's value
      continue;
    }
    out.push(a);
  }
  return out;
}

/** Slugify a scene name into a stable scene id (a-z0-9 + hyphens). */
function slugify(value) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
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

/** Read + parse a JSON file, returning a fallback when missing/invalid. */
function readJson(file, fallback) {
  if (!existsSync(file)) return fallback;
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

/** Append a scene to the committed catalog (examples/playground/scenes.json). */
function appendCatalogEntry(entry) {
  const list = readJson(catalogPath, []);
  const scenes = Array.isArray(list) ? list : [];
  if (scenes.some((s) => s && s.id === entry.id)) {
    throw new Error(`A scene with id "${entry.id}" already exists in scenes.json.`);
  }
  scenes.push(entry);
  writeFileSync(catalogPath, `${JSON.stringify(scenes, null, 2)}\n`);
}

/** Upsert a project entry (with scene metadata) into the local registry. */
function recordProject(entry) {
  mkdirSync(dirname(registryPath), { recursive: true });
  const parsed = readJson(registryPath, []);
  const list = Array.isArray(parsed) ? parsed : [];
  const next = [...list.filter((p) => p && p.id !== entry.id), entry];
  writeFileSync(registryPath, `${JSON.stringify(next, null, 2)}\n`);
}

/** Scaffold a per-engine builder stub that re-exports the built-in engine demo. */
function scaffoldEngineStub(sceneId, sceneLabel, engineId) {
  const isReact = engineId === "r3f";
  const ext = isReact ? "tsx" : "ts";
  const dir = join(scenesDir, sceneId);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${engineId}.${ext}`);
  if (existsSync(file)) return file; // never clobber an authored builder
  const body = [
    `// Scaffolded scene builder: "${sceneLabel}" on ${engineId}.`,
    `//`,
    `// It currently re-exports the built-in ${engineId} demo so analytics flow for this`,
    `// scene immediately. Replace the re-export with your own \`EngineModule\` to build`,
    `// custom geometry — keep the \`mount(ctx)\` contract from \`src/engine.ts\` and report`,
    `// \`ctx.sceneId\` on every event.`,
    `export { engine } from "../../engines/${engineId}.js";`,
    ``,
  ].join("\n");
  writeFileSync(file, body);
  return file;
}

async function main() {
  if (!name) {
    throw new Error('Scene name is required, e.g. `pnpm scene:new "Showroom"`.');
  }
  if (cameraMode !== "viewer" && cameraMode !== "first-person") {
    throw new Error(`--camera must be "viewer" or "first-person" (got "${cameraMode}").`);
  }
  const engines = enginesArg
    .split(",")
    .map((e) => e.trim())
    .filter(Boolean);
  if (engines.length === 0) throw new Error("At least one engine is required (--engines).");
  for (const e of engines) {
    if (!KNOWN_ENGINES.has(e)) {
      throw new Error(`Unknown engine "${e}". Known: ${[...KNOWN_ENGINES].join(", ")}.`);
    }
    if (cameraMode === "first-person" && !WALKABLE_ENGINES.has(e)) {
      throw new Error(
        `Engine "${e}" has no first-person (walkable) support. Walkable engines: ${[
          ...WALKABLE_ENGINES,
        ].join(", ")}.`,
      );
    }
  }

  const sceneId = slugify(name);
  if (!sceneId) throw new Error(`Could not derive a scene id from "${name}".`);

  // The db client reads DATABASE_URL et al. from the environment; load the root
  // .env so this works the same way `pnpm db:seed` does.
  const childEnv = { ...process.env, ...parseEnvFile(envPath) };
  const { projectId, name: createdName, apiKey } = await createProject(name, childEnv);

  const sceneMeta = {
    id: sceneId,
    label: name,
    description: `Custom scene "${name}" (${cameraMode}).`,
    cameraMode,
    engines,
    defaultEngine: engines[0],
    builtin: false,
  };

  appendCatalogEntry(sceneMeta);
  recordProject({
    id: projectId,
    name: createdName,
    apiKey,
    createdAt: new Date().toISOString(),
    scene: sceneMeta,
  });

  const scaffolded = engines.map((e) => scaffoldEngineStub(sceneId, name, e));

  console.log(`\n\x1b[1m✓ Scene "${name}" added\x1b[0m  (id ${sceneId}, project ${projectId})`);
  console.log(`\n Catalog:   \x1b[36mexamples/playground/scenes.json\x1b[0m`);
  console.log(` Builders:  ${scaffolded.map((f) => f.replace(`${repoRoot}/`, "")).join(", ")}`);
  console.log(` Registry:  \x1b[36m.uptimizr/projects.json\x1b[0m (gitignored)`);
  console.log(
    `\n Open it: \x1b[36mhttp://localhost:5173/?scene=${sceneId}&engine=${engines[0]}\x1b[0m`,
  );
  console.log(
    ` It also appears in the dashboard scene selector (\x1b[36mhttp://localhost:3000\x1b[0m).\n`,
  );
}

main().catch((err) => {
  console.error(`\n\x1b[31m✗ ${err.message}\x1b[0m`);
  process.exitCode = 1;
});
