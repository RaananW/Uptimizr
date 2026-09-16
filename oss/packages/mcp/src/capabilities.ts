import { EVENT_TYPES, SCHEMA_VERSION, type EventType } from "@uptimizr/schema";
import { readTools } from "@uptimizr/agent-core";

/**
 * One tool the server exposes, described for self-discovery: its name, a human
 * title, what it returns, and the parameter names it accepts. Sourced directly
 * from the shared `@uptimizr/agent-core` catalog so it can never drift from the
 * tools actually registered (ADR 0050 §7).
 */
export interface CapabilityToolDescriptor {
  name: string;
  title: string;
  description: string;
  params: readonly string[];
}

/** A parameter name and what it means, shared across tools. */
export interface CapabilityParamDescriptor {
  name: string;
  description: string;
}

/**
 * Machine-readable capabilities/schema descriptor an agent can read (via the
 * `uptimizr://capabilities` resource) to learn what it can ask before guessing.
 * It is strictly a description of the **read-only** surface — event types, the
 * tool catalog, and parameter semantics — and never itself queries any data.
 */
export interface CapabilitiesDescriptor {
  /** Wire-format version of the event schema (`@uptimizr/schema`). */
  schemaVersion: string;
  /** The MCP surface is read-only: aggregate queries only, no raw events/PII. */
  readOnly: true;
  /** Canonical analytics event types (the single source of truth). */
  eventTypes: readonly EventType[];
  /** Glossary of every query parameter the tools accept. */
  params: readonly CapabilityParamDescriptor[];
  /** The read-only tool catalog (each entry is one aggregate query endpoint). */
  tools: readonly CapabilityToolDescriptor[];
  /** Human-oriented notes about scope and discovery. */
  notes: readonly string[];
}

/**
 * Semantics for every parameter used across the tool catalog. Kept in one place
 * so a param means the same thing everywhere; {@link buildCapabilities} only
 * surfaces the entries a tool actually uses, and a unit test asserts coverage.
 */
const PARAM_SEMANTICS: Readonly<Record<string, string>> = {
  since: "Start of the time range, epoch milliseconds (inclusive). Omit for all-time.",
  until: "End of the time range, epoch milliseconds (exclusive). Omit for up-to-now.",
  bins: "Grid resolution per axis for a binned heatmap (1–500).",
  limit: "Maximum rows to return (1–1000).",
  scene: "Restrict to one developer-assigned scene id (see the uptimizr://scenes resource).",
  session: "Scope the aggregate to a single session id.",
  cellSize: "Voxel edge length in world units for a spatial (world-space) aggregate.",
  interval: "Time-series bucket width in seconds.",
  type: "Restrict a time series to one event type (e.g. pointer_click).",
  source:
    "Input source filter: mouse, touch, stylus, pen, xr-controller, hand, gaze, transient, other.",
  cameraMode: "Camera navigation mode: 'viewer' (orbit) or 'first-person' (walkable).",
  rapidTurn: "Rapid-turn threshold in radians (0..π); XR view turns above this flag discomfort.",
  steps: "Funnel steps as a JSON-encoded array of ordered step predicates (ADR 0038).",
  sessionId: "The exact session id to describe.",
  sceneId: "The exact scene id to fetch.",
  // Parameters the generated catalog (ADR 0051 §1) surfaces for the metrics the
  // hand-written catalog never exposed. Semantics mirror the registry's
  // `FILTER_TARGETS`; #297 replaces this glossary with the registry itself.
  mesh: "Restrict to one mesh/object name (required for the per-mesh UV heatmap).",
  region:
    "World-space drill-down box `minX,minY,minZ,maxX,maxY,maxZ`; omit for the whole scene (ADR 0040 §4).",
  bucket: "Histogram bin width in FPS.",
  bucketMs: "Histogram bin width in milliseconds.",
  bucketSize: "Histogram bin width in world units.",
  minRepeats: "Minimum clicks in a window before it counts as a rage cluster.",
  windowMs: "How long before a session's end a performance dip still counts as correlated.",
  fpsThreshold: "A frame-perf sample below this FPS counts as a dip.",
  stallMs: "A shader-compile stall at least this long (ms) counts as a dip.",
  moveThreshold:
    "Inter-sample distance in world units above which a segment counts as active travel.",
  centerX: "X of the reference point camera distances are measured from.",
  centerY: "Y of the reference point camera distances are measured from.",
  centerZ: "Z of the reference point camera distances are measured from.",
  severity:
    "Graphics-diagnostic severity (info / warning / error / fatal); setting it excludes JS runtime errors.",
  category:
    "Graphics-diagnostic category (context-loss / validation / shader-compile / …); setting it excludes JS runtime errors.",
  errorKind:
    "Runtime-error kind (error / unhandledrejection); setting it excludes engine diagnostics.",
  groupByOrigin: "Add the click-time standpoint voxel as a grouping dimension.",
  originVoxel: "Restrict to clicks whose standpoint falls in this `vx,vy,vz` voxel.",
  bands:
    "Ascending, comma-separated load-time band boundaries in ms; omit for the default 1000,3000,5000.",
  variant:
    "JSON funnel-step predicate selecting the variant events; omit to treat every custom event as a variant.",
  conversion: "JSON funnel-step predicate for the success event; omit to report views only.",
};

/**
 * Build the capabilities descriptor from the live tool catalog and the event
 * schema. Pure and synchronous — it introspects definitions only, never the
 * collector, so it is safe to serve as a static resource.
 */
export function buildCapabilities(): CapabilitiesDescriptor {
  const tools: CapabilityToolDescriptor[] = readTools.map((tool) => ({
    name: tool.name,
    title: tool.title,
    description: tool.description,
    params: Object.keys(tool.inputSchema),
  }));

  const usedParams = new Set<string>();
  for (const tool of tools) for (const p of tool.params) usedParams.add(p);

  const params: CapabilityParamDescriptor[] = [...usedParams]
    .sort()
    .map((name) => ({ name, description: PARAM_SEMANTICS[name] ?? "" }));

  return {
    schemaVersion: SCHEMA_VERSION,
    readOnly: true,
    eventTypes: EVENT_TYPES,
    params,
    tools,
    notes: [
      "This MCP surface is strictly read-only: aggregate, privacy-preserving queries only. " +
        "There are no ingestion, mutation, or raw per-session event tools (ADR 0003 / ADR 0017).",
      "Enumerate the concrete scene ids for the `scene` parameter with the uptimizr://scenes " +
        "resource or the list_scenes tool; enumerate sessions with the list_sessions tool.",
      "All time ranges use epoch-millisecond `since`/`until`. Omit both for all-time.",
    ],
  };
}
