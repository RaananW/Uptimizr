/**
 * Zod mirrors of the three result envelopes — **re-exported**, not redefined.
 *
 * The collector attaches each route's 200 response schema from the registry so
 * the Zod type provider **serialises through it** — which means the `table` and
 * `summary` envelopes need schemas too, or a formatted response would be
 * stripped down to nothing on its way out. `resultEnvelopeSchema(full, row)`
 * builds the union a formatted route responds with: the untouched `full` shape
 * first, so a default request is validated by exactly the schema it has always
 * been validated by, then the two envelopes.
 *
 * The definitions themselves now live in `@uptimizr/metrics`, next to the row
 * schemas they wrap (#350): `@uptimizr/agent-core` and `@uptimizr/mcp` need the
 * same shapes to describe a tool's result, and neither may depend on this
 * package — it carries the DuckDB driver. This module keeps the names and the
 * signatures `@uptimizr/db` has always exported, so nothing downstream changes.
 */

import type { z } from "zod";
import {
  resultEnvelopeSchema as envelopeSchema,
  resultFormatSchema,
  summaryEnvelopeSchema,
  tableEnvelopeSchema,
} from "@uptimizr/metrics";
import type { ResultFormat } from "./types.js";

export { resultFormatSchema };

/** Fails to compile if the schema and {@link ResultFormat} ever drift apart. */
type AssertFormatsAgree = [
  z.infer<typeof resultFormatSchema> extends ResultFormat ? true : never,
  ResultFormat extends z.infer<typeof resultFormatSchema> ? true : never,
];
export type ResultFormatsAgree = AssertFormatsAgree;

/** `format=summary`: one of the four grain-driven shapes. */
export const resultSummarySchema = summaryEnvelopeSchema;

/** `format=table`: the `meta` envelope around a metric's own row schema. */
export function tableResultSchema(row: z.ZodType): z.ZodObject {
  return tableEnvelopeSchema(row);
}

/**
 * The 200 response schema of a route that honours `format`: the union of the
 * three envelopes.
 *
 * Order matters. `full` is first, so a default request is parsed by precisely
 * the schema it was parsed by before this existed and its bytes cannot drift.
 * The envelopes are unambiguous against it — `table` is an object with `meta`
 * and `rows`, `summary` an object with `kind` and `reading`, and neither can
 * satisfy a row array or a stats row's required numeric columns.
 *
 * A route's own `full` schema is passed explicitly because a single-record
 * endpoint (the spatial `stats` routes) answers with a bare object rather than
 * an array of rows.
 */
export function resultEnvelopeSchema(full: z.ZodType, row: z.ZodType): z.ZodType {
  return envelopeSchema(row, full);
}
