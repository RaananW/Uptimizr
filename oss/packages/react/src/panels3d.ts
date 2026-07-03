"use client";

// @uptimizr/react/panels-3d — the Babylon-backed panel VIEW components.
//
// This is a SEPARATE entry point from the core `@uptimizr/react` barrel on
// purpose: importing it is what pulls the 3D view modules (and, at render time,
// their dynamically imported `@babylonjs/*` chunks) into your graph. The core
// entry stays Babylon-free — the `ossPanelCatalog` reaches these same views via
// `React.lazy`, so a host that renders the full catalog never needs this entry.
//
// Reach for `@uptimizr/react/panels-3d` only when you want to compose a 3D view
// DIRECTLY (outside the catalog) — e.g. a bespoke mount with your own chrome and
// data. Pair it with your bundler's lazy loading (React.lazy / next/dynamic) so
// Babylon stays out of your initial bundle.

export { CameraDome3DView } from "./catalog/views3d/CameraDome3D";
export { WorldHeatmap3DView } from "./catalog/views3d/WorldHeatmap3D";
export { FlowSankey3DView } from "./catalog/views3d/FlowSankey3D";
export { GazeClickDivergence3DView } from "./catalog/views3d/GazeClickDivergence3D";
export { ClickRays3DView } from "./catalog/views3d/ClickRays3D";

// Babylon-free panel chrome copy (title / subtitle / help) for the 3D panels.
export {
  CAMERA_DOME_TITLE,
  CAMERA_DOME_SUBTITLE,
  WORLD_HEATMAP_TITLE,
  WORLD_HEATMAP_SUBTITLE,
  GAZE_CLICK_TITLE,
  GAZE_CLICK_SUBTITLE,
  CLICK_RAYS_TITLE,
  CLICK_RAYS_SUBTITLE,
  FLOW_SANKEY_TITLE,
  FLOW_SANKEY_SUBTITLE,
  FLOW_SANKEY_HELP,
} from "./catalog/views3d/labels";
