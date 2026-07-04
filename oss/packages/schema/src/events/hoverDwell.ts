import { z } from "zod";
import { defineEvent } from "./defineEvent.js";
import { inputSourceShape } from "./inputSource.js";
import { vec2Schema } from "../primitives.js";

/**
 * Hover hesitation (#48, design §D) — the pointer lingered over an object
 * *without acting on it*. A high hover-without-action time is the classic
 * "users don't realize this is interactive" signal: people pause where they
 * expect a response and then move on. Pairs with dead clicks (#46) and rage
 * clicks (#47) as the interaction-quality / frustration trio.
 *
 * Like object dwell (#37), hover is per-frame client work the server cannot
 * reconstruct, so the connector accumulates it on the client and emits **one
 * bucketed summary per object per hover** (ADR 0012) rather than a per-frame
 * stream. It carries the shared input-source vocabulary (ADR 0011), so a mouse
 * hover and an XR-controller point land in the same signal.
 *
 * Privacy (ADR 0003): `mesh` is a low-cardinality, app-defined object name and
 * `dwellMs` is a coarse aggregate, never a per-frame trace. The signal is
 * opt-in.
 */
export const hoverDwellSchema = defineEvent("hover_dwell", {
  /** Name of the mesh/object the pointer hovered over. */
  mesh: z.string().min(1),
  /** Milliseconds the pointer dwelt on the object without acting on it. */
  dwellMs: z.number().nonnegative(),
  /**
   * Texture-space UV `[u, v]` where the pointer last dwelt on `mesh`, when the
   * connector can resolve it (e.g. Babylon `PickingInfo.getTextureCoordinates()`).
   * Feeds the per-mesh UV-space heatmap. Not clamped to `[0, 1]`: UVs can fall
   * outside that range under texture wrapping/tiling.
   */
  uv: vec2Schema.optional(),
  ...inputSourceShape,
});
export type HoverDwellEvent = z.infer<typeof hoverDwellSchema>;
