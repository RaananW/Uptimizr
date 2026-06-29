import type { CoordinateHandedness, UpAxis } from "@uptimizr/schema";

/**
 * The **native** world coordinate frame of a web-export engine (ADR 0018 / ADR
 * 0045). A web-export connector records this as connector provenance on
 * `session_start` and normalizes every world-space payload pushed over the bridge
 * to the canonical wire frame (left-handed, y-up, unit scale 1) at the emission
 * boundary.
 *
 * | Engine | handedness | upAxis | unitScale (world units / meter) |
 * | ------ | ---------- | ------ | ------------------------------- |
 * | Unity  | `left`     | `y`    | `1` (meters) — already canonical |
 * | Godot  | `right`    | `y`    | `1` (meters) — negate Z          |
 * | Unreal | `left`     | `z`    | `100` (centimeters) — rebase + scale |
 *
 * `unitScale` follows the schema convention: **world units per meter** (so Unreal's
 * centimeters are `100`). Canonical output is always meters, so positions are
 * divided by `unitScale` at the boundary.
 */
export interface NativeFrame {
  /** Handedness of the engine's native world frame. */
  handedness: CoordinateHandedness;
  /** Up axis of the engine's native world frame (`"y"` or `"z"`). */
  upAxis: UpAxis;
  /** World units per meter (`1` = meters, `100` = centimeters). */
  unitScale: number;
}
