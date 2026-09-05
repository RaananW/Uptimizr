#!/usr/bin/env node
// Guard against drift between the bridge **source of truth** shipped in
// `@uptimizr/unity` (`oss/packages/unity/bridge/`) and the copies this sample Unity
// project carries under `Assets/`. Unity needs the files inside the project tree
// (it compiles `Plugins/WebGL/*.jslib` into the export), so they are plain copies —
// this script fails `pnpm lint` when they diverge, and `--write` re-syncs them.
import { copyFileSync, readFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const projectDir = resolve(here, "..");
const repoRoot = resolve(projectDir, "../..");
const sourceDir = resolve(repoRoot, "oss/packages/unity/bridge");

/** [source in the package] → [copy in the Unity project]. */
const PAIRS = [
  ["Uptimizr.jslib", "Assets/Plugins/WebGL/Uptimizr.jslib"],
  ["UptimizrUnityBridge.cs", "Assets/Uptimizr/UptimizrUnityBridge.cs"],
];

const write = process.argv.includes("--write");
let drifted = 0;

for (const [sourceName, copyPath] of PAIRS) {
  const source = resolve(sourceDir, sourceName);
  const copy = resolve(projectDir, copyPath);
  const same = (() => {
    try {
      return readFileSync(source, "utf8") === readFileSync(copy, "utf8");
    } catch {
      return false;
    }
  })();
  if (same) continue;
  drifted++;
  if (write) {
    copyFileSync(source, copy);
    console.log(`synced ${relative(repoRoot, copy)} from ${relative(repoRoot, source)}`);
  } else {
    console.error(
      `bridge drift: ${relative(repoRoot, copy)} differs from ${relative(repoRoot, source)}`,
    );
  }
}

if (drifted && !write) {
  console.error(
    `\n${drifted} bridge file(s) out of sync. Run \`pnpm --filter @uptimizr/example-unity-web-export sync-bridge\` to re-copy from oss/packages/unity/bridge/.`,
  );
  process.exit(1);
}
console.log(
  drifted
    ? `re-synced ${drifted} bridge file(s).`
    : "bridge copies match oss/packages/unity/bridge/.",
);
