import { z } from "zod";
import type { QueryParams } from "./client.js";

/** A resolved read request: the collector path and its query parameters. */
export interface ReadToolRequest {
  path: string;
  params: QueryParams;
}

/**
 * A read-only tool definition. `inputSchema` is a Zod raw shape the MCP runtime
 * uses to validate arguments; `buildRequest` maps validated arguments to a
 * `GET` against the collector. Definitions are pure and unit-testable without a
 * live collector.
 */
export interface ReadTool {
  name: string;
  title: string;
  description: string;
  inputSchema: z.ZodRawShape;
  buildRequest: (args: Record<string, unknown>) => ReadToolRequest;
}

const num = (v: unknown): number | undefined => (typeof v === "number" ? v : undefined);
const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);

// Shared, reusable input fields (all optional unless a tool needs otherwise).
const since = z.number().int().optional().describe("Start of the time range, epoch milliseconds.");
const until = z.number().int().optional().describe("End of the time range, epoch milliseconds.");
const bins = z.number().int().positive().max(500).optional().describe("Grid resolution per axis.");
const limit = z.number().int().positive().max(1000).optional().describe("Maximum rows to return.");
const scene = z.string().optional().describe("Restrict to one developer-assigned scene id.");
const session = z.string().optional().describe("Scope the aggregate to a single session id.");
const cellSize = z.number().positive().max(1000).optional().describe("Voxel size in world units.");
const interval = z
  .number()
  .int()
  .positive()
  .optional()
  .describe("Time-series bucket width, seconds.");
const eventType = z
  .string()
  .optional()
  .describe("Restrict to a single event type, e.g. pointer_click.");
const source = z
  .enum(["mouse", "touch", "stylus", "pen", "xr-controller", "hand", "gaze", "transient", "other"])
  .optional()
  .describe("Restrict a pointer/world heatmap to one input source.");
const cameraMode = z
  .enum(["viewer", "first-person"])
  .optional()
  .describe("Camera navigation mode to scope to: 'viewer' (orbit) or 'first-person' (walkable).");
const rapidTurn = z
  .number()
  .nonnegative()
  .max(Math.PI)
  .optional()
  .describe(
    "Rapid-turn threshold in radians (0..π); view turns above this flag motion-sickness risk.",
  );
const steps = z
  .string()
  .min(1)
  .describe(
    "Funnel steps as a JSON-encoded array of ordered step predicates (ADR 0038). Required. " +
      'Each step is `{ "type": <event_type>, ... }`; e.g. ' +
      '`[{"type":"scene_change","to":"lobby"},{"type":"mesh_interaction","mesh":"buy"}]`.',
  );

/** Build the common `{ since, until }` range params from validated args. */
function range(args: Record<string, unknown>): QueryParams {
  return { since: num(args.since), until: num(args.until) };
}

/**
 * The catalog of read-only tools. Each wraps one documented collector query
 * endpoint (docs/integration.md §Query). There are intentionally **no**
 * ingestion, mutation, or raw per-session event tools — the surface is
 * aggregate, read-only, and privacy-preserving (ADR 0003 / ADR 0017).
 */
export const readTools: readonly ReadTool[] = [
  {
    name: "list_sessions",
    title: "List recent sessions",
    description: "Recent sessions with id, visitor, event count, and start/end times.",
    inputSchema: { since, until, limit },
    buildRequest: (args) => ({
      path: "api/v1/sessions",
      params: { ...range(args), limit: num(args.limit) },
    }),
  },
  {
    name: "pointer_heatmap",
    title: "2D pointer heatmap",
    description: "Binned 2D pointer-position heatmap (screen-normalized).",
    inputSchema: { since, until, bins, scene, source, session },
    buildRequest: (args) => ({
      path: "api/v1/heatmaps/pointer",
      params: {
        ...range(args),
        bins: num(args.bins),
        scene: str(args.scene),
        source: str(args.source),
        session: str(args.session),
      },
    }),
  },
  {
    name: "world_heatmap",
    title: "3D world-space pointer heatmap",
    description: "Voxelized world-space pointer heatmap.",
    inputSchema: { since, until, cellSize, limit, scene, source },
    buildRequest: (args) => ({
      path: "api/v1/heatmaps/world",
      params: {
        ...range(args),
        cellSize: num(args.cellSize),
        limit: num(args.limit),
        scene: str(args.scene),
        source: str(args.source),
      },
    }),
  },
  {
    name: "camera_heatmap",
    title: "View-direction heatmap",
    description: "Camera view-direction distribution as spherical bins.",
    inputSchema: { since, until, bins, scene, session },
    buildRequest: (args) => ({
      path: "api/v1/heatmaps/camera",
      params: {
        ...range(args),
        bins: num(args.bins),
        scene: str(args.scene),
        session: str(args.session),
      },
    }),
  },
  {
    name: "click_rays",
    title: "View-gated click rays",
    description: "Clicks ASOF-joined to their nearest camera sample, per voxel and clicked mesh.",
    inputSchema: { since, until, cellSize, limit, scene, source, session },
    buildRequest: (args) => ({
      path: "api/v1/heatmaps/click-rays",
      params: {
        ...range(args),
        cellSize: num(args.cellSize),
        limit: num(args.limit),
        scene: str(args.scene),
        source: str(args.source),
        session: str(args.session),
      },
    }),
  },
  {
    name: "flow_links",
    title: "Gaze→mesh flow links",
    description: "Aggregate links from camera-direction bins to clicked meshes.",
    inputSchema: { since, until, bins, limit, scene, session },
    buildRequest: (args) => ({
      path: "api/v1/heatmaps/flow",
      params: {
        ...range(args),
        bins: num(args.bins),
        limit: num(args.limit),
        scene: str(args.scene),
        session: str(args.session),
      },
    }),
  },
  {
    name: "top_meshes",
    title: "Most-interacted meshes",
    description: "Meshes ranked by interaction count.",
    inputSchema: { since, until, limit, session },
    buildRequest: (args) => ({
      path: "api/v1/meshes/top",
      params: { ...range(args), limit: num(args.limit), session: str(args.session) },
    }),
  },
  {
    name: "perf_summary",
    title: "Rendering performance summary",
    description: "Sample count and avg/min/p50 FPS over the range.",
    inputSchema: { since, until, session },
    buildRequest: (args) => ({
      path: "api/v1/perf",
      params: { ...range(args), session: str(args.session) },
    }),
  },
  {
    name: "list_scenes",
    title: "List active scenes",
    description: "Distinct developer-assigned scenes with activity.",
    inputSchema: { since, until, limit },
    buildRequest: (args) => ({
      path: "api/v1/scenes",
      params: { ...range(args), limit: num(args.limit) },
    }),
  },
  {
    name: "timeseries",
    title: "Event-volume time series",
    description: "Event-volume buckets over time, with average FPS per bucket.",
    inputSchema: { since, until, interval, scene, type: eventType },
    buildRequest: (args) => ({
      path: "api/v1/timeseries",
      params: {
        ...range(args),
        interval: num(args.interval),
        scene: str(args.scene),
        type: str(args.type),
      },
    }),
  },
  {
    name: "event_counts",
    title: "Per-event-type counts",
    description: "Counts per event type over the range (scene-health panel).",
    inputSchema: { since, until, scene },
    buildRequest: (args) => ({
      path: "api/v1/event-counts",
      params: { ...range(args), scene: str(args.scene) },
    }),
  },
  {
    name: "session_meta",
    title: "Session descriptor",
    description: "Coarse descriptor for one session (device/scene/user). No raw event stream.",
    inputSchema: { sessionId: z.string().min(1).describe("The session id to describe.") },
    buildRequest: (args) => ({
      path: `api/v1/sessions/${encodeURIComponent(str(args.sessionId) ?? "")}/meta`,
      params: {},
    }),
  },
  {
    name: "scene_representation",
    title: "Scene representation",
    description: "Registered proxy geometry (bounds/meshes) for one scene, if any.",
    inputSchema: { sceneId: z.string().min(1).describe("The scene id to fetch.") },
    buildRequest: (args) => ({
      path: `api/v1/scenes/${encodeURIComponent(str(args.sceneId) ?? "")}/representation`,
      params: {},
    }),
  },
  {
    name: "funnel",
    title: "Conversion funnel",
    description:
      "Ordered, per-session conversion funnel (ADR 0038): how many sessions reach each " +
      "caller-supplied step. Steps are a JSON array (see the `steps` argument).",
    inputSchema: { since, until, scene, cameraMode, steps },
    buildRequest: (args) => ({
      path: "api/v1/funnel",
      params: {
        ...range(args),
        scene: str(args.scene),
        cameraMode: str(args.cameraMode),
        steps: str(args.steps),
      },
    }),
  },
  {
    name: "aggregate_paths",
    title: "Aggregate desire-line paths",
    description:
      "Crowd-level movement routes (ADR 0037): every session's camera path binned onto the " +
      "ground grid and returned as ordered, session-keyed points for an overlaid route map.",
    inputSchema: { since, until, cellSize, limit, scene, cameraMode },
    buildRequest: (args) => ({
      path: "api/v1/paths",
      params: {
        ...range(args),
        cellSize: num(args.cellSize),
        limit: num(args.limit),
        scene: str(args.scene),
        cameraMode: str(args.cameraMode),
      },
    }),
  },
  {
    name: "rendering_technology",
    title: "Rendering-technology breakdown",
    description:
      "Rendering-technology mix from session_start.graphics (ADR 0046): session count per " +
      "(api, backend, api_version, shading_language) — WebGPU vs WebGL2 and shading language.",
    inputSchema: { since, until, scene, session },
    buildRequest: (args) => ({
      path: "api/v1/rendering-technology",
      params: { ...range(args), scene: str(args.scene), session: str(args.session) },
    }),
  },
  {
    name: "xr_rotation",
    title: "XR head-rotation rate",
    description:
      "XR head/view rotation rate (ADR 0048), a motion-sickness proxy: per-session rapid-turn " +
      "counts over the camera pose stream.",
    inputSchema: { since, until, rapidTurn, limit, scene, session },
    buildRequest: (args) => ({
      path: "api/v1/xr/rotation",
      params: {
        ...range(args),
        rapidTurn: num(args.rapidTurn),
        limit: num(args.limit),
        scene: str(args.scene),
        session: str(args.session),
      },
    }),
  },
  {
    name: "xr_sources",
    title: "XR input-source usage",
    description: "XR input-source split (ADR 0048): hand vs. controller vs. gaze usage.",
    inputSchema: { since, until, limit, scene, session },
    buildRequest: (args) => ({
      path: "api/v1/xr/sources",
      params: {
        ...range(args),
        limit: num(args.limit),
        scene: str(args.scene),
        session: str(args.session),
      },
    }),
  },
  {
    name: "xr_abandonment",
    title: "XR session abandonment",
    description:
      "XR session abandonment (ADR 0048): per XR session, its time bounds and event/interaction " +
      "counts; a short span signals headset drop-off.",
    inputSchema: { since, until, limit, scene, session },
    buildRequest: (args) => ({
      path: "api/v1/xr/abandonment",
      params: {
        ...range(args),
        limit: num(args.limit),
        scene: str(args.scene),
        session: str(args.session),
      },
    }),
  },
  {
    name: "xr_locomotion",
    title: "XR locomotion & comfort",
    description:
      "XR locomotion & comfort (ADR 0048): per XR session, its locomotion-style mix " +
      "(fly / navigate / teleport + duration) and wall-clock span — a discomfort proxy.",
    inputSchema: { since, until, limit, scene, session },
    buildRequest: (args) => ({
      path: "api/v1/xr/locomotion",
      params: {
        ...range(args),
        limit: num(args.limit),
        scene: str(args.scene),
        session: str(args.session),
      },
    }),
  },
];

/**
 * Names of the **core** read tools — a small, single-step-friendly subset of
 * {@link readTools} for small local models (ADR 0050). A 4-bit 7–8B model folds
 * every tool schema into its function-calling system prompt, so sending all 20
 * overwhelms it and degrades selection even for simple questions. This subset
 * covers the most common single-metric questions (recent sessions, active
 * scenes, top meshes, FPS, event counts, event volume over time, and one
 * view-direction heatmap).
 *
 * Plain string membership only — used to FILTER {@link readTools} below, never to
 * redefine any tool shape (schema lives once; ADR).
 */
export const CORE_READ_TOOL_NAMES: readonly string[] = [
  "list_sessions",
  "list_scenes",
  "top_meshes",
  "perf_summary",
  "event_counts",
  "timeseries",
  "camera_heatmap",
];

/**
 * The core read tools: a FILTERED VIEW of {@link readTools} (never a
 * re-declaration), preserving each tool's single source-of-truth definition.
 */
export const coreReadTools: readonly ReadTool[] = readTools.filter((tool) =>
  CORE_READ_TOOL_NAMES.includes(tool.name),
);

/** Which read-tool surface to expose to the model. */
export type ReadToolSetKind = "core" | "full";

/**
 * Select the read-tool set to hand a run. Small local models get the focused
 * {@link coreReadTools}; frontier hosted models get the {@link readTools} full
 * catalog. Both are views of the same single tool definitions.
 */
export function selectReadTools(kind: ReadToolSetKind): readonly ReadTool[] {
  return kind === "core" ? coreReadTools : readTools;
}
