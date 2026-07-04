/**
 * Panel chrome copy (title / subtitle / help) for the Babylon-backed 3D panels.
 *
 * These strings live in their own Babylon-free module so the catalog can attach
 * them to a {@link PanelDefinition} at definition time without statically
 * importing the heavy 3D view modules (those are pulled in lazily at render). No
 * runtime code here touches `@babylonjs/*`, so importing this file never loads
 * Babylon.
 */

export const CAMERA_DOME_TITLE = "View-direction dome (3D)";
export const CAMERA_DOME_SUBTITLE =
  "Where the audience looked, mapped onto a sphere — drag to orbit, +/- to zoom, double-click to focus";

export const WORLD_HEATMAP_TITLE = "World heatmap (3D)";
export const WORLD_HEATMAP_SUBTITLE =
  "Pointer hit-points voxel-binned in world space — drag to orbit, +/- to zoom, double-click to focus";

export const PERF_HEATMAP_TITLE = "Performance heatmap (3D)";
export const PERF_HEATMAP_SUBTITLE =
  "Where FPS is bad in your scene — frame_perf samples voxel-binned by camera position; hot = slow. Drag to orbit, +/- to zoom, double-click to focus";
export const ERROR_HEATMAP_TITLE = "Error heatmap (3D)";
export const ERROR_HEATMAP_SUBTITLE =
  "Where errors & engine diagnostics fired, voxel-binned by the camera position at the moment they hit — drag to orbit, double-click to focus";

export const GAZE_CLICK_TITLE = "Gaze vs. click divergence";
export const GAZE_CLICK_SUBTITLE =
  "Where viewers look (gaze) vs. where they act (clicks), voxel-binned in world space — double-click to focus";

export const CLICK_RAYS_TITLE = "Click rays (3D)";
export const CLICK_RAYS_SUBTITLE =
  "Each click joined to the view it was made from — gate by viewpoint or focus a mesh; double-click to recenter";

export const FLOW_SANKEY_TITLE = "Flow Sankey (3D)";
export const FLOW_SANKEY_SUBTITLE =
  "Direction-bin → mesh links (aggregate), or standpoint → gaze → mesh (two-stage) — double-click to focus";

/** "?" help content for the flow Sankey panel. */
export const FLOW_SANKEY_HELP = (
  <>
    Each <strong>source</strong> is a camera <em>gaze-direction bin</em> — a cell on the sphere of
    where viewers were looking (grouped by azimuth/elevation). Each <strong>target</strong> is a{" "}
    <em>mesh that was clicked</em>. A ribbon&apos;s thickness is how many clicks on that mesh
    happened while viewers looked from that direction, so you can see which viewpoints drive
    interaction with which objects. When the scene reports <em>standpoints</em> (where the viewer
    stood, §7.8), pick one to gate the flow to clicks made from that vantage — a pin marks it in the
    scene. &quot;All standpoints&quot; is the aggregate view. Switch to <strong>Two-stage</strong>{" "}
    for a three-column <em>standpoint → gaze sector → mesh</em> flow with a birdview minimap; the
    busiest standpoints/meshes are kept and the tail folds into an &quot;Other&quot; node.
  </>
);
