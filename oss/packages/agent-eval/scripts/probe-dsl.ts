/**
 * Ad-hoc probe: print what a handful of query-DSL documents return over the
 * seeded eval fixtures, so the stage-2 cases in `cases/query.yaml` are written
 * from real output rather than hand-computed (design sketch §H, the same rule
 * `derive-expectations.ts` follows for the per-metric tools).
 *
 *   pnpm --filter @uptimizr/agent-eval exec tsx scripts/probe-dsl.ts
 */

import { startHarness } from "../src/harness.js";
import { EVAL_RANGE, EVAL_T0 } from "../src/fixtures.js";

/** The parity sessions end and the supplement begins here. */
const HALF = EVAL_T0 + 20_000;

const PROBES: ReadonlyArray<{ label: string; query: Record<string, unknown> }> = [
  {
    label: "compare — mesh attention, late window vs early",
    query: {
      v: 1,
      metric: "top_meshes",
      range: { since: HALF, until: EVAL_RANGE.until },
      compare: { range: { since: EVAL_RANGE.since, until: HALF } },
      format: "summary",
    },
  },
  {
    label: "compare (table) — the same, with the envelope",
    query: {
      v: 1,
      metric: "top_meshes",
      range: { since: HALF, until: EVAL_RANGE.until },
      compare: { range: { since: EVAL_RANGE.since, until: HALF } },
      format: "table",
    },
  },
  {
    label: "generic group-by — events per device OS",
    query: {
      v: 1,
      metric: "event_counts",
      dimensions: ["device.os"],
      range: EVAL_RANGE,
      format: "full",
    },
  },
  {
    label: "generic group-by — interactions per browser",
    query: {
      v: 1,
      metric: "interaction_sources",
      dimensions: ["device.browser"],
      range: EVAL_RANGE,
      format: "full",
    },
  },
  {
    label: "explain — a metric whose channel is silent",
    query: { v: 1, metric: "xr_boundary_contacts", range: EVAL_RANGE, explain: true },
  },
  {
    label: "explain — mesh attention",
    query: { v: 1, metric: "top_meshes", range: EVAL_RANGE, explain: true },
  },
  {
    label: "400 — a group-by a spatial metric cannot do",
    query: {
      v: 1,
      metric: "pointer_heatmap",
      dimensions: ["session"],
      range: EVAL_RANGE,
    },
  },
];

async function main(): Promise<void> {
  const harness = await startHarness();
  try {
    for (const probe of PROBES) {
      console.log(`\n### ${probe.label}`);
      console.log(JSON.stringify(probe.query));
      try {
        const result = await harness.client.get("api/v1/query", {
          q: JSON.stringify(probe.query),
        });
        console.log(JSON.stringify(result, null, 2));
      } catch (error) {
        console.log(`ERROR: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  } finally {
    await harness.close();
  }
}

await main();
