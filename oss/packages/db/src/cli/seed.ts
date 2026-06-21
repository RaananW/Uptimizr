import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createApiKey, createProject } from "../duckdb/projects.js";
import { createDuckdbClient } from "../duckdb/client.js";
import { migrateDuckdb } from "../duckdb/migrations.js";
import { readDbSettings } from "../env.js";

/**
 * Walk up from a starting directory until a directory containing
 * `pnpm-workspace.yaml` is found, i.e. the monorepo root. Returns `undefined`
 * if no such directory exists.
 */
function findRepoRoot(start: string): string | undefined {
  let dir = start;
  for (;;) {
    if (existsSync(join(dir, "pnpm-workspace.yaml"))) {
      return dir;
    }
    const parent = dirname(dir);
    if (parent === dir) {
      return undefined;
    }
    dir = parent;
  }
}

/**
 * Set (or append) a `KEY=value` line in a `.env` file body, preserving the rest
 * of the file. Only the first occurrence of the key is updated.
 */
function setEnvVar(body: string, key: string, value: string): string {
  const line = `${key}=${value}`;
  const pattern = new RegExp(`^${key}=.*$`, "m");
  if (pattern.test(body)) {
    return body.replace(pattern, line);
  }
  return body.endsWith("\n") || body === "" ? `${body}${line}\n` : `${body}\n${line}\n`;
}

/**
 * Write a set of `KEY=value` pairs into the root `.env` so the Babylon playground
 * and dashboard pick them up automatically. No-op (with a hint) when no `.env`
 * exists yet.
 */
function writeEnv(root: string, vars: Record<string, string>): void {
  const envPath = join(root, ".env");
  if (!existsSync(envPath)) {
    console.log(`  (no .env at ${envPath} — copy .env.example to .env to auto-fill these)`);
    return;
  }

  let body = readFileSync(envPath, "utf8");
  for (const [key, value] of Object.entries(vars)) {
    body = setEnvVar(body, key, value);
  }
  writeFileSync(envPath, body);

  console.log(`✓ wrote ${Object.keys(vars).join(", ")} to ${envPath}`);
}

/**
 * Scene metadata recorded alongside a project so the dashboard can render a
 * scene selector (one project per scene; the scene fixes the camera mode). Mirrors
 * the playground's `scenes.json` catalog shape for the built-in demo scenes.
 */
interface SceneMeta {
  id: string;
  label: string;
  description: string;
  cameraMode: "viewer" | "first-person";
  engines: string[];
  defaultEngine: string;
  builtin: boolean;
}

interface RegistryEntry {
  id: string;
  name: string;
  apiKey: string;
  createdAt: string;
  scene?: SceneMeta;
}

/** The four built-in demo scenes (kept in sync with `examples/playground/scenes.json`). */
const LOBBY_SCENE: SceneMeta = {
  id: "lobby",
  label: "Lobby (viewer)",
  description: "An orbit / arc-rotate camera framing a model — how people inspect an object.",
  cameraMode: "viewer",
  engines: ["babylon", "babylon-lite", "three", "playcanvas", "r3f", "aframe"],
  defaultEngine: "babylon",
  builtin: true,
};
const ATRIUM_SCENE: SceneMeta = {
  id: "atrium",
  label: "Atrium (first-person)",
  description:
    "A walkable scene traversed with WASD + look — where people walk and what they approach.",
  cameraMode: "first-person",
  engines: ["babylon", "three", "playcanvas"],
  defaultEngine: "babylon",
  builtin: true,
};
const SHOWCASE_SCENE: SceneMeta = {
  id: "showcase",
  label: "Showcase (real glTF viewer)",
  description:
    "An orbit camera framing a real glTF model (Khronos ToyCar) — inspecting a detailed PBR asset.",
  cameraMode: "viewer",
  engines: ["babylon", "three", "playcanvas"],
  defaultEngine: "babylon",
  builtin: false,
};
const GALLERY_SCENE: SceneMeta = {
  id: "gallery",
  label: "Gallery (walkable real models)",
  description:
    "A first-person walkable room with real glTF models (Khronos ToyCar, Fox, GlamVelvetSofa) on pedestals — walk up and inspect or pick the exhibits.",
  cameraMode: "first-person",
  engines: ["babylon", "three", "playcanvas"],
  defaultEngine: "babylon",
  builtin: false,
};

/**
 * Upsert project entries into the local, gitignored registry the dashboard reads
 * (`.uptimizr/projects.json`) so its project picker lists the seeded projects on
 * first run without ever calling the collector.
 */
function writeRegistry(root: string, entries: RegistryEntry[]): void {
  const registryPath = join(root, ".uptimizr", "projects.json");
  mkdirSync(dirname(registryPath), { recursive: true });
  let list: RegistryEntry[] = [];
  if (existsSync(registryPath)) {
    try {
      const parsed: unknown = JSON.parse(readFileSync(registryPath, "utf8"));
      if (Array.isArray(parsed)) list = parsed as RegistryEntry[];
    } catch {
      list = [];
    }
  }
  const ids = new Set(entries.map((e) => e.id));
  // Also drop any prior entry bound to the same scene id, so re-seeding replaces a
  // scene's project binding instead of stacking a duplicate card in the dashboard.
  const sceneIds = new Set(
    entries.map((e) => e.scene?.id).filter((s): s is string => typeof s === "string"),
  );
  const next = [
    ...list.filter(
      (p) => p && !ids.has(p.id) && !(p.scene?.id != null && sceneIds.has(p.scene.id)),
    ),
    ...entries,
  ];
  writeFileSync(registryPath, `${JSON.stringify(next, null, 2)}\n`);

  console.log(`✓ recorded ${entries.length} project(s) in ${registryPath}`);
}

/**
 * Seed the demo projects — a **viewer** (arc-rotate) and a **walkable**
 * (first-person) project for the built-in lobby/atrium scenes, plus a
 * **showcase** and **gallery** project for the real-glTF demo scenes — and issue
 * an API key for each. One project per scene mirrors how a real deployment keeps
 * distinct experiences separate, and lets the playground route each scene's
 * sessions to its own project (ADR 0026). Keys are printed once (stored only as
 * hashes). Run via `pnpm --filter @uptimizr/db seed -- "My Project"`.
 */
async function main(): Promise<void> {
  const args = process.argv.slice(2).filter((arg) => arg !== "--");
  const baseName = args[0] ?? "Demo Project";
  const db = await createDuckdbClient(readDbSettings().duckdb.path);
  await migrateDuckdb(db);

  const viewer = await createProject(db, `${baseName} (Viewer)`);
  const viewerKey = (await createApiKey(db, viewer.id)).key;
  const walkable = await createProject(db, `${baseName} (Walkable)`);
  const walkableKey = (await createApiKey(db, walkable.id)).key;
  const showcase = await createProject(db, `${baseName} (Showcase)`);
  const showcaseKey = (await createApiKey(db, showcase.id)).key;
  const gallery = await createProject(db, `${baseName} (Gallery)`);
  const galleryKey = (await createApiKey(db, gallery.id)).key;
  await db.close();

  console.log(`✓ project created: ${viewer.id} (${viewer.name})`);
  console.log(`  API key (store securely, shown once): ${viewerKey}`);
  console.log(`✓ project created: ${walkable.id} (${walkable.name})`);
  console.log(`  API key (store securely, shown once): ${walkableKey}`);
  console.log(`✓ project created: ${showcase.id} (${showcase.name})`);
  console.log(`  API key (store securely, shown once): ${showcaseKey}`);
  console.log(`✓ project created: ${gallery.id} (${gallery.name})`);
  console.log(`  API key (store securely, shown once): ${galleryKey}`);

  const root = findRepoRoot(process.cwd());
  if (!root) return;
  const createdAt = new Date().toISOString();
  writeEnv(root, {
    VITE_PROJECT_ID: viewer.id,
    VITE_API_KEY: viewerKey,
    NEXT_PUBLIC_API_KEY: viewerKey,
    VITE_PROJECT_ID_WALKABLE: walkable.id,
    VITE_API_KEY_WALKABLE: walkableKey,
  });
  writeRegistry(root, [
    { id: viewer.id, name: viewer.name, apiKey: viewerKey, createdAt, scene: LOBBY_SCENE },
    { id: walkable.id, name: walkable.name, apiKey: walkableKey, createdAt, scene: ATRIUM_SCENE },
    { id: showcase.id, name: showcase.name, apiKey: showcaseKey, createdAt, scene: SHOWCASE_SCENE },
    { id: gallery.id, name: gallery.name, apiKey: galleryKey, createdAt, scene: GALLERY_SCENE },
  ]);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
