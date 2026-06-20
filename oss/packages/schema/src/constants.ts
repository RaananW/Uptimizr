/**
 * Package-wide constants for the Uptimizr event schema.
 *
 * Extensibility: `SCHEMA_VERSION` lets producers and consumers negotiate format
 * changes over time. Bump the MINOR version for additive (backwards-compatible)
 * changes and the MAJOR version for breaking ones.
 */

/**
 * Semantic-ish version of the wire format. Sent on every batch so the collector
 * can evolve while remaining backwards compatible with older SDKs.
 */
export const SCHEMA_VERSION = "1.0" as const;

/**
 * Default scene/area identifier stamped on events when the host app never calls
 * `setScene(...)`. Keeps the scene dimension (ADR 0010) backwards-compatible: apps
 * that ignore scenes get a single `"default"` scene.
 */
export const DEFAULT_SCENE_ID = "default" as const;

/**
 * Canonical list of built-in event type identifiers.
 *
 * To add a new event type, add its literal here and register its schema in
 * `events/index.ts`. Keeping the literal union in one place makes exhaustiveness
 * checks fail loudly when a new type is added but not handled downstream.
 */
export const EVENT_TYPES = [
  "session_start",
  "session_end",
  "frame_perf",
  "camera_sample",
  "node_transform",
  "pointer_move",
  "pointer_click",
  "pointer_down",
  "pointer_up",
  "camera_gesture",
  "mesh_interaction",
  "mesh_visibility",
  "hover_dwell",
  "compile_stall",
  "resource_sample",
  "capability_change",
  "asset_load",
  "scene_change",
  "viewport_resize",
  "visibility_change",
  "focus_change",
  "context_lost",
  "context_restored",
  "runtime_error",
  "input_action",
  "custom",
] as const;

export type EventType = (typeof EVENT_TYPES)[number];
