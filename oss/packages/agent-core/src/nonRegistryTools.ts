import { z } from "zod";
import type { ReadTool } from "./tools.js";

/**
 * **Read tools that are not registry metrics** (ADR 0051 §1).
 *
 * The catalog in `tools.ts` is generated from `@uptimizr/metrics`, and that is
 * the rule: a new aggregation reaches agents by getting a registry entry, never
 * by being added to a hand-written list. This module is the narrow, deliberate
 * exception — collector surfaces that an agent needs but that are **not
 * metrics** and so have no registry entry to generate from.
 *
 * There is exactly one today: `list_subscriptions` (#311, ADR 0051 §6). A
 * subscription is project *configuration*, not a measurement; it has no rows, no
 * unit, no comparable column, and no window. Inventing a registry entry for it
 * would put a non-metric into the catalog that every other consumer (OpenAPI,
 * the docs tables, the insight primitives' "comparable metrics" lists) treats as
 * a measurement.
 *
 * Anything that *is* a measurement belongs in the registry instead. If this file
 * grows past a handful of entries, that is the signal that the boundary has
 * moved and the registry should absorb them.
 *
 * ## Writing subscriptions
 *
 * `create_subscription` / `delete_subscription` are deliberately absent. They
 * are mutations, and the MCP server has no write path at all on this branch (see
 * `@uptimizr/mcp`'s `server.ts`: `CollectorClient` exposes only `get`). They land
 * with the `annotate`-gated write-tool surface introduced by the metadata write
 * path (#310); until then an agent creates a subscription over plain HTTP with
 * an `annotate` key, or an operator does it with
 * `uptimizr subscriptions add --file`.
 */

/** One `ReadTool` per non-metric collector read an agent should have. */
export const NON_REGISTRY_READ_TOOLS: readonly ReadTool[] = [
  {
    name: "list_subscriptions",
    title: "List conditional subscriptions",
    description:
      "The project's standing conditional subscriptions (ADR 0051 §6): what the collector is " +
      "watching for, how often it checks, where a firing is delivered, and how each one last " +
      "went (`lastFiredAt`, `failures`, `lastError`). Configuration, not a measurement — it " +
      "takes no time range. Any webhook secret is masked and never returned. Needs only the " +
      "`query` capability; creating or deleting one needs `annotate` and is not available as a " +
      "tool.\n\nCaveats: this is what the project is configured to watch for, not a measurement " +
      "of anything. A subscription that has never fired may mean the condition never occurred, " +
      "or that it is disabled, or that its `minSample` gate was never cleared — check `enabled` " +
      "and the subscription's own firing log (`GET /api/v1/subscriptions/:id/events`) before " +
      "concluding anything about the underlying metric.",
    inputSchema: {},
    outputSchema: z.object({
      rows: z
        .array(
          z.object({
            id: z.string(),
            name: z.string(),
            metric: z.string().describe("Registry metric id the subscription watches."),
            predicate: z
              .record(z.string(), z.unknown())
              .describe("Closed union discriminated on `kind`."),
            enabled: z.boolean(),
            lastFiredAt: z
              .string()
              .nullable()
              .describe("ISO timestamp of the last firing, or null if it never fired."),
            failures: z.number().describe("Consecutive delivery failures since the last success."),
            lastError: z.string().nullable(),
          }),
        )
        .describe("One row per subscription, oldest first."),
    }),
    buildRequest: () => ({ path: "api/v1/subscriptions", params: {} }),
  },
];
