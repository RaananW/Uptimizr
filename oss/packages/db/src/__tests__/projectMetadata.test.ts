import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDuckdbClient, type DuckdbClient } from "../duckdb/client.js";
import { migrateDuckdb } from "../duckdb/migrations.js";
import { METADATA_LIMITS, MetadataLimitError } from "../metadata.js";
import {
  createAnnotation,
  createSavedAnalysis,
  deleteAnnotation,
  deleteGlossaryEntry,
  deleteSavedAnalysis,
  listAnnotations,
  listGlossary,
  listSavedAnalyses,
  putGlossaryEntry,
} from "../duckdb/projectMetadata.js";

/**
 * Project-metadata storage on the OSS DuckDB store (ADR 0051 §5 / sketch §E.2):
 * the three write paths, their read/delete siblings, per-project isolation, and
 * the caps that keep a metadata table from becoming a growth surface.
 */

const PID = "p1";
const OTHER_PID = "p2";

const author = { authorKind: "user", authorKeyId: "key_1" } as const;
const agentAuthor = { authorKind: "agent", authorKeyId: "key_2" } as const;

describe("duckdb annotations", () => {
  let db: DuckdbClient;

  beforeEach(async () => {
    db = await createDuckdbClient(":memory:");
    await migrateDuckdb(db);
  });

  afterEach(async () => {
    await db.close();
  });

  it("round-trips a standing project note", async () => {
    const saved = await createAnnotation(db, PID, {
      ...author,
      annotation: { targetKind: "project", text: "v2.1 shipped" },
    });
    expect(saved.id).toMatch(/[0-9a-f-]{36}/);
    expect(saved.projectId).toBe(PID);
    expect(saved.targetId).toBeNull();
    expect(saved.since).toBeNull();
    expect(saved.until).toBeNull();
    expect(saved.authorKind).toBe("user");
    expect(saved.authorKeyId).toBe("key_1");
    expect(saved.createdAt).toBeInstanceOf(Date);

    const [read] = await listAnnotations(db, PID);
    expect(read).toEqual(saved);
  });

  it("round-trips a targeted, time-bounded note and records the agent author", async () => {
    const since = 1_700_000_000_000;
    const until = 1_700_003_600_000;
    const saved = await createAnnotation(db, PID, {
      ...agentAuthor,
      annotation: { targetKind: "mesh", targetId: "counter", since, until, text: "dead clicks" },
    });
    expect(saved.targetKind).toBe("mesh");
    expect(saved.targetId).toBe("counter");
    expect(saved.since?.getTime()).toBe(since);
    expect(saved.until?.getTime()).toBe(until);
    expect(saved.authorKind).toBe("agent");
  });

  it("lists newest first and filters by target", async () => {
    await createAnnotation(db, PID, {
      ...author,
      annotation: { targetKind: "scene", targetId: "lobby", text: "first" },
    });
    await createAnnotation(db, PID, {
      ...author,
      annotation: { targetKind: "mesh", targetId: "counter", text: "second" },
    });

    const byKind = await listAnnotations(db, PID, { targetKind: "mesh" });
    expect(byKind.map((a) => a.text)).toEqual(["second"]);

    const byId = await listAnnotations(db, PID, { targetId: "lobby" });
    expect(byId.map((a) => a.text)).toEqual(["first"]);
  });

  it("filters by overlap, keeping standing notes", async () => {
    await createAnnotation(db, PID, {
      ...author,
      annotation: { targetKind: "project", text: "standing" },
    });
    await createAnnotation(db, PID, {
      ...author,
      annotation: { targetKind: "window", since: 1_000, until: 2_000, text: "early" },
    });
    await createAnnotation(db, PID, {
      ...author,
      annotation: { targetKind: "window", since: 9_000, until: 10_000, text: "late" },
    });

    const overlapping = await listAnnotations(db, PID, { since: 1_500, until: 5_000 });
    expect(overlapping.map((a) => a.text).sort()).toEqual(["early", "standing"]);
  });

  it("honours the limit", async () => {
    for (let i = 0; i < 5; i += 1) {
      await createAnnotation(db, PID, {
        ...author,
        annotation: { targetKind: "project", text: `note ${i}` },
      });
    }
    expect(await listAnnotations(db, PID, { limit: 2 })).toHaveLength(2);
  });

  it("keeps projects apart on read and on delete", async () => {
    const mine = await createAnnotation(db, PID, {
      ...author,
      annotation: { targetKind: "project", text: "mine" },
    });
    await createAnnotation(db, OTHER_PID, {
      ...author,
      annotation: { targetKind: "project", text: "theirs" },
    });

    expect(await listAnnotations(db, PID)).toHaveLength(1);
    expect(await deleteAnnotation(db, OTHER_PID, mine.id)).toBe(false);
    expect(await listAnnotations(db, PID)).toHaveLength(1);
    expect(await deleteAnnotation(db, PID, mine.id)).toBe(true);
    expect(await listAnnotations(db, PID)).toHaveLength(0);
  });

  it("reports a missing id rather than throwing", async () => {
    expect(await deleteAnnotation(db, PID, "nope")).toBe(false);
  });
});

describe("duckdb glossary", () => {
  let db: DuckdbClient;

  beforeEach(async () => {
    db = await createDuckdbClient(":memory:");
    await migrateDuckdb(db);
  });

  afterEach(async () => {
    await db.close();
  });

  it("upserts by term instead of accumulating duplicates", async () => {
    await putGlossaryEntry(db, PID, { entry: { term: "TTFR", meaning: "time to first render" } });
    const updated = await putGlossaryEntry(db, PID, {
      entry: { term: "TTFR", meaning: "time to first rendered frame" },
    });
    expect(updated.meaning).toBe("time to first rendered frame");

    const all = await listGlossary(db, PID);
    expect(all).toHaveLength(1);
    expect(all[0]?.updatedAt).toBeInstanceOf(Date);
  });

  it("lists ordered by term and keeps projects apart", async () => {
    await putGlossaryEntry(db, PID, { entry: { term: "zeta", meaning: "last" } });
    await putGlossaryEntry(db, PID, { entry: { term: "alpha", meaning: "first" } });
    await putGlossaryEntry(db, OTHER_PID, { entry: { term: "other", meaning: "elsewhere" } });

    expect((await listGlossary(db, PID)).map((e) => e.term)).toEqual(["alpha", "zeta"]);
    expect((await listGlossary(db, OTHER_PID)).map((e) => e.term)).toEqual(["other"]);
  });

  it("deletes one term and reports a missing one", async () => {
    await putGlossaryEntry(db, PID, { entry: { term: "alpha", meaning: "first" } });
    expect(await deleteGlossaryEntry(db, PID, "alpha")).toBe(true);
    expect(await deleteGlossaryEntry(db, PID, "alpha")).toBe(false);
  });
});

describe("duckdb saved analyses", () => {
  let db: DuckdbClient;

  beforeEach(async () => {
    db = await createDuckdbClient(":memory:");
    await migrateDuckdb(db);
  });

  afterEach(async () => {
    await db.close();
  });

  it("round-trips the opaque query document and the conclusion", async () => {
    const saved = await createSavedAnalysis(db, PID, {
      ...agentAuthor,
      analysis: {
        title: "Lobby FPS",
        query: { metric: "perf_summary", scene: "lobby", nested: { range: "7d" } },
        conclusion: "p50 fell to 41.",
      },
    });
    expect(saved.query).toEqual({
      metric: "perf_summary",
      scene: "lobby",
      nested: { range: "7d" },
    });
    expect(saved.conclusion).toBe("p50 fell to 41.");
    expect(saved.authorKind).toBe("agent");

    const [read] = await listSavedAnalyses(db, PID);
    expect(read).toEqual(saved);
  });

  it("stores an analysis with no conclusion as null", async () => {
    const saved = await createSavedAnalysis(db, PID, {
      ...author,
      analysis: { title: "watch this", query: {} },
    });
    expect(saved.conclusion).toBeNull();
    expect(saved.query).toEqual({});
  });

  it("keeps projects apart and deletes by id", async () => {
    const mine = await createSavedAnalysis(db, PID, {
      ...author,
      analysis: { title: "mine", query: {} },
    });
    await createSavedAnalysis(db, OTHER_PID, {
      ...author,
      analysis: { title: "theirs", query: {} },
    });
    expect(await deleteSavedAnalysis(db, OTHER_PID, mine.id)).toBe(false);
    expect(await deleteSavedAnalysis(db, PID, mine.id)).toBe(true);
    expect(await listSavedAnalyses(db, PID)).toHaveLength(0);
    expect(await listSavedAnalyses(db, OTHER_PID)).toHaveLength(1);
  });
});

describe("per-project caps", () => {
  let db: DuckdbClient;

  beforeEach(async () => {
    db = await createDuckdbClient(":memory:");
    await migrateDuckdb(db);
  });

  afterEach(async () => {
    await db.close();
  });

  /** Fill a table to its cap with one INSERT so the test stays quick. */
  async function fill(table: string, columns: string, valueSql: string): Promise<void> {
    const limit =
      table === "annotations"
        ? METADATA_LIMITS.annotations
        : table === "glossary"
          ? METADATA_LIMITS.glossary
          : METADATA_LIMITS.savedAnalyses;
    await db.run(
      `INSERT INTO ${table} (${columns})
       SELECT ${valueSql} FROM range(0, ${limit}) AS t(i)`,
      {},
    );
  }

  it("refuses an annotation past the cap", async () => {
    await fill(
      "annotations",
      "id, project_id, target_kind, text",
      `CAST(i AS VARCHAR), 'p1', 'project', 'x'`,
    );
    await expect(
      createAnnotation(db, PID, {
        ...author,
        annotation: { targetKind: "project", text: "one more" },
      }),
    ).rejects.toBeInstanceOf(MetadataLimitError);
  });

  it("refuses a new glossary term past the cap but still updates an existing one", async () => {
    await fill("glossary", "project_id, term, meaning", `'p1', CAST(i AS VARCHAR), 'm'`);
    await expect(
      putGlossaryEntry(db, PID, { entry: { term: "brand new", meaning: "m" } }),
    ).rejects.toBeInstanceOf(MetadataLimitError);
    const updated = await putGlossaryEntry(db, PID, { entry: { term: "0", meaning: "redefined" } });
    expect(updated.meaning).toBe("redefined");
  });

  it("refuses a saved analysis past the cap", async () => {
    await fill(
      "saved_analyses",
      "id, project_id, title, query",
      `CAST(i AS VARCHAR), 'p1', 't', '{}'`,
    );
    await expect(
      createSavedAnalysis(db, PID, { ...author, analysis: { title: "one more", query: {} } }),
    ).rejects.toBeInstanceOf(MetadataLimitError);
  });

  it("counts the cap per project", async () => {
    await fill(
      "annotations",
      "id, project_id, target_kind, text",
      `CAST(i AS VARCHAR), 'p1', 'project', 'x'`,
    );
    const other = await createAnnotation(db, OTHER_PID, {
      ...author,
      annotation: { targetKind: "project", text: "room here" },
    });
    expect(other.projectId).toBe(OTHER_PID);
  });
});

describe("the metadata path never touches events", () => {
  let db: DuckdbClient;

  beforeEach(async () => {
    db = await createDuckdbClient(":memory:");
    await migrateDuckdb(db);
  });

  afterEach(async () => {
    await db.close();
  });

  it("leaves the events table empty after every kind of write", async () => {
    await createAnnotation(db, PID, {
      ...author,
      annotation: { targetKind: "project", text: "note" },
    });
    await putGlossaryEntry(db, PID, { entry: { term: "t", meaning: "m" } });
    await createSavedAnalysis(db, PID, { ...author, analysis: { title: "t", query: {} } });

    const rows = await db.all<{ n: number | bigint }>("SELECT count(*) AS n FROM events", {});
    expect(Number(rows[0]?.n ?? 0)).toBe(0);
  });
});
