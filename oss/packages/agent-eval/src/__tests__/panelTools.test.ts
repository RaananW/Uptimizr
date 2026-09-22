/**
 * Evaluation cases for the **panel-spec tools** (#315, ADR 0051 §7).
 *
 * The sibling of `metadataTools.test.ts`, and for the same reason: the read
 * bank in `cases/*.yaml` scores answers, while these score *actions*. Pinning a
 * panel succeeds or fails as a stored row and a status code, not as a sentence.
 * Like every other case they run against the real fixture-backed collector
 * (real DuckDB, real Fastify, real capability and registry checks),
 * deterministically and without a secret.
 *
 * Three things are proved, and they are the three the feature lives or dies on:
 *
 * 1. an agent holding `annotate` can pin a panel, read it back with
 *    `list_panels`, and remove it with `unpin_panel`;
 * 2. a spec whose chart does not suit the metric's grain is **refused at pin
 *    time**, with the validator naming the charts that would have worked — this
 *    is what stops a chart with nothing to draw from sitting on somebody's
 *    dashboard for a week being read as a trend;
 * 3. a key without `annotate` is refused every write — by the collector, not by
 *    the client — while `list_panels` keeps working.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CollectorError, writeTools, type WriteTool } from "@uptimizr/agent-core";
import { startHarness, type EvalHarness } from "../harness.js";

const byName = new Map<string, WriteTool>(writeTools.map((tool) => [tool.name, tool]));

function tool(name: string): WriteTool {
  const found = byName.get(name);
  if (!found) throw new Error(`no such panel tool: ${name}`);
  return found;
}

/** The status a refused call came back with, or `null` if it was not refused. */
async function refusalStatus(run: () => Promise<unknown>): Promise<number | null> {
  try {
    await run();
    return null;
  } catch (err) {
    return err instanceof CollectorError ? err.status : -1;
  }
}

/** One stored panel row, as the collector returns it. */
interface StoredPanel {
  id: string;
  authorKind: string;
  spec: { title: string; chart: string; note?: string; query: { range: unknown } };
}

describe("an agent holding `annotate`", () => {
  let harness: EvalHarness;

  beforeAll(async () => {
    harness = await startHarness({ capabilities: ["query", "annotate"] });
  }, 60_000);

  afterAll(async () => {
    await harness?.close();
  });

  it("pins a panel, reads it back, and unpins it", async () => {
    const pinned = (await tool("pin_panel").execute(harness.client, {
      title: "Meshes people actually touch",
      chart: "bar",
      query: { v: 1, metric: "top_meshes", range: "inherit", limit: 10 },
      note: "The crate outsells everything else three to one.",
    })) as StoredPanel;

    expect(pinned.spec.title).toBe("Meshes people actually touch");
    expect(pinned.spec.chart).toBe("bar");
    // The pinned panel follows the dashboard's filter bar rather than freezing
    // the window the agent happened to ask in — the point of pinning at all.
    expect(pinned.spec.query.range).toBe("inherit");
    // The collector decides authorship from the calling client, and this client
    // is not a dashboard session.
    expect(pinned.authorKind).toBe("agent");

    const listed = (await tool("list_panels").execute(harness.client, {})) as StoredPanel[];
    expect(listed.map((row) => row.id)).toContain(pinned.id);
    expect(listed.find((row) => row.id === pinned.id)?.spec.note).toMatch(/three to one/);

    await tool("unpin_panel").execute(harness.client, { id: pinned.id });
    const after = (await tool("list_panels").execute(harness.client, {})) as StoredPanel[];
    expect(after.map((row) => row.id)).not.toContain(pinned.id);
  });

  it("is refused a chart the metric's grain cannot support, and told what would work", async () => {
    // `top_meshes` is a ranking: a line has no axis to walk along. Catching this
    // at pin time is the whole reason the registry validates the spec.
    const status = await refusalStatus(() =>
      tool("pin_panel").execute(harness.client, {
        title: "Meshes over time",
        chart: "line",
        query: { v: 1, metric: "top_meshes", range: "inherit" },
      }),
    );
    expect(status).toBe(400);

    // And nothing was stored.
    const listed = (await tool("list_panels").execute(harness.client, {})) as StoredPanel[];
    expect(listed.some((row) => row.spec.title === "Meshes over time")).toBe(false);
  });

  it("is refused a spec whose metric does not exist", async () => {
    expect(
      await refusalStatus(() =>
        tool("pin_panel").execute(harness.client, {
          title: "Invented",
          chart: "table",
          query: { v: 1, metric: "meshes_people_like", range: "inherit" },
        }),
      ),
    ).toBe(400);
  });

  it("answers 404 for a panel id that is not there", async () => {
    expect(
      await refusalStatus(() => tool("unpin_panel").execute(harness.client, { id: "no-such-id" })),
    ).toBe(404);
  });
});

describe("a key without `annotate`", () => {
  let harness: EvalHarness;

  beforeAll(async () => {
    harness = await startHarness({ capabilities: ["query"] });
  }, 60_000);

  afterAll(async () => {
    await harness?.close();
  });

  it("is refused every panel write by the collector", async () => {
    const attempts: [string, Record<string, unknown>][] = [
      [
        "pin_panel",
        {
          title: "Should not be stored",
          chart: "bar",
          query: { v: 1, metric: "top_meshes", range: "inherit" },
        },
      ],
      ["unpin_panel", { id: "anything" }],
    ];
    for (const [name, args] of attempts) {
      expect(await refusalStatus(() => tool(name).execute(harness.client, args)), name).toBe(403);
    }
  });

  it("can still read the project's pinned panels, and sees that nothing was written", async () => {
    const listed = (await tool("list_panels").execute(harness.client, {})) as StoredPanel[];
    expect(listed).toEqual([]);
  });
});
