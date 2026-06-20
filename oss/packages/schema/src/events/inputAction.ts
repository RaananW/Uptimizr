import { z } from "zod";
import { defineEvent } from "./defineEvent.js";
import { inputSourceShape } from "./inputSource.js";

/**
 * A discrete, **non-pointer, non-ray** input (ADR 0023). This is the home for
 * keyboard keys/chords and gamepad buttons that map to an app action — the
 * inputs that do not fit the `pointer_*` / `mesh_interaction` ray model.
 * Pointer/ray inputs (mouse, touch, stylus, XR controller/hand aim, gamepad aim)
 * keep flowing through `pointer_*` / `mesh_interaction`; continuous stick-/key-
 * driven navigation stays in `camera_sample`.
 *
 * Unlike `pointer_*`, it carries **no `screen`, no `hitPoint`, no `ray`** — that
 * absence is what distinguishes a discrete action from a spatial pointer event.
 * It shares the source-neutral `inputSourceShape` (ADR 0011), so a keyboard and a
 * gamepad action land in the same signal distinguished by `source`.
 *
 * Privacy (ADR 0003): `action`/`code` are low-cardinality, app-defined labels —
 * never free user text or IME content. Connectors auto-capture only from an
 * explicit binding allowlist, so arbitrary typing is never recorded.
 */
export const inputActionSchema = defineEvent("input_action", {
  /**
   * The semantic, app-level action, e.g. `"rotate-left"` or `"next-camera"`.
   * Required: an action without a label is noise. A connector with no semantic
   * mapping falls back to the raw `code`/`button` token so the field is always
   * meaningful.
   */
  action: z.string().min(1).max(64),
  /** Raw key code (`KeyboardEvent.code`, e.g. `"KeyW"`) when `source` is `keyboard`. */
  code: z.string().min(1).max(64).optional(),
  /** Raw button index when `source` is `gamepad`. */
  button: z.number().int().nonnegative().optional(),
  /** Down vs. up, so press-and-hold can be reconstructed. Absent ⇒ a single discrete fire. */
  pressed: z.boolean().optional(),
  ...inputSourceShape,
});
export type InputActionEvent = z.infer<typeof inputActionSchema>;
