#!/usr/bin/env node
/**
 * Guard against the sample Godot project forking the engine-side shim.
 *
 * `examples/godot-web-export/uptimizr/UptimizrGodot.gd` is a byte-for-byte copy of
 * `oss/packages/godot/bridge/UptimizrGodot.gd` (Godot can only load scripts from
 * inside the project, so a copy is unavoidable). This script fails when the two
 * drift; `--fix` re-copies the package source over the sample.
 *
 *   pnpm godot:check-bridge          # verify (CI)
 *   pnpm godot:check-bridge --fix    # re-sync after editing the package shim
 */
import { copyFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

import { BRIDGE_COPY, BRIDGE_SOURCE, bridgeCopyDrift } from "./godot-common.mjs";

const fix = process.argv.includes("--fix");
const drift = bridgeCopyDrift();

if (!drift) {
  console.log("[godot-check-bridge] OK — sample project shim matches the package source.");
  process.exit(0);
}

if (fix) {
  mkdirSync(dirname(BRIDGE_COPY), { recursive: true });
  copyFileSync(BRIDGE_SOURCE, BRIDGE_COPY);
  console.log(`[godot-check-bridge] re-copied ${BRIDGE_SOURCE} → ${BRIDGE_COPY}`);
  process.exit(0);
}

console.error(`[godot-check-bridge] ${drift}`);
process.exit(1);
