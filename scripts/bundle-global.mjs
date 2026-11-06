#!/usr/bin/env node
//
// Build a connector's standalone IIFE bundle (`dist/*.global.js`) for a page with no
// bundler. esbuild's `--external` cannot do this: an IIFE has no module loader, so
// every value import of the engine becomes a `require()` that throws at load, and
// `window.Uptimizr` is never defined.
//
// This helper instead resolves the engine to a generated shim bound to a browser
// global. Members are looked up each time they are used, not at load, so the bundle
// always loads, script order does not matter, and the page may set the global later.
// Classes come back as the engine's own, so `new`, `instanceof` and statics just work.
// The engine itself is never bundled.
//
// Usage (from a package directory):
//   node ../../../scripts/bundle-global.mjs <entry> --engine=<id> --global-name=<name> \
//     --banner=<text> --outfile=<path> [--external=<module>...]
//
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { parseArgs } from "node:util";

// esbuild is a dev dependency of each connector package, not of the repo root.
const esbuild = createRequire(resolve("package.json"))("esbuild");

/**
 * How each engine is found at runtime. `optional` lists members that may legitimately
 * be missing from a global that is otherwise present (the connectors treat an unknown
 * version as "not recorded"). With no global at all, every member throws: that read
 * of the version is also what makes `trackScene` fail before the session starts,
 * since `UptimizrClient` logs and swallows errors thrown inside a collector.
 */
const ENGINES = {
  three: {
    title: "three.js",
    label: "window.THREE",
    lookup: "globalThis.THREE ?? globalThis.AFRAME?.THREE",
    optional: ["REVISION"],
    recipe:
      "On a module page, use the ESM bundle uptimizr-three.js with an import map instead: it " +
      "needs no global. See https://www.uptimizr.com/docs/connectors/cdn/",
  },
  playcanvas: {
    title: "PlayCanvas",
    label: "window.pc",
    lookup: "globalThis.pc",
    optional: ["version"],
    recipe:
      "Load the classic playcanvas.min.js script first. On a module page, use the ESM bundle " +
      "uptimizr-playcanvas.js with an import map instead: it needs no global. See https://www.uptimizr.com/docs/connectors/cdn/",
  },
  "@babylonjs/lite": {
    title: "Babylon Lite",
    label: "window.BabylonLite",
    lookup: "globalThis.BabylonLite",
    optional: ["VERSION"],
    recipe:
      "Lite is ESM-only, so use the ESM bundle uptimizr-babylon-lite.js with an import map " +
      "instead: it needs no global. See https://www.uptimizr.com/docs/connectors/cdn/",
  },
};

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    engine: { type: "string" },
    external: { type: "string", multiple: true, default: [] },
    "global-name": { type: "string" },
    banner: { type: "string" },
    outfile: { type: "string" },
  },
});

const [entry] = positionals;
const engineId = values.engine;
const engine = ENGINES[engineId];
if (!entry || !engine || !values["global-name"] || !values.banner || !values.outfile) {
  console.error(
    "Usage: node scripts/bundle-global.mjs <entry> --engine=<id> --global-name=<name> " +
      "--banner=<text> --outfile=<path> [--external=<module>...]\n" +
      `Known engines: ${Object.keys(ENGINES).join(", ")}`,
  );
  process.exit(1);
}

const shared = {
  entryPoints: [entry],
  bundle: true,
  platform: "browser",
  target: "es2022",
  external: values.external,
  logOverride: { "empty-import-meta": "silent" },
};

/**
 * List the engine members the bundle really uses, from a throwaway ESM build that
 * keeps the engine external. Deriving the list means a new engine import cannot be
 * forgotten here and silently read as `undefined` in the global bundle.
 */
async function readEngineMembers() {
  const result = await esbuild.build({
    ...shared,
    external: [...values.external, engineId],
    format: "esm",
    write: false,
  });
  const code = result.outputFiles[0].text;
  const from = `from\\s*["']${engineId}["']`;
  const members = new Set();
  for (const [, list] of code.matchAll(new RegExp(`import\\s*\\{([^}]*)\\}\\s*${from}`, "g"))) {
    for (const item of list.split(",")) {
      const name = item.trim().split(/\s+as\s+/)[0];
      if (name) members.add(name);
    }
  }
  // A namespace or default import has no member list, so it cannot be shimmed.
  if (members.has("default") || new RegExp(`import\\s+[^{;"']*?\\s${from}`).test(code)) {
    throw new Error(`${entry}: only named imports of ${engineId} work in a global bundle`);
  }
  return [...members].sort();
}

/**
 * Source of the shim. It is CommonJS on purpose: named imports of a CommonJS module
 * compile to a property read at each use site (`import_three.Box3`), which is what
 * keeps the lookup late, whereas ESM exports would have to be fixed at load.
 */
function renderShim(members) {
  const missing =
    `[uptimizr] ${engine.title} not found: ${engine.label} is not set. ` +
    `The Uptimizr global bundle never includes the engine. ${engine.recipe}`;
  return `
    const missing = ${JSON.stringify(missing)};
    const optional = new Set(${JSON.stringify(engine.optional)});
    const label = ${JSON.stringify(engine.label)};
    const recipe = ${JSON.stringify(engine.recipe)};
    function read(name) {
      const engine = ${engine.lookup};
      if (engine == null) throw new Error(missing);
      const value = engine[name];
      if (value === undefined && !optional.has(name)) {
        throw new Error("[uptimizr] " + label + " has no " + name + ". " + recipe);
      }
      return value;
    }
    for (const name of ${JSON.stringify(members)}) {
      Object.defineProperty(exports, name, { enumerable: true, get: () => read(name) });
    }
  `;
}

const members = await readEngineMembers();

const engineGlobalPlugin = {
  name: "uptimizr-engine-global",
  setup(build) {
    const namespace = "uptimizr-engine-global";
    build.onResolve({ filter: new RegExp(`^${engineId}$`) }, ({ path }) => ({ path, namespace }));
    build.onLoad({ filter: /.*/, namespace }, () => ({
      contents: renderShim(members),
      loader: "js",
    }));
  },
};

await esbuild.build({
  ...shared,
  format: "iife",
  globalName: values["global-name"],
  minify: true,
  legalComments: "none",
  banner: { js: values.banner },
  outfile: values.outfile,
  plugins: [engineGlobalPlugin],
});
