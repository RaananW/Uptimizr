// Per-panel settings resolution + the viewer-state persistence seam (ADR 0039).
//
// A panel declares typed `settings`; a viewer can override them (and hide the
// panel). The HOST owns where that viewer state lives: the standalone dashboard
// persists it to `localStorage`, while an embedding app can supply its own
// `PanelStateStore` (e.g. backed by its user-preferences API). This module is
// host-agnostic and SSR-safe so both paths share one resolution + storage core.

import type {
  AnyPanelSettingValue,
  PanelSettingSpec,
  PanelSettings,
  ResolvedPanelSettings,
} from "./contract";

/** Clamp `n` into `[min, max]` when those bounds are provided. */
function clamp(n: number, min: number | undefined, max: number | undefined): number {
  let out = n;
  if (typeof min === "number" && out < min) out = min;
  if (typeof max === "number" && out > max) out = max;
  return out;
}

/**
 * Coerce a single (possibly persisted / untrusted) override against its spec,
 * falling back to the declared default. Numbers are clamped to `[min, max]`;
 * selects must match a declared option; type mismatches fall back to default.
 * This keeps stored state valid as a panel's settings evolve (migration-safe).
 */
export function coercePanelSetting(
  spec: PanelSettingSpec,
  override: AnyPanelSettingValue | undefined,
): AnyPanelSettingValue {
  switch (spec.type) {
    case "number": {
      if (typeof override !== "number" || !Number.isFinite(override)) return spec.default;
      return clamp(override, spec.min, spec.max);
    }
    case "boolean":
      return typeof override === "boolean" ? override : spec.default;
    case "select": {
      if (typeof override !== "string") return spec.default;
      return spec.options.some((o) => o.value === override) ? override : spec.default;
    }
  }
}

/**
 * Resolve a panel's effective settings: defaults overlaid with the viewer's
 * overrides, coerced/clamped to valid values. Unknown override keys (a setting
 * a panel removed) are ignored, and missing keys use the default, so persisted
 * state never breaks a panel.
 */
export function resolvePanelSettings(
  spec: PanelSettings | undefined,
  overrides: Readonly<Record<string, AnyPanelSettingValue>> | undefined,
): ResolvedPanelSettings {
  const out: Record<string, AnyPanelSettingValue> = {};
  if (!spec) return out as ResolvedPanelSettings;
  for (const key of Object.keys(spec)) {
    out[key] = coercePanelSetting(spec[key] as PanelSettingSpec, overrides?.[key]);
  }
  return out as ResolvedPanelSettings;
}

/** Strip any override that equals its spec default, so stored state stays minimal. */
export function pruneDefaultOverrides(
  spec: PanelSettings | undefined,
  overrides: Readonly<Record<string, AnyPanelSettingValue>>,
): Record<string, AnyPanelSettingValue> {
  const out: Record<string, AnyPanelSettingValue> = {};
  if (!spec) return out;
  for (const key of Object.keys(overrides)) {
    const s = spec[key];
    if (!s) continue; // drop settings the panel no longer declares
    if (overrides[key] !== s.default) out[key] = overrides[key] as AnyPanelSettingValue;
  }
  return out;
}

/**
 * Viewer-scoped panel state for one surface: which panels are hidden, and any
 * per-panel setting overrides (keyed by panel id → setting key → value).
 */
export interface PanelState {
  /** Panel ids the viewer has hidden. */
  readonly hidden: readonly string[];
  /** Per-panel setting overrides: `{ [panelId]: { [settingKey]: value } }`. */
  readonly settings: Readonly<Record<string, Record<string, AnyPanelSettingValue>>>;
}

/** The empty/default state (nothing hidden, no overrides). */
export const EMPTY_PANEL_STATE: PanelState = { hidden: [], settings: {} };

/**
 * The persistence seam (ADR 0039). The host reads once on mount and writes on
 * change. Implementations must be synchronous + side-effect-free beyond their
 * backing store; `load` returns {@link EMPTY_PANEL_STATE} when nothing is stored.
 */
export interface PanelStateStore {
  load(): PanelState;
  save(state: PanelState): void;
}

/** Coerce arbitrary parsed JSON into a well-formed {@link PanelState}. */
function normalizeState(raw: unknown): PanelState {
  if (!raw || typeof raw !== "object") return EMPTY_PANEL_STATE;
  const obj = raw as Record<string, unknown>;
  const hidden = Array.isArray(obj.hidden)
    ? obj.hidden.filter((id): id is string => typeof id === "string")
    : [];
  const settings: Record<string, Record<string, AnyPanelSettingValue>> = {};
  if (obj.settings && typeof obj.settings === "object") {
    for (const [panelId, bag] of Object.entries(obj.settings as Record<string, unknown>)) {
      if (!bag || typeof bag !== "object") continue;
      const values: Record<string, AnyPanelSettingValue> = {};
      for (const [key, value] of Object.entries(bag as Record<string, unknown>)) {
        if (typeof value === "number" || typeof value === "boolean" || typeof value === "string") {
          values[key] = value;
        }
      }
      if (Object.keys(values).length > 0) settings[panelId] = values;
    }
  }
  return { hidden, settings };
}

/** A no-op store (SSR / disabled persistence): always empty, never writes. */
export const memoryPanelStore: PanelStateStore = {
  load: () => EMPTY_PANEL_STATE,
  save: () => {},
};

/**
 * A `localStorage`-backed store for one storage key (typically one dashboard
 * surface). SSR-safe: with no `window`/`localStorage` it degrades to an empty,
 * non-persisting store so the server render and first client render agree.
 */
export function createLocalStoragePanelStore(storageKey: string): PanelStateStore {
  const storage: Storage | null =
    typeof window !== "undefined" && window.localStorage ? window.localStorage : null;
  if (!storage) return memoryPanelStore;
  return {
    load() {
      try {
        const raw = storage.getItem(storageKey);
        return raw ? normalizeState(JSON.parse(raw)) : EMPTY_PANEL_STATE;
      } catch {
        return EMPTY_PANEL_STATE;
      }
    },
    save(state) {
      try {
        const empty = state.hidden.length === 0 && Object.keys(state.settings).length === 0;
        if (empty) storage.removeItem(storageKey);
        else storage.setItem(storageKey, JSON.stringify(state));
      } catch {
        // Storage full / disabled (private mode): persistence is best-effort.
      }
    },
  };
}
