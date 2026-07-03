// Runtime / remote dashboard panel loading (ADR 0041).
//
// ADR 0036 shipped a build-time registry: a self-hoster appends a
// `PanelDefinition` to the dashboard's `builtinPanels` array and rebuilds. The
// contract was designed so a runtime loader could be layered on behind the SAME
// `PanelDefinition` interface — this module is that loader.
//
// It is intentionally framework-agnostic (no React / Next imports): it fetches a
// JSON manifest describing remote panel modules, dynamically `import()`s each
// module, validates the exported definition against the contract, and returns
// the loaded panels alongside per-entry errors so one bad panel never blocks the
// rest. The dashboard host owns the wiring (config, when to fetch, how to
// surface errors); this stays pure and testable.
//
// Trust model: remote panels execute with the dashboard's full privileges. The
// host opts in by configuring a manifest URL (off by default) and may pass an
// `allowOrigins` allowlist as a guardrail; the loader refuses module URLs whose
// origin is not allowed. There is no iframe/worker sandbox — that would break
// the rich `PanelContext` the contract hands every panel.

import type { PanelDefinition } from "./contract";
import { PANEL_CONTRACT_VERSION } from "./contract";

/** One remote panel module entry in a manifest. */
export interface PanelManifestEntry {
  /**
   * Fully-qualified URL of the ES module to import. Must resolve to a module
   * that exports a `PanelDefinition` (see `export`).
   */
  readonly url: string;
  /**
   * Panel-contract major the module was built against. The host only loads an
   * entry whose `contract` equals the running `PANEL_CONTRACT_VERSION`.
   */
  readonly contract: number;
  /**
   * Named export to read the definition from. Defaults to `default`; the loader
   * also falls back to a `panel` named export when neither is present.
   */
  readonly export?: string;
  /** Optional human label for diagnostics (falls back to the URL). */
  readonly id?: string;
}

/** A remote panel manifest: a versioned list of panel module entries. */
export interface PanelManifest {
  /**
   * Manifest format version. Currently `1`. Distinct from a panel's
   * `contract` — this versions the manifest envelope, not the panel API.
   */
  readonly version: number;
  readonly panels: readonly PanelManifestEntry[];
}

/** Why a single remote panel (or a whole manifest) failed to load. */
export type RemotePanelErrorCode =
  | "manifest-fetch" // network / HTTP error fetching the manifest
  | "manifest-invalid" // manifest JSON did not match the expected shape
  | "origin-blocked" // module URL origin not in the allowlist
  | "import-failed" // dynamic import threw (network, syntax, runtime)
  | "export-missing" // the named/default export was absent
  | "invalid-panel" // the export was not a valid PanelDefinition
  | "incompatible"; // declared contract major != PANEL_CONTRACT_VERSION

/** A non-fatal, per-source failure surfaced to the host (never thrown). */
export interface RemotePanelError {
  /** Manifest URL or module URL the failure relates to. */
  readonly source: string;
  readonly code: RemotePanelErrorCode;
  readonly message: string;
}

/** Result of loading remote panels: what loaded, and what didn't. */
export interface LoadRemotePanelsResult {
  readonly panels: PanelDefinition<unknown>[];
  readonly errors: RemotePanelError[];
}

/** Injectable dynamic importer (defaults to a bundler-ignored `import()`). */
export type ModuleImporter = (url: string) => Promise<Record<string, unknown>>;

/** Options for {@link loadRemotePanels}. */
export interface LoadRemotePanelsOptions {
  /**
   * How to import a module URL. Defaults to a dynamic `import()` annotated so
   * bundlers (Webpack / Turbopack / Vite) leave the runtime URL alone. Inject in
   * tests, or to enforce a custom trust policy.
   */
  readonly importModule?: ModuleImporter;
  /**
   * Allowed origins for module URLs (e.g. `["https://panels.example.com"]`).
   * When provided and non-empty, a module URL whose origin is not listed is
   * rejected with an `origin-blocked` error. Omit (or pass empty) to allow any
   * origin — appropriate only when the manifest itself is fully trusted.
   */
  readonly allowOrigins?: readonly string[];
}

/** Options for {@link fetchPanelManifest}. */
export interface FetchManifestOptions {
  /** Injectable `fetch` (defaults to the global). */
  readonly fetchImpl?: typeof fetch;
  /** Forwarded to the underlying request (e.g. an `AbortSignal`). */
  readonly signal?: AbortSignal;
}

const DEFAULT_IMPORTER: ModuleImporter = (url) =>
  // The annotations keep bundlers from trying to resolve the runtime URL at
  // build time; remote loading is a client-side runtime concern.
  import(/* webpackIgnore: true */ /* @vite-ignore */ url) as Promise<Record<string, unknown>>;

/**
 * Structural runtime guard: is `value` a usable `PanelDefinition`? We can't
 * trust a remote module's types, so we check the load-bearing fields the host
 * relies on (`id`, `title`, `render`) plus the shape of the common optionals.
 */
export function isPanelDefinition(value: unknown): value is PanelDefinition<unknown> {
  if (typeof value !== "object" || value === null) return false;
  const p = value as Record<string, unknown>;
  if (typeof p.id !== "string" || p.id.length === 0) return false;
  if (typeof p.title !== "string") return false;
  if (typeof p.render !== "function") return false;
  if (p.load !== undefined && typeof p.load !== "function") return false;
  if (p.enabled !== undefined && typeof p.enabled !== "function") return false;
  if (p.span !== undefined && p.span !== 1 && p.span !== 2) return false;
  if (p.surfaces !== undefined && !Array.isArray(p.surfaces)) return false;
  return true;
}

/** Whether a declared contract major is compatible with this host. */
export function isContractCompatible(declared: unknown): boolean {
  return declared === PANEL_CONTRACT_VERSION;
}

/** Validate an untrusted value as a {@link PanelManifest}. */
export function isPanelManifest(value: unknown): value is PanelManifest {
  if (typeof value !== "object" || value === null) return false;
  const m = value as Record<string, unknown>;
  if (typeof m.version !== "number") return false;
  if (!Array.isArray(m.panels)) return false;
  return m.panels.every((entry) => {
    if (typeof entry !== "object" || entry === null) return false;
    const e = entry as Record<string, unknown>;
    return (
      typeof e.url === "string" &&
      e.url.length > 0 &&
      typeof e.contract === "number" &&
      (e.export === undefined || typeof e.export === "string") &&
      (e.id === undefined || typeof e.id === "string")
    );
  });
}

function originAllowed(url: string, allowOrigins?: readonly string[]): boolean {
  if (!allowOrigins || allowOrigins.length === 0) return true;
  let origin: string;
  try {
    origin = new URL(url).origin;
  } catch {
    return false; // unparseable URL is never allowed
  }
  return allowOrigins.includes(origin);
}

function pickDefinition(mod: Record<string, unknown>, exportName: string): unknown {
  const named = mod[exportName];
  if (named !== undefined) return named;
  // Convenience fallback: a module-level `panel` export when no `default`.
  if (exportName === "default" && mod.panel !== undefined) return mod.panel;
  return undefined;
}

/**
 * Fetch and validate a remote panel manifest. Returns the parsed manifest, or a
 * {@link RemotePanelError} describing the failure (never throws on network /
 * shape errors — those are part of the result so the host can surface them).
 */
export async function fetchPanelManifest(
  url: string,
  options: FetchManifestOptions = {},
): Promise<PanelManifest | RemotePanelError> {
  const fetchImpl = options.fetchImpl ?? fetch;
  let json: unknown;
  try {
    const res = await fetchImpl(url, { signal: options.signal });
    if (!res.ok) {
      return { source: url, code: "manifest-fetch", message: `HTTP ${res.status}` };
    }
    json = await res.json();
  } catch (err) {
    return { source: url, code: "manifest-fetch", message: errorMessage(err) };
  }
  if (!isPanelManifest(json)) {
    return { source: url, code: "manifest-invalid", message: "Manifest shape is invalid" };
  }
  return json;
}

/**
 * Load the panels described by a manifest. Each entry is loaded independently:
 * a version mismatch, blocked origin, import failure, missing export, or invalid
 * definition becomes a {@link RemotePanelError} and is skipped, so one bad panel
 * never blocks the others.
 */
export async function loadRemotePanels(
  manifest: PanelManifest,
  options: LoadRemotePanelsOptions = {},
): Promise<LoadRemotePanelsResult> {
  const importModule = options.importModule ?? DEFAULT_IMPORTER;
  const panels: PanelDefinition<unknown>[] = [];
  const errors: RemotePanelError[] = [];

  const settled = await Promise.all(
    manifest.panels.map((entry) => loadEntry(entry, importModule, options.allowOrigins)),
  );
  for (const outcome of settled) {
    if ("panel" in outcome) panels.push(outcome.panel);
    else errors.push(outcome.error);
  }
  return { panels, errors };
}

async function loadEntry(
  entry: PanelManifestEntry,
  importModule: ModuleImporter,
  allowOrigins?: readonly string[],
): Promise<{ panel: PanelDefinition<unknown> } | { error: RemotePanelError }> {
  const source = entry.url;
  if (!isContractCompatible(entry.contract)) {
    return {
      error: {
        source,
        code: "incompatible",
        message: `Panel declares contract ${entry.contract}; host requires ${PANEL_CONTRACT_VERSION}`,
      },
    };
  }
  if (!originAllowed(entry.url, allowOrigins)) {
    return {
      error: { source, code: "origin-blocked", message: "Module origin is not in the allowlist" },
    };
  }
  let mod: Record<string, unknown>;
  try {
    mod = await importModule(entry.url);
  } catch (err) {
    return { error: { source, code: "import-failed", message: errorMessage(err) } };
  }
  const exportName = entry.export ?? "default";
  const candidate = pickDefinition(mod, exportName);
  if (candidate === undefined) {
    return {
      error: { source, code: "export-missing", message: `No "${exportName}" export found` },
    };
  }
  if (!isPanelDefinition(candidate)) {
    return {
      error: { source, code: "invalid-panel", message: "Export is not a valid PanelDefinition" },
    };
  }
  return { panel: candidate };
}

/**
 * Merge build-time panels with runtime-loaded ones, de-duplicating by `id`.
 * Built-in panels win a collision (a remote panel can't silently shadow a
 * shipped one); each skipped duplicate is reported as an `invalid-panel` error
 * so the host can surface it.
 */
export function mergePanels(
  builtin: readonly PanelDefinition<unknown>[],
  remote: readonly PanelDefinition<unknown>[],
): { panels: PanelDefinition<unknown>[]; errors: RemotePanelError[] } {
  const byId = new Map<string, PanelDefinition<unknown>>();
  for (const panel of builtin) byId.set(panel.id, panel);

  const panels: PanelDefinition<unknown>[] = [...builtin];
  const errors: RemotePanelError[] = [];
  for (const panel of remote) {
    if (byId.has(panel.id)) {
      errors.push({
        source: panel.id,
        code: "invalid-panel",
        message: `Duplicate panel id "${panel.id}" — kept the existing panel`,
      });
      continue;
    }
    byId.set(panel.id, panel);
    panels.push(panel);
  }
  return { panels, errors };
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
