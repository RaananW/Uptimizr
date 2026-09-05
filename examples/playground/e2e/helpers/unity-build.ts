/**
 * Locate and serve a built Unity WebGL export from `examples/unity-web-export/dist/`.
 *
 * Shared by the Vite dev server (a middleware that serves the build at
 * `/unity-build/` plus a discovery manifest) and the Playwright spec
 * (`unity-export.spec.ts`), which skips cleanly when no build is present. Unity is
 * not installed in CI; the build is the one manual step a maintainer runs locally
 * (see `examples/unity-web-export/README.md`, #253).
 */
import { createReadStream, existsSync, readdirSync, statSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** The sample Unity project and its git-ignored WebGL build output. */
export const UNITY_EXAMPLE_DIR = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../../unity-web-export",
);
export const UNITY_DIST_DIR = resolve(UNITY_EXAMPLE_DIR, "dist");

/** URL prefix the playground dev server mounts the build under. */
export const UNITY_BUILD_ROUTE = "/unity-build";
/** Discovery endpoint the harness page fetches to find the loader + data files. */
export const UNITY_MANIFEST_PATH = `${UNITY_BUILD_ROUTE}/manifest.json`;

export type UnityCompression = "none" | "gzip" | "brotli";

/** What `createUnityInstance` needs, resolved from the build's `Build/` folder. */
export interface UnityBuildManifest {
  /** Unity names every artifact after the output folder (`dist` → `dist.loader.js`). */
  buildName: string;
  loaderUrl: string;
  dataUrl: string;
  frameworkUrl: string;
  codeUrl: string;
  streamingAssetsUrl: string;
  /** Player setting "Compression Format" the build was made with. */
  compression: UnityCompression;
}

const COMPRESSED_SUFFIXES: ReadonlyArray<readonly [string, UnityCompression]> = [
  ["", "none"],
  [".gz", "gzip"],
  [".br", "brotli"],
];

/**
 * Find a Unity WebGL build under `distDir`, or `null` when none has been made.
 * Recognises plain, gzip and brotli outputs (`Compression Format` player setting).
 */
export function findUnityBuild(distDir: string = UNITY_DIST_DIR): UnityBuildManifest | null {
  const buildDir = join(distDir, "Build");
  if (!existsSync(buildDir)) return null;
  const loader = readdirSync(buildDir).find((f) => f.endsWith(".loader.js"));
  if (!loader) return null;
  const buildName = loader.slice(0, -".loader.js".length);

  let compression: UnityCompression = "none";
  for (const artifact of ["data", "framework.js", "wasm"]) {
    const hit = COMPRESSED_SUFFIXES.find(([suffix]) =>
      existsSync(join(buildDir, `${buildName}.${artifact}${suffix}`)),
    );
    if (!hit) return null; // an incomplete / interrupted build
    if (hit[1] !== "none") compression = hit[1];
  }

  const base = `${UNITY_BUILD_ROUTE}/Build/${buildName}`;
  return {
    buildName,
    loaderUrl: `${base}.loader.js`,
    dataUrl: `${base}.data`,
    frameworkUrl: `${base}.framework.js`,
    codeUrl: `${base}.wasm`,
    streamingAssetsUrl: `${UNITY_BUILD_ROUTE}/StreamingAssets`,
    compression,
  };
}

const MIME: Record<string, string> = {
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".wasm": "application/wasm",
  ".data": "application/octet-stream",
  ".mem": "application/octet-stream",
  ".json": "application/json; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".ico": "image/x-icon",
  ".svg": "image/svg+xml",
};

/**
 * A Connect-style middleware that serves `distDir` under {@link UNITY_BUILD_ROUTE}.
 * The manifest is computed per request so a build made after the dev server started
 * is picked up. Compressed outputs (`.gz` / `.br`) are served under their plain
 * name with the matching `Content-Encoding`, so Unity's loader stays oblivious.
 */
export function serveUnityBuild(distDir: string = UNITY_DIST_DIR) {
  return (req: IncomingMessage, res: ServerResponse, next: () => void): void => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (!url.pathname.startsWith(`${UNITY_BUILD_ROUTE}/`)) return next();

    if (url.pathname === UNITY_MANIFEST_PATH) {
      const manifest = findUnityBuild(distDir);
      res.statusCode = manifest ? 200 : 404;
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      res.setHeader("Cache-Control", "no-store");
      res.end(
        JSON.stringify(
          manifest ?? {
            error: `no Unity WebGL build at ${distDir} — see examples/unity-web-export/README.md`,
          },
        ),
      );
      return;
    }

    // Resolve inside distDir only (reject traversal).
    const rel = decodeURIComponent(url.pathname.slice(UNITY_BUILD_ROUTE.length + 1));
    const file = resolve(distDir, rel);
    if (!file.startsWith(distDir + "/") && file !== distDir) {
      res.statusCode = 403;
      res.end();
      return;
    }

    const candidate = COMPRESSED_SUFFIXES.map(
      ([suffix, enc]) => [file + suffix, enc] as const,
    ).find(([path]) => existsSync(path) && statSync(path).isFile());
    if (!candidate) {
      res.statusCode = 404;
      res.end(`not found: ${rel}`);
      return;
    }
    const [path, encoding] = candidate;
    res.statusCode = 200;
    res.setHeader("Content-Type", MIME[extname(file)] ?? "application/octet-stream");
    res.setHeader("Cache-Control", "no-store");
    if (encoding === "gzip") res.setHeader("Content-Encoding", "gzip");
    if (encoding === "brotli") res.setHeader("Content-Encoding", "br");
    createReadStream(path).pipe(res);
  };
}
