import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  type Engine,
  renderClientSnippet,
  renderEnv,
  renderGitignore,
  renderPackageJson,
  renderReadme,
} from "./templates.js";

export interface ScaffoldOptions {
  /** Absolute or relative path to the folder to create. */
  targetDir: string;
  /** Human-readable project name (defaults to the folder name). */
  projectName?: string;
  /** Engine to emit a client snippet for. */
  engine: Engine;
  /** Collector port baked into config/snippets. Default 4318. */
  port?: number;
  /** Pre-supplied secret (tests); a strong one is generated when omitted. */
  secret?: string;
}

export interface ScaffoldResult {
  dir: string;
  folderName: string;
  projectName: string;
  files: string[];
}

/** npm package-name rules, applied to the folder name for the generated `package.json`. */
function sanitizeName(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9-~]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 214) || "uptimizr-analytics"
  );
}

/**
 * Generate a ready-to-run, Docker-free self-host folder. Writes files only;
 * the folder is operated via the `uptimizr` CLI (the scaffolder never
 * reimplements collector logic).
 */
export function scaffold(options: ScaffoldOptions): ScaffoldResult {
  const dir = resolve(options.targetDir);
  if (existsSync(dir) && readdirSync(dir).length > 0) {
    throw new Error(`Target directory is not empty: ${dir}`);
  }

  const folderName = sanitizeName(dir.split(/[/\\]/).pop() ?? "uptimizr-analytics");
  const projectName = options.projectName?.trim() || folderName;
  const port = options.port ?? 4318;
  const secret = options.secret ?? randomBytes(32).toString("hex");

  mkdirSync(join(dir, "data"), { recursive: true });

  const files: Array<[string, string]> = [
    ["package.json", renderPackageJson(folderName, projectName)],
    [".env", renderEnv(secret, port)],
    [".gitignore", renderGitignore()],
    ["README.md", renderReadme(folderName, projectName, options.engine, port)],
    [`client-snippet.${options.engine}.ts`, renderClientSnippet(options.engine, port)],
    // Keep the (git-ignored) data dir in the tree so the store path exists.
    ["data/.gitkeep", ""],
  ];

  for (const [rel, content] of files) {
    writeFileSync(join(dir, rel), content);
  }

  return { dir, folderName, projectName, files: files.map(([rel]) => rel) };
}
