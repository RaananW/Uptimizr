/**
 * Arguments a tool cannot be called without.
 *
 * Almost every tool in the generated catalog is callable with nothing but a time
 * range. A handful are not: the collector's querystring declares `funnel.steps`
 * and `mesh_uv_heatmap.mesh` required, and three routes carry an id in the path.
 * Those defaults live here, once, so the scripted provider and the
 * `derive-expectations` script agree on what a bare call to such a tool looks
 * like. They are **defaults, not expectations** — a case that cares about the
 * argument states it in `expectedArgs`, which always wins.
 */

/** Per-tool arguments merged into a bare call, keyed by tool name. */
export const REQUIRED_TOOL_ARGS: Readonly<Record<string, Readonly<Record<string, unknown>>>> = {
  funnel: {
    steps: JSON.stringify([{ type: "session_start" }, { type: "mesh_interaction" }]),
  },
  mesh_uv_heatmap: { mesh: "box" },
  session_meta: { sessionId: "s1" },
  session_trajectory: { sessionId: "s4" },
  scene_representation: { sceneId: "lobby" },
};
