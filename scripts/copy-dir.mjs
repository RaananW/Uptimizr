#!/usr/bin/env node
//
// Cross-platform recursive directory copy (issue #284).
//
// Replaces the `rm -rf <dest> && cp -r <src> <dest>` pair that only ran under a
// POSIX shell, so `pnpm build:site` works from cmd.exe / PowerShell too. The
// destination is removed first, making the copy a mirror rather than a merge —
// stale files from a previous build never survive into the new one.
//
// Usage:  node scripts/copy-dir.mjs <src> <dest>
//
import { cpSync, existsSync, rmSync, statSync } from "node:fs";

const [src, dest] = process.argv.slice(2);

if (!src || !dest) {
  console.error("Usage: node scripts/copy-dir.mjs <src> <dest>");
  process.exit(1);
}

if (!existsSync(src) || !statSync(src).isDirectory()) {
  console.error(`copy-dir: source directory not found: ${src}`);
  process.exit(1);
}

rmSync(dest, { recursive: true, force: true });
cpSync(src, dest, { recursive: true });
