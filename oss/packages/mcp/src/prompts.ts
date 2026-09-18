import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

/**
 * Curated prompt templates for common 3D-analytics investigations (ADR 0050 §7).
 * Each renders a single user message that steers the agent to call the existing
 * read-only tools in a sensible order — no data is fetched here; the agent runs
 * the tools. Templates are intentionally tool-agnostic about exact arguments so
 * the agent can adapt (e.g. resolve the current epoch-ms range itself).
 */

const sceneArg = z
  .string()
  .optional()
  .describe("Optional scene id to scope the analysis to (see the uptimizr://scenes resource).");

const requiredSceneArg = z
  .string()
  .describe("The scene id to analyse (see the uptimizr://scenes resource).");

const forScene = (scene: string | undefined): string =>
  scene ? `scene "${scene}"` : "the project (all scenes)";

/** Register the curated prompt templates on the server. */
export function registerPrompts(server: McpServer): void {
  server.registerPrompt(
    "weekly_scene_health",
    {
      title: "Weekly scene health",
      description:
        "A weekly health check for a scene (or the whole project): traffic, event mix, " +
        "performance, and the most-interacted meshes.",
      argsSchema: { scene: sceneArg },
    },
    ({ scene }) => ({
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text:
              `Give me a weekly health report for ${forScene(scene)} covering the last 7 days.\n\n` +
              "Use these read-only tools and summarise the findings:\n" +
              "- `insight_movers` **first**" +
              (scene ? ` (scene="${scene}")` : "") +
              ": it compares every comparable metric with the previous equal window and ranks " +
              "the changes by how unusual each one is, so start from what actually moved instead " +
              "of re-deriving it. Read `direction` together with the sign of `delta` — a rise in " +
              "a `down` metric (errors, dead clicks, jank) is a regression — and do not report " +
              "any row with `aboveMinSample: false`: its delta is real arithmetic but not " +
              "evidence.\n" +
              "- `insight_baseline` for each metric that moved, to say whether the new level is " +
              "actually outside what is normal here — compare it with `median` give or take a " +
              "few `mad`, or with the p10..p90 band.\n" +
              // --- anomalies (#306) ---
              "- `insight_anomalies` (metric=`perf_summary`, then `error_heatmap`" +
              (scene ? `, scene="${scene}"` : "") +
              ", window=28) to put a **date** on whatever moved: it returns the individual days " +
              "that were out of line (`spike` / `drop`) and the day a level changed and stayed " +
              "changed (`shift`), with the `contributor` naming the mesh, channel or source " +
              "holding most of the excess. Quote the `bucketStart` and the `contributor` rather " +
              "than saying 'recently'.\n" +
              "- `event_counts` for the per-event-type mix" +
              (scene ? ` (scene="${scene}")` : "") +
              ".\n" +
              "- `timeseries` (interval ~86400s) to show the day-by-day event volume and average FPS trend.\n" +
              "- `perf_summary` for avg/min/p50 FPS.\n" +
              "- `top_meshes` for the most-interacted meshes.\n" +
              "- `list_sessions` for how many sessions were recorded.\n\n" +
              "Call out anything unusual (traffic spikes/drops, FPS regressions, error events), " +
              "say how far outside its baseline each one sits, and end with 2–3 concrete " +
              "recommendations.",
          },
        },
      ],
    }),
  );

  server.registerPrompt(
    "attention_hotspots",
    {
      title: "Attention hot-spots for a scene",
      description:
        "Find where visitors look and click in a scene: view-direction concentration, " +
        "gaze→mesh flow, and the objects that draw the most interaction.",
      argsSchema: { scene: requiredSceneArg },
    },
    ({ scene }) => ({
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text:
              `Where does attention concentrate in scene "${scene}"?\n\n` +
              'Use these read-only tools (all scoped with scene="' +
              scene +
              '") and synthesise the result:\n' +
              "- `camera_heatmap` for the view-direction distribution (what people look at).\n" +
              "- `flow_links` for how gaze flows into clicked meshes.\n" +
              "- `click_rays` for view-gated clicks per voxel/mesh.\n" +
              "- `top_meshes` for the most-interacted objects.\n\n" +
              "Describe the main hot-spots, any ignored/cold areas, and what that implies for the " +
              "scene's layout or call-to-action placement.",
          },
        },
      ],
    }),
  );

  server.registerPrompt(
    "xr_comfort_review",
    {
      title: "XR comfort & drop-off review",
      description:
        "Review VR/AR comfort signals for a scene (or the whole project): rapid head rotation, " +
        "locomotion style, session abandonment, and input-source mix.",
      argsSchema: { scene: sceneArg },
    },
    ({ scene }) => ({
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text:
              `Review XR/immersive comfort and drop-off for ${forScene(scene)}.\n\n` +
              "Use these read-only tools" +
              (scene ? ` (scene="${scene}")` : "") +
              " and correlate the signals:\n" +
              "- `xr_rotation` for rapid head/view turns (a motion-sickness proxy).\n" +
              "- `xr_locomotion` for the fly/navigate/teleport mix and session span.\n" +
              "- `xr_abandonment` for short XR sessions that signal headset drop-off.\n" +
              "- `xr_sources` for the hand vs. controller vs. gaze input split.\n\n" +
              "Flag likely-uncomfortable patterns (heavy rapid rotation or continuous locomotion " +
              "paired with early exits) and suggest comfort mitigations.",
          },
        },
      ],
    }),
  );
}
