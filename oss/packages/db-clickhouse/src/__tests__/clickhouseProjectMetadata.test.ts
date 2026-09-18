/**
 * Live project-metadata tests for `@uptimizr/db-clickhouse` (#310, ADR 0051 §5).
 *
 * ClickHouse has no row `DELETE` and no `ON CONFLICT`, so annotations, the
 * glossary and saved analyses are `ReplacingMergeTree(version)` tables where an
 * update inserts a newer version and a delete inserts a `deleted = 1` tombstone,
 * read back with `FINAL`. That is engine-specific machinery the pure unit tests
 * cannot exercise, so it is proven here against a real server — including the
 * one thing a tombstone can get wrong: a delete that a concurrent update in the
 * same millisecond silently resurrects.
 *
 * **Skipped gracefully** when no ClickHouse server is reachable (unless
 * `CLICKHOUSE_PARITY_REQUIRED` is set, like the parity suite). Uses a throwaway
 * database that it drops on teardown.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createClickhouseClient, type ClickhouseClient } from "../client.js";
import { migrateClickhouse } from "../migrations.js";
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
} from "../projectMetadata.js";

const CH_URL = process.env.CLICKHOUSE_URL ?? "http://localhost:8123";
const CH_USER = process.env.CLICKHOUSE_USER ?? "default";
const CH_PASSWORD = process.env.CLICKHOUSE_PASSWORD ?? "";
const TEST_DB = "uptimizr_ch_metadata_test";

const PID = "p1";
const OTHER_PID = "p2";
const author = { authorKind: "user", authorKeyId: "key_1" } as const;
const agentAuthor = { authorKind: "agent", authorKeyId: "key_2" } as const;

/** Probe `/ping` so the suite can skip when the server is unreachable. */
async function clickhouseReachable(): Promise<boolean> {
  let reason: unknown;
  try {
    const res = await fetch(`${CH_URL.replace(/\/$/, "")}/ping`, {
      signal: AbortSignal.timeout(2000),
    });
    if (res.ok) return true;
    reason = new Error(`HTTP ${res.status}`);
  } catch (error) {
    reason = error;
  }
  if (process.env.CLICKHOUSE_PARITY_REQUIRED) {
    throw new Error(
      `CLICKHOUSE_PARITY_REQUIRED is set but ClickHouse is unreachable at ${CH_URL}`,
      { cause: reason },
    );
  }
  return false;
}

const available = await clickhouseReachable();

describe.skipIf(!available)("clickhouse project metadata", () => {
  let ch: ClickhouseClient;

  beforeAll(async () => {
    const settings = {
      url: CH_URL,
      database: TEST_DB,
      username: CH_USER,
      password: CH_PASSWORD,
    };
    ch = createClickhouseClient(settings);
    await migrateClickhouse(ch, settings);
  });

  beforeEach(async () => {
    // Idempotent across local re-runs: start each case from empty tables.
    await ch.command(`TRUNCATE TABLE IF EXISTS annotations`);
    await ch.command(`TRUNCATE TABLE IF EXISTS glossary`);
    await ch.command(`TRUNCATE TABLE IF EXISTS saved_analyses`);
  });

  afterAll(async () => {
    if (ch) {
      await ch.command(`DROP DATABASE IF EXISTS ${TEST_DB}`);
      await ch.close();
    }
  });

  it("round-trips a targeted, time-bounded annotation", async () => {
    const since = 1_700_000_000_000;
    const until = 1_700_003_600_000;
    const saved = await createAnnotation(ch, PID, {
      ...agentAuthor,
      annotation: { targetKind: "mesh", targetId: "counter", since, until, text: "dead clicks" },
    });
    expect(saved).toMatchObject({
      projectId: PID,
      targetKind: "mesh",
      targetId: "counter",
      text: "dead clicks",
      authorKind: "agent",
      authorKeyId: "key_2",
    });
    expect(saved.since?.getTime()).toBe(since);
    expect(saved.until?.getTime()).toBe(until);

    const [read] = await listAnnotations(ch, PID);
    expect(read).toEqual(saved);
  });

  it("stores a standing note with null timestamps", async () => {
    const saved = await createAnnotation(ch, PID, {
      ...author,
      annotation: { targetKind: "project", text: "v2.1 shipped" },
    });
    expect(saved.since).toBeNull();
    expect(saved.until).toBeNull();
    expect(saved.targetId).toBeNull();
  });

  it("filters by target and by overlapping window, keeping standing notes", async () => {
    await createAnnotation(ch, PID, {
      ...author,
      annotation: { targetKind: "project", text: "standing" },
    });
    await createAnnotation(ch, PID, {
      ...author,
      annotation: { targetKind: "window", since: 1_000, until: 2_000, text: "early" },
    });
    await createAnnotation(ch, PID, {
      ...author,
      annotation: { targetKind: "scene", targetId: "lobby", text: "about the lobby" },
    });

    expect((await listAnnotations(ch, PID, { targetKind: "scene" })).map((a) => a.text)).toEqual([
      "about the lobby",
    ]);
    const overlapping = await listAnnotations(ch, PID, { since: 1_500, until: 5_000 });
    expect(overlapping.map((a) => a.text).sort()).toEqual(["about the lobby", "early", "standing"]);
  });

  it("tombstones a delete so it survives a same-millisecond write", async () => {
    const first = await createAnnotation(ch, PID, {
      ...author,
      annotation: { targetKind: "project", text: "first" },
    });
    const second = await createAnnotation(ch, PID, {
      ...author,
      annotation: { targetKind: "project", text: "second" },
    });
    expect(await deleteAnnotation(ch, PID, first.id)).toBe(true);
    // The monotonic version is what keeps the tombstone newer than the row it
    // replaces even when both land inside one millisecond.
    expect((await listAnnotations(ch, PID)).map((a) => a.id)).toEqual([second.id]);
    expect(await deleteAnnotation(ch, PID, first.id)).toBe(false);
  });

  it("keeps projects apart on read and on delete", async () => {
    const mine = await createAnnotation(ch, PID, {
      ...author,
      annotation: { targetKind: "project", text: "mine" },
    });
    await createAnnotation(ch, OTHER_PID, {
      ...author,
      annotation: { targetKind: "project", text: "theirs" },
    });
    expect(await deleteAnnotation(ch, OTHER_PID, mine.id)).toBe(false);
    expect(await listAnnotations(ch, PID)).toHaveLength(1);
    expect(await listAnnotations(ch, OTHER_PID)).toHaveLength(1);
  });

  it("upserts a glossary term instead of accumulating versions", async () => {
    await putGlossaryEntry(ch, PID, { entry: { term: "TTFR", meaning: "time to first render" } });
    const updated = await putGlossaryEntry(ch, PID, {
      entry: { term: "TTFR", meaning: "time to first rendered frame" },
    });
    expect(updated.meaning).toBe("time to first rendered frame");

    const all = await listGlossary(ch, PID);
    expect(all).toHaveLength(1);
    expect(all[0]?.meaning).toBe("time to first rendered frame");

    expect(await deleteGlossaryEntry(ch, PID, "TTFR")).toBe(true);
    expect(await listGlossary(ch, PID)).toEqual([]);
    expect(await deleteGlossaryEntry(ch, PID, "TTFR")).toBe(false);
  });

  it("round-trips a saved analysis' opaque query document", async () => {
    const saved = await createSavedAnalysis(ch, PID, {
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
    expect((await listSavedAnalyses(ch, PID))[0]).toEqual(saved);

    expect(await deleteSavedAnalysis(ch, PID, saved.id)).toBe(true);
    expect(await listSavedAnalyses(ch, PID)).toEqual([]);
  });

  it("stores an analysis with no conclusion as null", async () => {
    const saved = await createSavedAnalysis(ch, PID, {
      ...author,
      analysis: { title: "watch this", query: {} },
    });
    expect(saved.conclusion).toBeNull();
    expect(saved.query).toEqual({});
  });
});
