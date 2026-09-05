#!/usr/bin/env node
/**
 * Export the Godot sample project (`examples/godot-web-export`) for the Web,
 * headlessly, into `examples/godot-web-export/dist/` (gitignored).
 *
 *   pnpm godot:fetch     # once: editor + web template (see godot-fetch.mjs)
 *   pnpm godot:export    # this script
 *
 * Steps:
 *   1. refuse to run if the sample's copy of `UptimizrGodot.gd` drifted from the
 *      package source (the sample must exercise the shipped shim, not a fork);
 *   2. `godot --headless --import` to build the project's `.godot/` import cache
 *      (a fresh checkout has none, and the exporter needs it);
 *   3. `godot --headless --export-release Web <dist>/index.html`.
 *
 * The Web preset uses `variant/thread_support=false`, so the export is built from
 * `web_nothreads_release.zip` and runs without SharedArrayBuffer — no COOP/COEP
 * headers needed on the host page.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, statSync } from "node:fs";
import { join } from "node:path";

import {
  GODOT_VERSION,
  SAMPLE_EXPORT_DIR,
  SAMPLE_EXPORT_PRESET,
  SAMPLE_PROJECT_DIR,
  bridgeCopyDrift,
  godotEditorPath,
  godotTemplatesDir,
} from "./godot-common.mjs";

/** Files the Playwright harness needs; their presence is the "export succeeded" signal. */
const EXPECTED_OUTPUTS = ["index.html", "index.js", "index.wasm", "index.pck"];

/**
 * Godot exits 0 even when a script fails to compile (it just packs the broken
 * script and, for an autoload, never instantiates it). The bridged tier would then
 * fail only much later in Playwright as "no camera_sample", so treat a GDScript
 * parse/compile error during import or export as a hard failure here.
 */
const SCRIPT_ERROR = /SCRIPT ERROR:|Failed to load script|Failed to create an autoload/;

function run(godot, args, label) {
  console.log(`[godot-export] ${label}: ${godot} ${args.join(" ")}`);
  const res = spawnSync(godot, args, {
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf8",
    timeout: 10 * 60 * 1000,
    env: { ...process.env },
  });
  if (res.stdout) process.stdout.write(res.stdout);
  if (res.stderr) process.stderr.write(res.stderr);
  if (res.error) throw new Error(`${label} failed to start: ${res.error.message}`);
  if (res.status !== 0) {
    throw new Error(`${label} exited with ${res.status ?? `signal ${res.signal}`}`);
  }
  if (SCRIPT_ERROR.test(`${res.stdout}\n${res.stderr}`)) {
    throw new Error(`${label}: Godot reported a script error (see output above)`);
  }
}

function main() {
  const drift = bridgeCopyDrift();
  if (drift) throw new Error(drift);

  const godot = godotEditorPath();
  if (!existsSync(godot)) {
    throw new Error(
      `Godot ${GODOT_VERSION} editor not found at ${godot} — run 'pnpm godot:fetch' first ` +
        `(or set GODOT_BIN to an existing Godot ${GODOT_VERSION} binary).`,
    );
  }
  const templates = godotTemplatesDir();
  if (!existsSync(join(templates, "web_nothreads_release.zip"))) {
    throw new Error(
      `web_nothreads_release.zip not found in ${templates} — run 'pnpm godot:fetch'.`,
    );
  }

  mkdirSync(SAMPLE_EXPORT_DIR, { recursive: true });
  const outFile = join(SAMPLE_EXPORT_DIR, "index.html");

  // A fresh checkout has no `.godot/` cache; import first so the exporter sees every
  // resource (and Godot 4.4+ can generate the `.uid` sidecars for scripts).
  run(godot, ["--headless", "--path", SAMPLE_PROJECT_DIR, "--import"], "import");
  run(
    godot,
    ["--headless", "--path", SAMPLE_PROJECT_DIR, "--export-release", SAMPLE_EXPORT_PRESET, outFile],
    "export",
  );

  const missing = EXPECTED_OUTPUTS.filter((f) => !existsSync(join(SAMPLE_EXPORT_DIR, f)));
  if (missing.length > 0) {
    throw new Error(`export produced no ${missing.join(", ")} in ${SAMPLE_EXPORT_DIR}`);
  }
  for (const f of EXPECTED_OUTPUTS) {
    const size = statSync(join(SAMPLE_EXPORT_DIR, f)).size;
    console.log(`[godot-export]   ${f}: ${(size / 1024 / 1024).toFixed(2)} MB`);
  }
  console.log(`[godot-export] OK — exported to ${SAMPLE_EXPORT_DIR}`);
}

try {
  main();
} catch (err) {
  console.error(`[godot-export] ${err?.message ?? err}`);
  process.exit(1);
}
