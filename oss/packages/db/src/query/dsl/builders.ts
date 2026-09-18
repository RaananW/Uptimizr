/**
 * The registry's `builder` name → the aggregation function it names.
 *
 * Every `build*` in `aggregations.ts` has the same signature
 * `(projectId, opts, dialect) => QuerySpec`, and every registry entry with a
 * `builder` names one of them — an invariant two existing tests already hold
 * (`@uptimizr/metrics`' registry test asserts the registry covers
 * {@link AggregationBuilderName}, and this package's asserts that list is
 * exactly the `build*` exports). This module turns that name into the function,
 * which is the whole mechanism behind the delegated query tier: the DSL does not
 * know about seventy builders, it knows about the registry.
 *
 * The lookup is a namespace import rather than a hand-written table so a new
 * aggregation is reachable through the DSL the moment it is exported and
 * registered — there is no third list to forget.
 */

import * as aggregations from "../aggregations.js";
import type { AggregationBuilderName } from "@uptimizr/metrics";
import type { Dialect } from "../dialect.js";
import type { QuerySpec } from "../types.js";

/**
 * The shape every aggregation builder shares. The option bag is typed `never`
 * on the way in for callers and widened here: each builder takes its own
 * intersection of option interfaces, and the DSL assembles that bag dynamically
 * from the registry's `FILTER_TARGETS`, which no single static type can express.
 * What keeps it honest is {@link import("@uptimizr/metrics").validateQuery},
 * which rejects a filter the metric does not declare *before* anything is built.
 */
export type AggregationBuilder = (
  projectId: string,
  options: Record<string, unknown>,
  dialect: Dialect,
) => QuerySpec;

/** The module namespace, indexed by name. */
const BUILDERS = aggregations as unknown as Record<string, unknown>;

/**
 * The aggregation function a registry `builder` name refers to.
 *
 * Throws when the name is not an exported builder. That cannot happen through a
 * validated query — the registry's coverage tests would have failed the build
 * first — so the throw is a guard against a future refactor silently breaking
 * the link, not a client-facing error.
 */
export function builderFor(name: AggregationBuilderName): AggregationBuilder {
  const builder = BUILDERS[name];
  if (typeof builder !== "function") {
    throw new Error(`no aggregation builder is exported as '${name}'`);
  }
  return builder as AggregationBuilder;
}
