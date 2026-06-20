#!/usr/bin/env node
// `create-uptimizr` — `npm create uptimizr@latest` scaffolds a Docker-free,
// single-file (DuckDB) self-host of the OSS collector. It writes files and
// operates the project via the `uptimizr` CLI; it never reimplements collector
// logic.
import { createInterface } from "node:readline/promises";
import { scaffold } from "./scaffold.js";
import { ENGINES, type Engine } from "./templates.js";

interface CliArgs {
  targetDir?: string;
  projectName?: string;
  engine?: Engine;
  port?: number;
  help: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = { help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === undefined) continue;
    if (a === "--help" || a === "-h") args.help = true;
    else if (a === "--engine") args.engine = argv[++i] as Engine;
    else if (a === "--name") args.projectName = argv[++i];
    else if (a === "--port") args.port = Number(argv[++i]);
    else if (!a.startsWith("-") && args.targetDir === undefined) args.targetDir = a;
  }
  return args;
}

function usage(): string {
  return [
    "create-uptimizr — scaffold a Docker-free self-host of the Uptimizr collector.",
    "",
    "Usage:",
    "  npm create uptimizr@latest [dir] -- [--engine <e>] [--name <name>] [--port <n>]",
    "",
    `Engines: ${ENGINES.join(", ")}`,
    "",
    "Examples:",
    "  npm create uptimizr@latest my-analytics",
    '  npm create uptimizr@latest my-analytics -- --engine three --name "My Game"',
  ].join("\n");
}

function isEngine(value: string | undefined): value is Engine {
  return value !== undefined && (ENGINES as readonly string[]).includes(value);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(usage());
    return;
  }

  let targetDir = args.targetDir;
  let engine = args.engine;
  const interactive = process.stdin.isTTY === true && process.stdout.isTTY === true;

  if ((!targetDir || !isEngine(engine)) && interactive) {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    try {
      if (!targetDir) {
        const answer = (await rl.question("Project folder [uptimizr-analytics]: ")).trim();
        targetDir = answer || "uptimizr-analytics";
      }
      if (!isEngine(engine)) {
        const answer = (await rl.question(`Engine (${ENGINES.join(" / ")}) [babylon]: `)).trim();
        engine = isEngine(answer) ? answer : "babylon";
      }
    } finally {
      rl.close();
    }
  }

  targetDir = targetDir ?? "uptimizr-analytics";
  if (!isEngine(engine)) {
    if (engine !== undefined) {
      console.error(`Unknown engine "${engine}". Expected one of: ${ENGINES.join(", ")}`);
      process.exit(1);
    }
    engine = "babylon";
  }

  let result;
  try {
    result = scaffold({
      targetDir,
      engine,
      ...(args.projectName ? { projectName: args.projectName } : {}),
      ...(args.port ? { port: args.port } : {}),
    });
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }

  console.log(`\n✓ Scaffolded ${result.folderName} (${engine}) in ${result.dir}`);
  console.log("\nNext steps:");
  console.log(`  cd ${targetDir}`);
  console.log("  npm install");
  console.log("  npm run setup     # mints your first project + API key");
  console.log("  npm start         # ingestion + query API\n");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
