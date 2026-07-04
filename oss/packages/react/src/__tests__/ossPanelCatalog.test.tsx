import { describe, expect, it } from "vitest";
import { isValidElement, type ReactElement } from "react";
import {
  ossPanelCatalog,
  topMeshesPanel,
  meshLeaderboardPanel,
  blindSpotsPanel,
  pointerHeatmapPanel,
  cameraDomePanel,
  viewCoveragePanel,
  floorPlanPanel,
  desireLinesPanel,
  meshKindsPanel,
  inputModalityPanel,
  renderScalePanel,
  perfDistributionPanel,
  worldHeatmapPanel,
  perfHeatmapPanel,
  navigationMixPanel,
  xrLocomotionComfortPanel,
  sceneRetentionPanel,
  deadZonePanel,
  flowPanel,
  divergencePanel,
} from "../index";
import type { PanelContext, PanelDataContext, PanelDefinition } from "../index";

/** The Babylon-backed panels — their views must be code-split (React.lazy). */
const PANEL_3D_IDS = new Set([
  "camera-dome-3d",
  "world-heatmap-3d",
  "perf-heatmap-3d",
  "flow-sankey-3d", // gitleaks:allow — panel id, not a secret
  "gaze-click-divergence-3d",
]);

/** React tags a `React.lazy(...)` component with this internal symbol. */
const REACT_LAZY = Symbol.for("react.lazy");

/**
 * A permissive context/data pair that satisfies every panel's `render` (which
 * only *constructs* elements — child components are never invoked here, so no
 * network or Babylon code runs).
 */
const ctx = {
  settings: { bins: 36, cellSize: 0.5, maxLinks: 80, limit: 25 },
  baseUrl: "http://localhost:4318",
  apiKey: "k",
  capabilities: { hasFirstPerson: false },
} as unknown as PanelContext;

const data = {
  sources: [],
  trend: [],
  actions: [],
  coverage: [],
  proxyMeshes: [],
  distribution: {},
  histogram: [],
  voxels: [],
  totals: { cells: 0, hits: 0 },
  links: [],
  flowQuery: {},
  gaze: [],
  click: [],
};

function renderPanel(panel: PanelDefinition<unknown>): ReactElement {
  const el = panel.render({ data, ctx } as unknown as PanelDataContext<unknown>);
  expect(isValidElement(el)).toBe(true);
  return el as ReactElement;
}

describe("ossPanelCatalog (ADR 0036 / ADR 0047)", () => {
  it("exposes the complete OSS panel set", () => {
    expect(ossPanelCatalog).toHaveLength(20);
  });

  it("every entry is a valid PanelDefinition with a unique id", () => {
    const ids = new Set<string>();
    for (const panel of ossPanelCatalog) {
      expect(typeof panel.id).toBe("string");
      expect(panel.id.length).toBeGreaterThan(0);
      expect(typeof panel.title).toBe("string");
      expect(panel.title.length).toBeGreaterThan(0);
      expect(typeof panel.load).toBe("function");
      expect(typeof panel.render).toBe("function");
      expect(ids.has(panel.id), `duplicate panel id: ${panel.id}`).toBe(false);
      ids.add(panel.id);
    }
    expect(ids.size).toBe(ossPanelCatalog.length);
  });

  it("re-exports every panel individually and includes it in the catalog", () => {
    const individual = [
      topMeshesPanel,
      meshLeaderboardPanel,
      blindSpotsPanel,
      pointerHeatmapPanel,
      cameraDomePanel,
      viewCoveragePanel,
      floorPlanPanel,
      desireLinesPanel,
      meshKindsPanel,
      inputModalityPanel,
      renderScalePanel,
      perfDistributionPanel,
      worldHeatmapPanel,
      perfHeatmapPanel,
      navigationMixPanel,
      xrLocomotionComfortPanel,
      sceneRetentionPanel,
      deadZonePanel,
      flowPanel,
      divergencePanel,
    ];
    for (const panel of individual) {
      expect(ossPanelCatalog).toContain(panel);
    }
    // No stragglers: the catalog is exactly the individually exported panels.
    expect(individual).toHaveLength(ossPanelCatalog.length);
  });

  it("the 3D panels render behind React.lazy — Babylon is never imported at module-eval", () => {
    // Importing this module (and its barrel) must not pull in @babylonjs/*: the
    // 3D views are only reachable through `React.lazy`, so their (heavy) modules
    // — and Babylon — load only when a 3D panel actually mounts, not here.
    const threeD = ossPanelCatalog.filter((p) => PANEL_3D_IDS.has(p.id));
    expect(threeD).toHaveLength(PANEL_3D_IDS.size);

    for (const panel of threeD) {
      const el = renderPanel(panel);
      // The catalog wraps the lazy view in a <Suspense> boundary; the boundary's
      // child is the `React.lazy(...)` component (deferred import).
      const lazyChild = (el.props as { children?: ReactElement }).children;
      expect(isValidElement(lazyChild)).toBe(true);
      const lazyType = (lazyChild as ReactElement).type as { $$typeof?: symbol };
      expect(lazyType.$$typeof).toBe(REACT_LAZY);
    }
  });

  it("the 2D panels render their view directly (no lazy boundary)", () => {
    const twoD = ossPanelCatalog.filter((p) => !PANEL_3D_IDS.has(p.id));
    for (const panel of twoD) {
      const el = renderPanel(panel);
      // A 2D panel's render returns the view component element directly, so its
      // type is a plain function component — not a React.lazy wrapper.
      const type = el.type as { $$typeof?: symbol };
      expect(typeof el.type).toBe("function");
      expect(type.$$typeof).not.toBe(REACT_LAZY);
    }
  });
});
