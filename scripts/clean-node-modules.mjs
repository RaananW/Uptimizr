#!/usr/bin/env node
//
// Removes the root `node_modules/` tree (issue #284).
//
// Deliberately dependency-free rather than `rimraf node_modules`: on Windows the
// package runner executes `node_modules/.bin/rimraf.CMD`, and cmd.exe keeps that
// batch file open for the lifetime of the script — so rimraf cannot delete the
// directory it is running out of. A plain Node script under `scripts/` lives
// outside the tree it deletes, so it works on every platform.
//
// Usage:  node scripts/clean-node-modules.mjs
//
import { rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

rmSync(join(repoRoot, "node_modules"), { recursive: true, force: true });
