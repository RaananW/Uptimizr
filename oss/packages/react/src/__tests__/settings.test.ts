import { afterEach, describe, expect, it } from "vitest";
import type { PanelSettings } from "../panels/contract";
import {
  EMPTY_PANEL_STATE,
  coercePanelSetting,
  createLocalStoragePanelStore,
  memoryPanelStore,
  pruneDefaultOverrides,
  resolvePanelSettings,
} from "../panels/settings";

const spec = {
  cellSize: { type: "number", default: 1, min: 0.25, max: 5, step: 0.25 },
  showLegend: { type: "boolean", default: true },
  palette: {
    type: "select",
    default: "ember",
    options: [{ value: "ember" }, { value: "ice" }],
  },
} as const satisfies PanelSettings;

describe("coercePanelSetting", () => {
  it("clamps numbers into [min, max] and falls back on non-numbers", () => {
    expect(coercePanelSetting(spec.cellSize, 10)).toBe(5);
    expect(coercePanelSetting(spec.cellSize, 0)).toBe(0.25);
    expect(coercePanelSetting(spec.cellSize, 2)).toBe(2);
    expect(coercePanelSetting(spec.cellSize, "nope" as unknown as number)).toBe(1);
    expect(coercePanelSetting(spec.cellSize, Number.NaN)).toBe(1);
  });

  it("validates select options and booleans, else uses the default", () => {
    expect(coercePanelSetting(spec.palette, "ice")).toBe("ice");
    expect(coercePanelSetting(spec.palette, "unknown")).toBe("ember");
    expect(coercePanelSetting(spec.showLegend, false)).toBe(false);
    expect(coercePanelSetting(spec.showLegend, "yes" as unknown as boolean)).toBe(true);
  });
});

describe("resolvePanelSettings", () => {
  it("overlays defaults with valid overrides and ignores unknown keys", () => {
    const resolved = resolvePanelSettings(spec, {
      cellSize: 0.5,
      removedSetting: 99, // a setting the panel no longer declares
    });
    expect(resolved).toEqual({ cellSize: 0.5, showLegend: true, palette: "ember" });
  });

  it("returns an empty object for a panel with no settings", () => {
    expect(resolvePanelSettings(undefined, undefined)).toEqual({});
  });
});

describe("pruneDefaultOverrides", () => {
  it("drops values equal to the default and settings the panel removed", () => {
    const pruned = pruneDefaultOverrides(spec, {
      cellSize: 1, // equals default → dropped
      showLegend: false, // differs → kept
      gone: 5, // not in spec → dropped
    });
    expect(pruned).toEqual({ showLegend: false });
  });
});

describe("createLocalStoragePanelStore", () => {
  afterEach(() => window.localStorage.clear());

  it("round-trips state and removes the key when empty", () => {
    const store = createLocalStoragePanelStore("test:panels");
    expect(store.load()).toEqual(EMPTY_PANEL_STATE);

    store.save({ hidden: ["a", "b"], settings: { p: { cellSize: 0.5 } } });
    expect(store.load()).toEqual({ hidden: ["a", "b"], settings: { p: { cellSize: 0.5 } } });

    store.save(EMPTY_PANEL_STATE);
    expect(window.localStorage.getItem("test:panels")).toBeNull();
  });

  it("normalizes malformed stored JSON to a safe state", () => {
    window.localStorage.setItem(
      "test:panels",
      JSON.stringify({ hidden: ["ok", 5], settings: { p: { n: 2, bad: null }, q: "x" } }),
    );
    const store = createLocalStoragePanelStore("test:panels");
    expect(store.load()).toEqual({ hidden: ["ok"], settings: { p: { n: 2 } } });
  });

  it("tolerates corrupt JSON without throwing", () => {
    window.localStorage.setItem("test:panels", "{not json");
    expect(createLocalStoragePanelStore("test:panels").load()).toEqual(EMPTY_PANEL_STATE);
  });
});

describe("memoryPanelStore", () => {
  it("is always empty and never persists", () => {
    expect(memoryPanelStore.load()).toEqual(EMPTY_PANEL_STATE);
    memoryPanelStore.save({ hidden: ["x"], settings: {} });
    expect(memoryPanelStore.load()).toEqual(EMPTY_PANEL_STATE);
  });
});
