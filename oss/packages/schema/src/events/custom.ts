import { z } from "zod";
import { defineEvent } from "./defineEvent.js";
import { LIMITS, boundedRecord } from "../limits.js";

/**
 * Developer-defined custom event. The open `props` record is the primary
 * application-level extension point: track domain-specific interactions without
 * changing the schema. Keep `props` shallow and JSON-serializable.
 */
export const customPropValueSchema = z.union([
  z.string().max(LIMITS.maxCustomPropValueLength),
  z.number(),
  z.boolean(),
  z.null(),
]);
export type CustomPropValue = z.infer<typeof customPropValueSchema>;

export const customSchema = defineEvent("custom", {
  /** Developer-chosen event name, e.g. `"add_to_cart"`. */
  name: z.string().min(1).max(LIMITS.maxCustomNameLength),
  /** Arbitrary, JSON-serializable properties (bounded count + value size). */
  props: boundedRecord(customPropValueSchema, LIMITS.maxCustomPropEntries).optional(),
});
export type CustomEvent = z.infer<typeof customSchema>;
