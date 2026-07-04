import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AnyEvent } from "@uptimizr/schema";
import { buildLoadBounceFunnel, clickhouseDialect, duckdbDialect } from "../index.js";
import type { LoadBounceBandRow } from "../index.js";
import { createDuckdbClient, type DuckdbClient } from "../duckdb/client.js";
import { migrateDuckdb } from "../duckdb/migrations.js";
import { insertEvents } from "../duckdb/events.js";
import { runDuckdbQuery } from "../duckdb/queries.js";

/**
 * Load → bounce/abandon funnel (#152) — focused DuckDB tests for the load-time
 * banding and the bounce (no post-load interaction) semantics: which interaction
 * types count, that only interactions at/after the initial load matter, that the
 * earliest `asset_load` is the load metric, and the default vs. custom bands.
 */

const PID = "load-bounce-project";
const T0 = Date.UTC(2024, 5, 16, 10, 0, 0);
const RANGE = { since: T0 - 60_000, until: T0 + 60_000 };

function ev(
  sessionId: string,
  type: string,
  ts: number,
  extra: Record<string, unknown> = {},
): AnyEvent {
  return {
    type,
    projectId: PID,
    sessionId,
    ts,
    sdkVersion: "0.1.0",
    sceneId: "lobby",
    ...extra,
  } as AnyEvent;
}

/** An `asset_load` for `session` at `ts` reporting `loadMs`. */
function load(sessionId: string, ts: number, loadMs: number): AnyEvent {
  return ev(sessionId, "asset_load", ts, { name: "scene.glb", loadMs });
}

async function run(
  db: DuckdbClient,
  opts: { bands?: readonly number[] } = {},
): Promise<LoadBounceBandRow[]> {
  const rows = await runDuckdbQuery<LoadBounceBandRow>(
    db,
    buildLoadBounceFunnel(PID, { ...RANGE, ...opts }, duckdbDialect),
  );
  return rows.map((r) => ({
    band: Number(r.band),
    sessions: Number(r.sessions),
    bounced: Number(r.bounced),
  }));
}

describe("buildLoadBounceFunnel (load-time bands × bounce rate)", () => {
  let db: DuckdbClient;

  beforeEach(async () => {
    db = await createDuckdbClient(":memory:");
    await migrateDuckdb(db);
  });

  afterEach(async () => {
    await db.close();
  });

  it("buckets sessions by load band and counts bounces (no post-load interaction)", async () => {
    await insertEvents(db, [
      // Fast load (<1s), engaged → not a bounce.
      load("fast-engaged", T0, 400),
      ev("fast-engaged", "pointer_click", T0 + 500, { screen: [0.5, 0.5], button: 0 }),
      // Fast load (<1s), silent → bounce.
      load("fast-bounce", T0 + 1_000, 600),
      // Mid load (1–3s), engaged via mesh_interaction → not a bounce.
      load("mid-engaged", T0 + 2_000, 2_000),
      ev("mid-engaged", "mesh_interaction", T0 + 3_000, { mesh: "box", kind: "pick" }),
      // Slow load (>=5s), silent → bounce.
      load("slow-bounce", T0 + 4_000, 6_000),
    ]);

    // Default bands [1000, 3000, 5000] → band 0:<1s, 1:1–3s, 2:3–5s, 3:>=5s.
    expect(await run(db)).toEqual([
      { band: 0, sessions: 2, bounced: 1 },
      { band: 1, sessions: 1, bounced: 0 },
      { band: 3, sessions: 1, bounced: 1 },
    ]);
  });

  it("only counts interactions at or after the initial load as engagement", async () => {
    await insertEvents(db, [
      // An interaction BEFORE the load does not rescue the session from bouncing.
      ev("pre-only", "pointer_click", T0, { screen: [0.1, 0.1], button: 0 }),
      load("pre-only", T0 + 1_000, 500),
    ]);

    expect(await run(db)).toEqual([{ band: 0, sessions: 1, bounced: 1 }]);
  });

  it("uses the earliest asset_load as the session's load metric", async () => {
    await insertEvents(db, [
      // Earliest load is 400ms (<1s band); a later, slower asset load must not
      // reband the session.
      load("multi", T0, 400),
      load("multi", T0 + 2_000, 8_000),
    ]);

    expect(await run(db)).toEqual([{ band: 0, sessions: 1, bounced: 1 }]);
  });

  it("respects custom band boundaries", async () => {
    await insertEvents(db, [
      load("a", T0, 500),
      load("b", T0 + 1_000, 1_500),
      load("c", T0 + 2_000, 2_500),
    ]);

    // One boundary at 2000 → band 0:<2s (a,b), band 1:>=2s (c).
    expect(await run(db, { bands: [2_000] })).toEqual([
      { band: 0, sessions: 2, bounced: 2 },
      { band: 1, sessions: 1, bounced: 1 },
    ]);
  });

  it("excludes sessions that have no asset_load in scope", async () => {
    await insertEvents(db, [
      ev("no-load", "pointer_click", T0, { screen: [0.5, 0.5], button: 0 }),
      load("with-load", T0 + 1_000, 700),
    ]);

    expect(await run(db)).toEqual([{ band: 0, sessions: 1, bounced: 1 }]);
  });

  it("renders on the ClickHouse dialect (dialect-agnostic)", () => {
    const spec = buildLoadBounceFunnel(PID, { ...RANGE, bands: [1_000, 3_000] }, clickhouseDialect);
    expect(spec.query).toContain("JSONExtract(payload, 'loadMs', 'Nullable(Int64)')");
    expect(spec.query).toContain("asset_load");
    expect(spec.query).not.toContain("json_extract_string");
  });
});
