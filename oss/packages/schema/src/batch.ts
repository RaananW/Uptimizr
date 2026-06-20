import { z } from "zod";
import { anyEventSchema } from "./events/index.js";
import { SCHEMA_VERSION } from "./constants.js";
import { LIMITS } from "./limits.js";

/**
 * Wire format for `POST /api/v1/collect`.
 *
 * Clients send a `schemaVersion` plus a batch of events. The collector validates
 * each event, enriches it (server-set `visitorId`, optional geo), and stores it.
 *
 * Extensibility: `schemaVersion` lets the collector accept multiple SDK versions;
 * the optional `meta` block can carry transport-level hints without touching event
 * shapes.
 */
export const collectRequestSchema = z.object({
  /** Wire-format version the client was built against. */
  schemaVersion: z.string().default(SCHEMA_VERSION),
  /** One or more events captured during the session (bounded per batch). */
  events: z.array(anyEventSchema).min(1).max(LIMITS.maxBatchEvents),
  /** Optional transport-level metadata (reserved for forward-compatible hints). */
  meta: z.record(z.string(), z.unknown()).optional(),
});
export type CollectRequest = z.infer<typeof collectRequestSchema>;

/** Response returned by the collector after accepting a batch. */
export const collectResponseSchema = z.object({
  /** Number of events accepted and queued for storage. */
  accepted: z.number().int().nonnegative(),
  /** Number of events rejected (e.g. failed enrichment). */
  rejected: z.number().int().nonnegative().default(0),
});
export type CollectResponse = z.infer<typeof collectResponseSchema>;
