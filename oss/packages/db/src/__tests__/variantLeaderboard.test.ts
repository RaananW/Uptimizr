import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AnyEvent } from "@uptimizr/schema";
import { buildVariantLeaderboard, duckdbDialect } from "../index.js";
import type { FunnelStepInput, VariantLeaderboardRow } from "../index.js";
import { createDuckdbClient, type DuckdbClient } from "../duckdb/client.js";
import { migrateDuckdb } from "../duckdb/migrations.js";
import { insertEvents } from "../duckdb/events.js";
import { runDuckdbQuery } from "../duckdb/queries.js";

/**
 * Variant → conversion leaderboard (#150) — focused DuckDB tests for the
 * per-variant view/session/conversion/dwell semantics: grouping by the custom
 * `name`, ordered first-touch conversions, and dwell to the next boundary (a
 * switch to a different variant or the conversion event), with same-variant
 * re-views and boundary-less views handled correctly.
 */

const PID = "variant-project";
const T0 = Date.UTC(2024, 5, 16, 10, 0, 0);
const RANGE = { since: T0 - 60_000, until: T0 + 60_000 };
const CONVERSION: FunnelStepInput = { type: "custom", name: "add_to_cart" };

/** A `custom` variant/conversion event carrying `name` as the discriminator. */
function ev(sessionId: string, name: string, ts: number): AnyEvent {
  return {
    type: "custom",
    projectId: PID,
    sessionId,
    ts,
    sdkVersion: "0.1.0",
    sceneId: "lobby",
    name,
  } as AnyEvent;
}

async function run(
  db: DuckdbClient,
  opts: Parameters<typeof buildVariantLeaderboard>[1],
): Promise<VariantLeaderboardRow[]> {
  const rows = await runDuckdbQuery<VariantLeaderboardRow>(
    db,
    buildVariantLeaderboard(PID, opts, duckdbDialect),
  );
  return rows.map((r) => ({
    variant: r.variant,
    views: Number(r.views),
    sessions: Number(r.sessions),
    conversions: Number(r.conversions),
    avg_dwell_ms: Number(r.avg_dwell_ms),
  }));
}

/** The fixture used by most cases (see per-assertion reasoning inline). */
async function seed(db: DuckdbClient): Promise<void> {
  await insertEvents(db, [
    // sA: red → blue → add_to_cart (converts).
    ev("sA", "red", T0),
    ev("sA", "blue", T0 + 2_000),
    ev("sA", "add_to_cart", T0 + 5_000),
    // sB: red → red (re-view, not a switch) → green; never converts.
    ev("sB", "red", T0 + 1_000),
    ev("sB", "red", T0 + 4_000),
    ev("sB", "green", T0 + 8_000),
    // sC: blue only.
    ev("sC", "blue", T0),
  ]);
}

function byVariant(rows: VariantLeaderboardRow[]): Record<string, VariantLeaderboardRow> {
  return Object.fromEntries(rows.map((r) => [r.variant, r]));
}

describe("buildVariantLeaderboard", () => {
  let db: DuckdbClient;

  beforeEach(async () => {
    db = await createDuckdbClient(":memory:");
    await migrateDuckdb(db);
  });

  afterEach(async () => {
    await db.close();
  });

  it("ranks variants by views with distinct-session counts", async () => {
    await seed(db);
    const rows = await run(db, { ...RANGE, conversion: CONVERSION });
    // red 3 views, blue 2, then a (1) / green (1) tie broken by variant ASC.
    expect(rows.map((r) => r.variant)).toEqual(["red", "blue", "add_to_cart", "green"]);
    const v = byVariant(rows);
    expect(v.red).toMatchObject({ views: 3, sessions: 2 });
    expect(v.blue).toMatchObject({ views: 2, sessions: 2 });
    expect(v.green).toMatchObject({ views: 1, sessions: 1 });
  });

  it("counts first-touch conversions (conversion at/after the first view)", async () => {
    await seed(db);
    const v = byVariant(await run(db, { ...RANGE, conversion: CONVERSION }));
    // sA converts after both red and blue; sB never converts; green has no conversion.
    expect(v.red.conversions).toBe(1);
    expect(v.blue.conversions).toBe(1);
    expect(v.green.conversions).toBe(0);
  });

  it("averages dwell to the next boundary, skipping same-variant re-views", async () => {
    await seed(db);
    const v = byVariant(await run(db, { ...RANGE, conversion: CONVERSION }));
    // red views: sA red→blue=2000; sB red@1000→green@8000=7000 (the red@4000
    // re-view is not a boundary); sB red@4000→green@8000=4000. avg = 13000/3.
    expect(v.red.avg_dwell_ms).toBeCloseTo(13_000 / 3, 3);
    // blue: sA blue@2000→add_to_cart@5000=3000; sC blue has no later boundary.
    expect(v.blue.avg_dwell_ms).toBeCloseTo(3_000, 3);
    // green (last view) has no later boundary → excluded → coalesced to 0.
    expect(v.green.avg_dwell_ms).toBe(0);
  });

  it("reports zero conversions when no conversion is configured (dwell still spans switches)", async () => {
    await seed(db);
    const v = byVariant(await run(db, { ...RANGE }));
    for (const row of Object.values(v)) expect(row.conversions).toBe(0);
    // `add_to_cart` is itself a `custom` variant, so it still bounds sA's blue
    // view as a switch — dwell is unchanged; only the conversion column drops.
    expect(v.blue.avg_dwell_ms).toBeCloseTo(3_000, 3);
    expect(v.red.avg_dwell_ms).toBeCloseTo(13_000 / 3, 3);
  });

  it("honors a narrowing variant predicate and the row limit", async () => {
    await seed(db);
    // A specific variant predicate restricts the rows to that one custom name.
    const narrowed = await run(db, {
      ...RANGE,
      conversion: CONVERSION,
      variant: { type: "custom", name: "red" },
    });
    expect(narrowed.map((r) => r.variant)).toEqual(["red"]);
    expect(narrowed[0]).toMatchObject({ views: 3, sessions: 2, conversions: 1 });

    const limited = await run(db, { ...RANGE, conversion: CONVERSION, limit: 2 });
    expect(limited).toHaveLength(2);
    expect(limited.map((r) => r.variant)).toEqual(["red", "blue"]);
  });
});
