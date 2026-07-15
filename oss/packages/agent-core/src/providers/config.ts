/**
 * User-controlled backend selection and its browser persistence (ADR 0050 §4).
 *
 * The assistant ships no model and no key: the user picks a backend and the
 * choice persists per-user in `localStorage`. Nothing here talks to a network —
 * it only records which backend the user chose and the parameters needed to
 * construct the matching provider adapter. Everything is injectable and
 * SSR/Node-safe so the same module runs in the browser, in tests, and during a
 * static export where `localStorage`/`navigator` may be absent.
 */

/** The two user-controlled backends (ADR 0050 §4). */
export type BackendKind = "local" | "hosted";

/** Wire format of a bring-your-own hosted provider. */
export type HostedApi = "openai" | "anthropic";

/** Persisted parameters for the local (WebLLM/WebGPU) backend. */
export interface WebLlmBackendConfig {
  /** Curated model id to load (see `CURATED_MODELS`). */
  model: string;
}

/**
 * Persisted parameters for a bring-your-own hosted backend. The key and
 * endpoint live only in the user's browser and are sent only to the user's own
 * provider (ADR 0050 §5).
 */
export interface HostedBackendConfig {
  /** Which wire format the endpoint speaks. */
  api: HostedApi;
  /** Base URL of the user's provider (e.g. https://api.openai.com/v1). */
  endpoint: string;
  /** The user's provider API key, stored in-browser only. */
  apiKey: string;
  /** Model identifier to request from the provider. */
  model: string;
}

/** The persisted assistant backend selection. */
export interface AssistantBackendConfig {
  /** Which backend the user selected. */
  backend: BackendKind;
  /** Local backend parameters (present when `backend === "local"`). */
  webllm?: WebLlmBackendConfig;
  /** Hosted backend parameters (present when `backend === "hosted"`). */
  hosted?: HostedBackendConfig;
}

/** The `localStorage` key the selection is stored under. */
export const BACKEND_CONFIG_STORAGE_KEY = "uptimizr.assistant.backend";

/** The minimal `localStorage`-like surface this module needs. */
export interface KeyValueStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

function defaultStorage(): KeyValueStorage | undefined {
  try {
    return (globalThis as { localStorage?: KeyValueStorage }).localStorage;
  } catch {
    // Accessing localStorage can throw in sandboxed iframes / disabled storage.
    return undefined;
  }
}

/**
 * Feature-detect WebGPU. The local backend is only offered when this returns
 * `true`; callers should hide/disable the local option otherwise (ADR 0050 §4).
 */
export function isWebGpuAvailable(nav: Navigator | undefined = globalThis.navigator): boolean {
  return Boolean(nav && "gpu" in nav && (nav as { gpu?: unknown }).gpu);
}

/**
 * The privacy-preserving default backend: local (zero egress) when WebGPU is
 * present, otherwise hosted (ADR 0050 §4/§5).
 */
export function defaultBackendKind(nav?: Navigator): BackendKind {
  return isWebGpuAvailable(nav) ? "local" : "hosted";
}

function isBackendKind(value: unknown): value is BackendKind {
  return value === "local" || value === "hosted";
}

/**
 * Load the persisted backend selection, or `null` when nothing is stored (or
 * storage is unavailable / corrupt). Corrupt entries are treated as absent.
 */
export function loadBackendConfig(
  storage: KeyValueStorage | undefined = defaultStorage(),
): AssistantBackendConfig | null {
  if (!storage) return null;
  let raw: string | null;
  try {
    raw = storage.getItem(BACKEND_CONFIG_STORAGE_KEY);
  } catch {
    return null;
  }
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object") return null;
    const backend = (parsed as { backend?: unknown }).backend;
    if (!isBackendKind(backend)) return null;
    return parsed as AssistantBackendConfig;
  } catch {
    return null;
  }
}

/**
 * Persist the backend selection. No-op when storage is unavailable so callers
 * don't have to guard SSR/Node.
 */
export function saveBackendConfig(
  config: AssistantBackendConfig,
  storage: KeyValueStorage | undefined = defaultStorage(),
): void {
  if (!storage) return;
  try {
    storage.setItem(BACKEND_CONFIG_STORAGE_KEY, JSON.stringify(config));
  } catch {
    // Ignore quota/security errors — persistence is best-effort.
  }
}

/** Clear any persisted backend selection. */
export function clearBackendConfig(
  storage: KeyValueStorage | undefined = defaultStorage(),
): void {
  if (!storage) return;
  try {
    storage.removeItem(BACKEND_CONFIG_STORAGE_KEY);
  } catch {
    // Ignore.
  }
}
