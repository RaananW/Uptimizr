import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { PanelSpecV1 } from "@uptimizr/schema";
import { createDuckdbClient, type DuckdbClient } from "../duckdb/client.js";
import { migrateDuckdb } from "../duckdb/migrations.js";
import { METADATA_LIMITS, MetadataLimitError, parsePanelSpec } from "../metadata.js";
import {
  createPanelSpec,
  deletePanelSpec,
  listPanelSpecs,
  updatePanelSpec,
} from "../duckdb/panelSpecs.js";

/**
 * Panel-spec storage on the OSS DuckDB store (#315, ADR 0051 §7 / sketch §G.3):
 * the CRUD round trip, per-project isolation, the cap that keeps a dashboard
 * from being pinned into uselessness, and the two things this table does
 * differently from the other three metadata tables — it orders oldest-first
 * (these are grid positions, not a feed) and it can be updated in place.
 */

const PID = "p1";
const OTHER_PID = "p2";

const author = { authorKind: "user", authorKeyId: "key_1" } as const;
const agentAuthor = { authorKind: "agent", authorKeyId: "key_2" } as const;

function spec(title: string, overrides: Partial<PanelSpecV1> = {}): PanelSpecV1 {
  return {
    v: 1,
    title,
    chart: "bar",
    span: 1,
    query: { v: 1, metric: "top_meshes", range: "inherit", limit: 10 },
    ...overrides,
  } as PanelSpecV1;
}

describe("duckdb panel specs", () => {
  let db: DuckdbClient;

  beforeEach(async () => {
    db = await createDuckdbClient(":memory:");
    await migrateDuckdb(db);
  });

  afterEach(async () => {
    await db.close();
  });

  it("round-trips a spec with its authorship and timestamps", async () => {
    const saved = await createPanelSpec(db, PID, {
      ...agentAuthor,
      spec: spec("Top meshes", { note: "The crate wins by three to one." }),
    });

    expect(saved.id).toMatch(/[0-9a-f-]{36}/);
    expect(saved.projectId).toBe(PID);
    expect(saved.spec.title).toBe("Top meshes");
    expect(saved.spec.note).toBe("The crate wins by three to one.");
    expect(saved.spec.query.range).toBe("inherit");
    expect(saved.authorKind).toBe("agent");
    expect(saved.authorKeyId).toBe("key_2");
    expect(saved.createdAt).toBeInstanceOf(Date);
    expect(saved.updatedAt).toBeInstanceOf(Date);

    const listed = await listPanelSpecs(db, PID);
    expect(listed).toHaveLength(1);
    expect(listed[0]).toEqual(saved);
  });

  it("lists oldest first — a pinned panel keeps its place when another is added", async () => {
    const first = await createPanelSpec(db, PID, { ...author, spec: spec("First") });
    const second = await createPanelSpec(db, PID, { ...author, spec: spec("Second") });
    const third = await createPanelSpec(db, PID, { ...author, spec: spec("Third") });

    const listed = await listPanelSpecs(db, PID);
    expect(listed.map((row) => row.id)).toEqual([first.id, second.id, third.id]);
    expect(listed.map((row) => row.spec.title)).toEqual(["First", "Second", "Third"]);
  });

  it("keeps one project's panels invisible to another", async () => {
    await createPanelSpec(db, PID, { ...author, spec: spec("Mine") });
    await createPanelSpec(db, OTHER_PID, { ...author, spec: spec("Theirs") });

    expect((await listPanelSpecs(db, PID)).map((row) => row.spec.title)).toEqual(["Mine"]);
    expect((await listPanelSpecs(db, OTHER_PID)).map((row) => row.spec.title)).toEqual(["Theirs"]);
  });

  it("updates a spec in place, keeping the id and the original author", async () => {
    const saved = await createPanelSpec(db, PID, { ...agentAuthor, spec: spec("Before") });
    const updated = await updatePanelSpec(db, PID, saved.id, {
      spec: spec("After", { span: 2, chart: "table" }),
    });

    expect(updated).not.toBeNull();
    expect(updated!.id).toBe(saved.id);
    expect(updated!.spec.title).toBe("After");
    expect(updated!.spec.span).toBe(2);
    expect(updated!.spec.chart).toBe("table");
    // Who pinned it is a fact about when it appeared, and an edit does not
    // change that.
    expect(updated!.authorKind).toBe("agent");
    expect(updated!.authorKeyId).toBe("key_2");
    expect(updated!.createdAt.getTime()).toBe(saved.createdAt.getTime());

    const listed = await listPanelSpecs(db, PID);
    expect(listed).toHaveLength(1);
    expect(listed[0]!.spec.title).toBe("After");
  });

  it("refuses to update or delete a row belonging to another project", async () => {
    const saved = await createPanelSpec(db, PID, { ...author, spec: spec("Mine") });

    expect(await updatePanelSpec(db, OTHER_PID, saved.id, { spec: spec("Hijacked") })).toBeNull();
    expect(await deletePanelSpec(db, OTHER_PID, saved.id)).toBe(false);
    expect((await listPanelSpecs(db, PID))[0]!.spec.title).toBe("Mine");
  });

  it("deletes a panel, and reports an unknown id honestly", async () => {
    const saved = await createPanelSpec(db, PID, { ...author, spec: spec("Doomed") });
    expect(await deletePanelSpec(db, PID, saved.id)).toBe(true);
    expect(await listPanelSpecs(db, PID)).toEqual([]);
    expect(await deletePanelSpec(db, PID, saved.id)).toBe(false);
    expect(await deletePanelSpec(db, PID, "no-such-id")).toBe(false);
  });

  it("refuses the write that would take the project past its cap", async () => {
    for (let i = 0; i < METADATA_LIMITS.panelSpecs; i++) {
      await createPanelSpec(db, PID, { ...author, spec: spec(`Panel ${i}`) });
    }
    await expect(
      createPanelSpec(db, PID, { ...author, spec: spec("One too many") }),
    ).rejects.toBeInstanceOf(MetadataLimitError);

    // The cap is per project, and a full project can still be pruned and refilled.
    await expect(
      createPanelSpec(db, OTHER_PID, { ...author, spec: spec("Somebody else's first") }),
    ).resolves.toBeTruthy();
    const listed = await listPanelSpecs(db, PID);
    expect(listed).toHaveLength(METADATA_LIMITS.panelSpecs);
    await deletePanelSpec(db, PID, listed[0]!.id);
    await expect(
      createPanelSpec(db, PID, { ...author, spec: spec("Room again") }),
    ).resolves.toBeTruthy();
  });

  it("skips a row whose stored spec is not a document, rather than failing the listing", async () => {
    const good = await createPanelSpec(db, PID, { ...author, spec: spec("Renderable") });
    await db.run(
      `INSERT INTO panel_specs (id, project_id, spec, author_kind, author_key_id)
       VALUES ('corrupt', $projectId, 'not json at all', 'user', NULL)`,
      { projectId: PID },
    );

    // One bad row never blocks the rest — the same posture ADR 0041's loader
    // takes for a remote panel module that fails to import.
    expect(parsePanelSpec("not json at all")).toBeNull();
    const listed = await listPanelSpecs(db, PID);
    expect(listed.map((row) => row.id)).toEqual([good.id]);
  });
});
