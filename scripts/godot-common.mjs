/**
 * Shared constants + helpers for the Godot web-export tooling
 * (`godot-fetch.mjs`, `godot-export.mjs`, `godot-check-bridge.mjs`).
 *
 * The pinned Godot version is the single source of truth here; the CI cache key in
 * `.github/workflows/{pr,main}.yml` repeats it and must be bumped together.
 */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** The Godot release tag we export with (see `gh release view --repo godotengine/godot`). */
export const GODOT_VERSION = "4.7.2-stable";

/**
 * The folder name Godot expects under `export_templates/` for this version: the
 * editor looks up `<data dir>/export_templates/<major.minor.patch.status>/<template>`.
 */
export const GODOT_TEMPLATE_VERSION_DIR = GODOT_VERSION.replace(/-/, ".");

/**
 * Web export templates to install. `web_nothreads_release.zip` backs a Web preset
 * with `variant/thread_support=false`, so the export runs without SharedArrayBuffer
 * and therefore without COOP/COEP headers on the host page. Set
 * `GODOT_WEB_TEMPLATES=web_nothreads_release.zip,web_release.zip` to add more.
 */
export const GODOT_WEB_TEMPLATES = (process.env.GODOT_WEB_TEMPLATES ?? "web_nothreads_release.zip")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

/** Where the release assets live; override to point at a mirror. */
export const GODOT_DOWNLOAD_BASE =
  process.env.GODOT_DOWNLOAD_BASE ??
  `https://github.com/godotengine/godot/releases/download/${GODOT_VERSION}`;

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** The minimal Godot 4 sample project with the `UptimizrGodot` autoload registered. */
export const SAMPLE_PROJECT_DIR = join(REPO_ROOT, "examples", "godot-web-export");

/** Where `godot-export.mjs` writes the Web export (gitignored via the global `dist/`). */
export const SAMPLE_EXPORT_DIR = join(SAMPLE_PROJECT_DIR, "dist");

/** Name of the Web preset in the sample project's `export_presets.cfg`. */
export const SAMPLE_EXPORT_PRESET = "Web";

/** The canonical engine-side shim the sample project copies in. */
export const BRIDGE_SOURCE = join(
  REPO_ROOT,
  "oss",
  "packages",
  "godot",
  "bridge",
  "UptimizrGodot.gd",
);

/** The sample project's copy of the shim (must stay byte-identical to the source). */
export const BRIDGE_COPY = join(SAMPLE_PROJECT_DIR, "uptimizr", "UptimizrGodot.gd");

/**
 * Godot's per-user data directory (`~/.local/share/godot` on Linux, honouring
 * `XDG_DATA_HOME`). Override with `GODOT_DATA_DIR`. Export templates go under
 * `export_templates/`, exactly where the editor expects them; the downloaded
 * headless editor lives under `bin/` next to it so one cache path covers both.
 */
export function godotDataDir() {
  if (process.env.GODOT_DATA_DIR) return resolve(process.env.GODOT_DATA_DIR);
  const xdg = process.env.XDG_DATA_HOME ?? join(homedir(), ".local", "share");
  return join(xdg, "godot");
}

export function godotTemplatesDir() {
  return join(godotDataDir(), "export_templates", GODOT_TEMPLATE_VERSION_DIR);
}

/** Linux release asset suffix for this machine. Only Linux builds are supported. */
export function godotEditorAssetName() {
  if (process.platform !== "linux") {
    throw new Error(
      `godot tooling: only Linux is supported (platform=${process.platform}); ` +
        `set GODOT_BIN to a local Godot ${GODOT_VERSION} editor binary instead.`,
    );
  }
  const arch = process.arch === "arm64" ? "linux.arm64" : "linux.x86_64";
  return `Godot_v${GODOT_VERSION}_${arch}`;
}

/** Absolute path of the headless editor binary `godot-fetch.mjs` installs. */
export function godotEditorPath() {
  if (process.env.GODOT_BIN) return resolve(process.env.GODOT_BIN);
  return join(godotDataDir(), "bin", godotEditorAssetName());
}

/**
 * Compare the sample project's copy of `UptimizrGodot.gd` with the package source.
 * Returns `null` when identical, otherwise a human-readable reason.
 */
export function bridgeCopyDrift() {
  if (!existsSync(BRIDGE_SOURCE)) return `bridge source missing: ${BRIDGE_SOURCE}`;
  if (!existsSync(BRIDGE_COPY)) return `sample project copy missing: ${BRIDGE_COPY}`;
  const src = readFileSync(BRIDGE_SOURCE);
  const copy = readFileSync(BRIDGE_COPY);
  if (!src.equals(copy)) {
    return (
      `${BRIDGE_COPY} differs from ${BRIDGE_SOURCE} — the sample project must not fork the shim. ` +
      `Run 'pnpm godot:check-bridge --fix' to re-copy it.`
    );
  }
  return null;
}
