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
 * The release plan is assembled the way `changeset version` does it, from the
 * Changesets libraries the CLI ships with. Not through `changeset status`,
 * which first asks git what changed against the base branch and so fails in a
 * shallow CI checkout.
 *
 * Usage: node scripts/check-changesets.mjs
 */
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

// The libraries are the CLI's own dependencies, so resolve them from the CLI.
const fromRoot = createRequire(import.meta.url);
const fromCli = createRequire(fromRoot.resolve("@changesets/cli/package.json"));
const load = (id) => import(pathToFileURL(fromCli.resolve(id)).href);

const [{ getPackages }, { readConfig }, { readPreState }, { readChangesets }, assemble] =
  await Promise.all([
    load("@manypkg/get-packages"),
    load("@changesets/config"),
    load("@changesets/pre"),
    load("@changesets/read"),
    load("@changesets/assemble-release-plan"),
  ]);

const packages = await getPackages(process.cwd());
const { config, errors } = await readConfig(packages.rootDir, packages);
if (errors != null) {
  console.error(`.changeset/config.json is invalid:\n  ${errors.join("\n  ")}`);
  process.exit(1);
}
const preState = await readPreState(packages.rootDir);
const changesets = await readChangesets(packages.rootDir);
const plan = assemble.assembleReleasePlan(changesets, packages, config, preState);

const bumped = new Set(plan.releases.map((r) => r.name));
const stuck = [];
for (const changeset of changesets) {
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
console.log(`ok  ${changesets.length} pending changeset(s), all consumable`);
