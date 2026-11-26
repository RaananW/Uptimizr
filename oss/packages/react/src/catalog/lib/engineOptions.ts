// Babylon engine options shared by every 3D dashboard panel.
//
// Each 3D panel owns its own engine, and so its own WebGL context. Browsers cap
// the live contexts per renderer process (16 in Chromium) and, past the cap, kill
// the oldest one. Babylon's `engine.dispose()` does NOT release its context by
// default: it lingers until garbage collection. Switching the dashboard between
// the overview and a session unmounts one set of 3D panels and mounts another,
// so without an explicit release the disposed contexts and the new ones add up
// past the cap and a live canvas (a panel, or the embedding page's own scene)
// loses its context. `loseContextOnDispose` frees each context the moment its
// panel unmounts.

import type { EngineOptions } from "@babylonjs/core/Engines/thinEngine.js";

/** The `Engine` options every 3D panel constructs its engine with. */
export const PANEL_ENGINE_OPTIONS: EngineOptions = {
  preserveDrawingBuffer: false,
  loseContextOnDispose: true,
};
