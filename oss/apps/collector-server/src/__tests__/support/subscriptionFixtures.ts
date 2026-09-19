import { LIMITS as SCHEMA_LIMITS } from "@uptimizr/schema";
import { MASKED_SECRET } from "@uptimizr/db";

/**
 * Shared constants for the subscription route suite (#311).
 *
 * Re-exported through this module rather than imported directly in the test so
 * the numbers and the mask come from the single definitions in
 * `@uptimizr/schema` and `@uptimizr/db` — a test that hard-codes `100` or
 * `"••••••••"` stops testing the bound the moment the bound moves.
 *
 * Not a test file — the filename has no `.test.` segment, so Vitest does not
 * collect it.
 */

export const LIMITS = SCHEMA_LIMITS;

/** What every read path shows in place of a stored webhook secret. */
export const MASKED_SECRET_PLACEHOLDER = MASKED_SECRET;
