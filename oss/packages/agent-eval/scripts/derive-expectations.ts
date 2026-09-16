/**
 * Print what every read tool actually returns over the seeded fixtures.
 *
 * This is how the question bank gets its numbers: `expectedAnswer.numbers` in
 * `cases/*.yaml` is **derived** from a real aggregation run, never hand-computed
 * (design sketch §H). Add a metric, run this, read the row, write the case.
 *
 *   pnpm --filter @uptimizr/agent-eval derive            # every tool
 *   pnpm --filter @uptimizr/agent-eval derive perf_summary jank_rate
 *   pnpm --filter @uptimizr/agent-eval derive --scene lobby top_meshes
 */

import { readTools } from "@uptimizr/agent-core";
import { startHarness } from "../src/harness.js";
import { EVAL_RANGE } from "../src/fixtures.js";
import { REQUIRED_TOOL_ARGS } from "../src/toolArgs.js";

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const sceneIndex = argv.indexOf("--scene");
  const scene = sceneIndex >= 0 ? argv[sceneIndex + 1] : undefined;
  const sceneValueIndex = sceneIndex >= 0 ? sceneIndex + 1 : -1;
  const wanted = new Set(argv.filter((arg, i) => !arg.startsWith("--") && i !== sceneValueIndex));

  const harness = await startHarness();
  try {
    for (const tool of readTools) {
      if (wanted.size > 0 && !wanted.has(tool.name)) continue;
      const args: Record<string, unknown> = {
        ...EVAL_RANGE,
        ...(scene && "scene" in tool.inputSchema ? { scene } : {}),
        ...(REQUIRED_TOOL_ARGS[tool.name] ?? {}),
      };
      for (const key of Object.keys(args)) {
        if (!(key in tool.inputSchema)) delete args[key];
      }
      try {
        const { path, params } = tool.buildRequest(args);
        const rows = await harness.client.get(path, params);
        console.log(`\n### ${tool.name}  (${path})`);
        console.log(JSON.stringify(rows));
      } catch (err) {
        console.log(`\n### ${tool.name}  — ERROR: ${(err as Error).message}`);
      }
    }
  } finally {
    await harness.close();
  }
}

await main();
