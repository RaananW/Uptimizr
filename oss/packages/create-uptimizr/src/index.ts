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
  withDashboard?: boolean;
  withDemo?: boolean;
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
    else if (a === "--dashboard") args.withDashboard = true;
    else if (a === "--no-dashboard") args.withDashboard = false;
    else if (a === "--demo") args.withDemo = true;
    else if (a === "--no-demo") args.withDemo = false;
    else if (a === "--full") {
      args.withDashboard = true;
      args.withDemo = true;
    } else if (a === "--minimal") {
      args.withDashboard = false;
      args.withDemo = false;
    } else if (!a.startsWith("-") && args.targetDir === undefined) args.targetDir = a;
  }
  return args;
}

function usage(): string {
  return [
    "create-uptimizr — scaffold a Docker-free self-host of the Uptimizr collector.",
    "",
    "Usage:",
    "  npm create uptimizr@latest [dir] -- [options]",
    "",
    "Options:",
    "  --engine <e>     Client connector to emit a snippet for.",
    "  --name <name>    Human-readable project name.",
    "  --port <n>       Collector port (default 4318).",
    "  --dashboard      Include the analytics dashboard (@uptimizr/dashboard).",
    "  --demo           Include a runnable Babylon demo scene.",
    "  --full           Full suite: collector + dashboard + demo.",
    "  --minimal        Collector only (skip the prompts).",
    "",
    `Engines: ${ENGINES.join(", ")}`,
    "",
    "Examples:",
    "  npm create uptimizr@latest my-analytics",
    '  npm create uptimizr@latest my-analytics -- --engine three --name "My Game"',
    "  npm create uptimizr@latest my-analytics -- --full",
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
  let withDashboard = args.withDashboard;
  let withDemo = args.withDemo;
  const interactive = process.stdin.isTTY === true && process.stdout.isTTY === true;

  if (
    (!targetDir || !isEngine(engine) || withDashboard === undefined || withDemo === undefined) &&
    interactive
  ) {
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
      if (withDashboard === undefined) {
        const answer = (
          await rl.question("Include the analytics dashboard (full suite)? (y/N): ")
        ).trim();
        withDashboard = /^y(es)?$/i.test(answer);
      }
      if (withDemo === undefined) {
        const answer = (
          await rl.question("Include a runnable demo scene to test end-to-end? (y/N): ")
        ).trim();
        withDemo = /^y(es)?$/i.test(answer);
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
      ...(withDashboard ? { withDashboard: true } : {}),
      ...(withDemo ? { withDemo: true } : {}),
    });
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }

  const extras = [result.withDashboard ? "dashboard" : "", result.withDemo ? "demo" : ""].filter(
    Boolean,
  );
  const suffix = extras.length > 0 ? ` + ${extras.join(" + ")}` : "";
  console.log(`\n✓ Scaffolded ${result.folderName} (${engine}${suffix}) in ${result.dir}`);
  console.log("\nNext steps:");
  console.log(`  cd ${targetDir}`);
  console.log("  npm install");
  console.log("  npm run setup     # mints your first project + API key");
  console.log("  npm start         # ingestion + query API");
  if (result.withDemo) {
    console.log("  npm run demo      # demo scene — paste the projectId, then interact");
  }
  if (result.withDashboard) {
    console.log("  npm run dashboard # analytics UI — point it at the collector");
  }
  console.log("");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
