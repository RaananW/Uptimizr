import { z } from "zod";
import { envelopeShape } from "../envelope.js";

/**
 * Builds an event schema by combining the shared envelope, a `type` discriminant,
 * and an event-specific payload shape.
 *
 * This is the primary extension point for the schema: adding a new event type is a
 * matter of calling `defineEvent("my_event", { ...payload })` in a new file and
 * registering it in `events/index.ts`. The envelope and discriminant wiring stays
 * consistent across every event automatically.
 *
 * @param type    The literal discriminant value (must be unique).
 * @param payload The event-specific field shape (a Zod raw shape).
 */
export function defineEvent<TType extends string, TPayload extends z.ZodRawShape>(
  type: TType,
  payload: TPayload,
) {
  return z.object({
    type: z.literal(type),
    ...envelopeShape,
    ...payload,
  });
}
