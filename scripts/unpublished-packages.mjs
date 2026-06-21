// Lists publishable packages whose local version is not yet on the npm registry.
//
// Used by the Release workflow's `decide` job to tell a "Version Packages PR was
// just merged" commit (something to publish) apart from an ordinary push to main
// (nothing to publish) — so the npm-production approval gate only fires for real
// releases.
//
// Mirrors the publish filter: workspace packages that are not `private` and not
// the manually-released, unscoped `create-uptimizr`. Prints one `name@version`
// per unpublished package to stdout; prints nothing when everything is current.
//
// Conservative on uncertainty: only an explicit 404 (package/version absent)
// counts as unpublished. Network/other errors are treated as published so a
// transient blip never triggers a spurious release.

import { readFileSync, readdirSync, existsSync } from "node:fs";

const ROOTS = ["oss/packages", "oss/apps"];
const SKIP = new Set(["create-uptimizr"]);

async function isPublished(name, version) {
  try {
    const res = await fetch(`https://registry.npmjs.org/${name}`, {
      headers: { accept: "application/json" },
    });
    if (res.status === 404) return false;
    if (!res.ok) return true; // unknown → assume published (don't trigger release)
    const data = await res.json();
    return Boolean(data.versions && data.versions[version]);
  } catch {
    return true; // network error → assume published
  }
}

const unpublished = [];

for (const root of ROOTS) {
  if (!existsSync(root)) continue;
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const pkgPath = `${root}/${entry.name}/package.json`;
    if (!existsSync(pkgPath)) continue;

    const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
    if (!pkg.name || pkg.private || SKIP.has(pkg.name)) continue;

    if (!(await isPublished(pkg.name, pkg.version))) {
      unpublished.push(`${pkg.name}@${pkg.version}`);
    }
  }
}

if (unpublished.length > 0) console.log(unpublished.join("\n"));
