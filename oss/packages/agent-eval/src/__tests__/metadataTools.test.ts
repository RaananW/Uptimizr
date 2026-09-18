/**
 * Evaluation cases for the **metadata write tools** (#310, ADR 0051 §5).
 *
 * The read bank in `cases/*.yaml` scores answers; these cases score *actions*,
 * which is a different question and needs a different shape — the outcome of a
 * write is a stored row and a status code, not a sentence. Like every other
 * case they run against the real fixture-backed collector (real DuckDB, real
 * Fastify, real capability checks), deterministically and without a secret, so
 * they hold in CI alongside the scripted provider.
 *
 * Two things are proved here, and they are the two the feature lives or dies on:
 *
 * 1. a key **with** `annotate` can leave a note, define a term and save an
 *    analysis, and can read all three back;
 * 2. a key **without** it is refused every one of them — by the collector, not
 *    by the client — while its reads keep working.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CollectorError, writeTools, type WriteTool } from "@uptimizr/agent-core";
import { startHarness, type EvalHarness } from "../harness.js";

const byName = new Map<string, WriteTool>(writeTools.map((tool) => [tool.name, tool]));

function tool(name: string): WriteTool {
  const found = byName.get(name);
  if (!found) throw new Error(`no such metadata tool: ${name}`);
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

describe("a key holding `annotate`", () => {
  let harness: EvalHarness;

  beforeAll(async () => {
    harness = await startHarness({ capabilities: ["query", "annotate"] });
  }, 60_000);

  afterAll(async () => {
    await harness?.close();
  });

  it("leaves a note that reads back, attributed to an agent", async () => {
    const created = (await tool("annotate").execute(harness.client, {
      targetKind: "scene",
      targetId: "gallery",
      text: "Dwell in the gallery doubled after the lighting change.",
    })) as { id: string; authorKind: string; targetId: string };

    expect(created.targetId).toBe("gallery");
    // The collector decides authorship from the calling client, and this client
    // is not a dashboard session.
    expect(created.authorKind).toBe("agent");

    const listed = (await tool("list_annotations").execute(harness.client, {})) as {
      id: string;
      text: string;
    }[];
    expect(listed.map((row) => row.id)).toContain(created.id);
  });

  it("defines a term idempotently and reads the glossary back", async () => {
    await tool("define_term").execute(harness.client, {
      term: "gallery",
      meaning: "the long hall visitors enter through",
    });
    const updated = (await tool("define_term").execute(harness.client, {
      term: "gallery",
      meaning: "the long hall visitors enter through, including the alcoves",
    })) as { meaning: string };
    expect(updated.meaning).toMatch(/alcoves/);

    const glossary = (await tool("list_glossary").execute(harness.client, {})) as {
      term: string;
    }[];
    expect(glossary.filter((entry) => entry.term === "gallery")).toHaveLength(1);
  });

  it("saves an analysis with its question and conclusion", async () => {
    const saved = (await tool("save_analysis").execute(harness.client, {
      title: "Gallery attention",
      query: { metric: "mesh_dwell", scene: "gallery" },
      conclusion: "Dwell concentrates on two meshes; the rest of the hall is ignored.",
    })) as { id: string; query: Record<string, unknown>; conclusion: string };

    expect(saved.query).toEqual({ metric: "mesh_dwell", scene: "gallery" });
    expect(saved.conclusion).toMatch(/two meshes/);

    const analyses = (await tool("list_analyses").execute(harness.client, {})) as { id: string }[];
    expect(analyses.map((row) => row.id)).toContain(saved.id);
  });

  it("is still refused a payload the schema bounds", async () => {
    const status = await refusalStatus(() =>
      tool("annotate").execute(harness.client, { targetKind: "mesh", text: "no target id" }),
    );
    expect(status).toBe(400);
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

  it("is refused every write with a 403", async () => {
    const attempts: Array<[string, Record<string, unknown>]> = [
      ["annotate", { targetKind: "project", text: "not allowed" }],
      ["define_term", { term: "gallery", meaning: "not allowed" }],
      ["save_analysis", { title: "not allowed", query: {} }],
    ];
    for (const [name, args] of attempts) {
      expect(await refusalStatus(() => tool(name).execute(harness.client, args)), name).toBe(403);
    }
  });

  it("can still read the metadata it may not write", async () => {
    await expect(tool("list_annotations").execute(harness.client, {})).resolves.toEqual([]);
    await expect(tool("list_glossary").execute(harness.client, {})).resolves.toEqual([]);
    await expect(tool("list_analyses").execute(harness.client, {})).resolves.toEqual([]);
  });

  it("wrote nothing: the refused calls left the project empty", async () => {
    const annotations = (await tool("list_annotations").execute(harness.client, {})) as unknown[];
    expect(annotations).toHaveLength(0);
  });
});
