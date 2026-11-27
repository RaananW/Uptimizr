#!/usr/bin/env node
/**
 * Fail when a pending changeset names a package that `changeset version` will
 * not bump.
 *
 * Such a changeset is never consumed: the version PR leaves it in `.changeset/`,
 * and the Release workflow, which refuses to publish while any changeset is
 * pending, then skips every release after it. This happened when Changesets 3
 * stopped versioning private packages by default and a changeset named only the
 * private `@uptimizr/demo` (fixed with `privatePackages.version` in
 * `.changeset/config.json`). The same would happen for an ignored or misspelled
 * package name.
 *
 * Usage: node scripts/check-changesets.mjs
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

// Run the Changesets CLI with this Node directly: no shell, on any platform.
const require = createRequire(import.meta.url);
const cliManifest = require.resolve("@changesets/cli/package.json");
const cliBin = require(cliManifest).bin;
const cli = join(dirname(cliManifest), typeof cliBin === "string" ? cliBin : cliBin.changeset);

const dir = mkdtempSync(join(tmpdir(), "changeset-status-"));
const out = join(dir, "status.json");
try {
  execFileSync(process.execPath, [cli, "status", `--output=${out}`], {
    stdio: ["ignore", "ignore", "inherit"],
  });
  const status = JSON.parse(readFileSync(out, "utf8"));
  const bumped = new Set(status.releases.map((r) => r.name));
  const stuck = [];
  for (const changeset of status.changesets) {
    for (const release of changeset.releases) {
      if (!bumped.has(release.name)) stuck.push(`.changeset/${changeset.id}.md → ${release.name}`);
    }
  }
  if (stuck.length > 0) {
    console.error(
      "These changesets name a package that `changeset version` will not bump, so they would " +
        "never be consumed and would block every release:\n  " +
        stuck.join("\n  ") +
        "\nCheck the package name, `ignore`, and `privatePackages` in .changeset/config.json.",
    );
    process.exit(1);
  }
  console.log(`ok  ${status.changesets.length} pending changeset(s), all consumable`);
} finally {
  rmSync(dir, { recursive: true, force: true });
}
