#!/usr/bin/env node
//
// License-compliance gate for the public OSS repo (ADR / release runbook step 4a, issue #28).
//
// Walks the *production* dependency tree (via `pnpm licenses list --prod --json`)
// and fails if any dependency carries a license that is not on the permissive
// allowlist. Strong/network copyleft (GPL/AGPL) and unknown/UNLICENSED packages
// are rejected so we never ship something incompatible with Apache-2.0
// redistribution.
//
// Run locally:  node scripts/license-check.mjs
// CI:           pnpm license-check
//
import { execFileSync } from "node:child_process";

// SPDX identifiers we accept outright. All are permissive, or weak/file-level
// copyleft (MPL-2.0) that imposes no obligations on our own source, or
// font/data licenses used by assets.
const ALLOW = new Set([
  "0BSD",
  "Apache-2.0",
  "BSD-2-Clause",
  "BSD-3-Clause",
  "BlueOak-1.0.0",
  "CC-BY-4.0",
  "CC0-1.0",
  "ISC",
  "MIT",
  "MIT-0",
  "MPL-2.0",
  "OFL-1.1",
  "Python-2.0",
  "Unlicense",
  "WTFPL",
  "Zlib",
]);

// Per-package exceptions: licenses we would otherwise reject, accepted for a
// specific, justified package. Keep this list short and documented.
//   key: package name   value: human-readable justification
const EXCEPTIONS = new Map([
  [
    "@img/sharp-libvips-darwin-arm64",
    "LGPL-3.0-or-later — sharp's prebuilt libvips native binary, dynamically linked; no LGPL obligations triggered by use.",
  ],
  [
    "@img/sharp-libvips-darwin-x64",
    "LGPL-3.0-or-later — sharp's prebuilt libvips native binary (x64), dynamically linked.",
  ],
  [
    "@img/sharp-libvips-linux-x64",
    "LGPL-3.0-or-later — sharp's prebuilt libvips native binary (linux x64), dynamically linked.",
  ],
  [
    "@img/sharp-libvips-linux-arm64",
    "LGPL-3.0-or-later — sharp's prebuilt libvips native binary (linux arm64), dynamically linked.",
  ],
  [
    "@bruits/satteri-darwin-arm64",
    "MIT (github.com/bruits/satteri) — prebuilt native Markdown/MDX binary pulled in by astro; binary packages omit the license field.",
  ],
  [
    "@bruits/satteri-darwin-x64",
    "MIT (github.com/bruits/satteri) — prebuilt native Markdown/MDX binary pulled in by astro; binary packages omit the license field.",
  ],
  [
    "@bruits/satteri-linux-x64-gnu",
    "MIT (github.com/bruits/satteri) — prebuilt native Markdown/MDX binary pulled in by astro; binary packages omit the license field.",
  ],
  [
    "@bruits/satteri-linux-arm64-gnu",
    "MIT (github.com/bruits/satteri) — prebuilt native Markdown/MDX binary pulled in by astro; binary packages omit the license field.",
  ],
  [
    "@bruits/satteri-linux-x64-musl",
    "MIT (github.com/bruits/satteri) — prebuilt native Markdown/MDX binary pulled in by astro; binary packages omit the license field.",
  ],
  [
    "@bruits/satteri-linux-arm64-musl",
    "MIT (github.com/bruits/satteri) — prebuilt native Markdown/MDX binary pulled in by astro; binary packages omit the license field.",
  ],
  [
    "@bruits/satteri-win32-x64-msvc",
    "MIT (github.com/bruits/satteri) — prebuilt native Markdown/MDX binary pulled in by astro; binary packages omit the license field.",
  ],
  [
    "@bruits/satteri-win32-arm64-msvc",
    "MIT (github.com/bruits/satteri) — prebuilt native Markdown/MDX binary pulled in by astro; binary packages omit the license field.",
  ],
  [
    "@bruits/satteri-wasm32-wasi",
    "MIT (github.com/bruits/satteri) — prebuilt native Markdown/MDX binary pulled in by astro; binary packages omit the license field.",
  ],
]);

/**
 * A license string is allowed when it is a single allowed SPDX id, or an SPDX
 * "OR" expression where at least one alternative is allowed (we can pick that
 * one). "AND" expressions must have every part allowed.
 */
function isAllowedExpression(license) {
  if (!license) return false;
  const expr = license.replace(/[()]/g, " ").trim();
  if (ALLOW.has(expr)) return true;
  if (/\bOR\b/i.test(expr)) {
    return expr.split(/\bOR\b/i).some((p) => isAllowedExpression(p.trim()));
  }
  if (/\bAND\b/i.test(expr)) {
    return expr.split(/\bAND\b/i).every((p) => isAllowedExpression(p.trim()));
  }
  return ALLOW.has(expr);
}

function loadLicenses() {
  let raw;
  try {
    raw = execFileSync("pnpm", ["licenses", "list", "--prod", "--json"], {
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch (err) {
    // pnpm exits non-zero when it finds packages with missing license fields;
    // it still prints the JSON on stdout, so prefer that over bailing.
    raw = err.stdout?.toString() ?? "";
    if (!raw) {
      console.error("license-check: failed to run `pnpm licenses list`.");
      console.error(err.message);
      process.exit(2);
    }
  }
  return JSON.parse(raw);
}

function main() {
  const byLicense = loadLicenses();
  const violations = [];
  const exceptionsUsed = [];

  for (const [license, pkgs] of Object.entries(byLicense)) {
    if (isAllowedExpression(license)) continue;
    for (const pkg of pkgs) {
      if (EXCEPTIONS.has(pkg.name)) {
        exceptionsUsed.push(`${pkg.name} (${license})`);
        continue;
      }
      violations.push({
        name: pkg.name,
        versions: (pkg.versions ?? []).join(", "),
        license,
      });
    }
  }

  if (exceptionsUsed.length > 0) {
    console.log("license-check: accepted documented exceptions:");
    for (const e of exceptionsUsed) console.log(`  - ${e}`);
  }

  if (violations.length > 0) {
    console.error("\nERROR: license-check FAILED — disallowed licenses found:");
    for (const v of violations) {
      console.error(`  - ${v.name}@${v.versions}  =>  ${v.license}`);
    }
    console.error(
      "\nIf a license is acceptable, add the SPDX id to ALLOW or the package to " +
        "EXCEPTIONS in scripts/license-check.mjs with a justification.",
    );
    process.exit(1);
  }

  console.log("OK: license-check passed — all production dependencies are permissive-compatible.");
}

main();
