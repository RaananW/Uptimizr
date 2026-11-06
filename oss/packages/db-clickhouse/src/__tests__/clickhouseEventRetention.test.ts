/**
 * Live event-retention test for `@uptimizr/db-clickhouse` (ADR 0052): the
 * lightweight `DELETE` is engine-specific, so it is proven against a real server.
 *
 * **Skipped gracefully** when no ClickHouse server is reachable (unless
 * `CLICKHOUSE_PARITY_REQUIRED` is set, like the parity suite). Uses a throwaway
 * database that it drops on teardown.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { AnyEvent } from "@uptimizr/schema";
import { createClickhouseClient, type ClickhouseClient } from "../client.js";
import { getSessionEvents, insertEvents, pruneEvents } from "../events.js";
import { migrateClickhouse } from "../migrations.js";
import { createProject } from "../projects.js";

const CH_URL = process.env.CLICKHOUSE_URL ?? "http://localhost:8123";
const CH_USER = process.env.CLICKHOUSE_USER ?? "default";
const CH_PASSWORD = process.env.CLICKHOUSE_PASSWORD ?? "";
const TEST_DB = "uptimizr_ch_retention_test";

const DAY = 24 * 60 * 60 * 1000;
const CUTOFF = Date.UTC(2024, 5, 16, 0, 0, 0);

function ev(type: string, ts: number, extra: Record<string, unknown> = {}): AnyEvent {
  return {
    type,
    projectId: "p1",
    sessionId: "s1",
    ts,
    sdkVersion: "0.1.0",
    sceneId: "lobby",
    ...extra,
  } as AnyEvent;
}

const nodeSample = (ts: number): AnyEvent =>
  ev("node_transform", ts, { nodeId: "door", position: [1, 2, 3], rotation: [0, 0, 0, 1] });

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

describe.skipIf(!available)("clickhouse event retention", () => {
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
    await ch.command(`TRUNCATE TABLE IF EXISTS events`);
    await ch.command(`TRUNCATE TABLE IF EXISTS node_samples`);
  });

  afterAll(async () => {
    if (ch) {
      await ch.command(`DROP DATABASE IF EXISTS ${TEST_DB}`);
      await ch.close();
    }
  });

  it("deletes wide events and node samples before the cutoff, and is idempotent", async () => {
    const project = await createProject(ch, "Demo");
    await insertEvents(ch, [
      ev("frame_perf", CUTOFF - 2 * DAY, { fps: 30 }),
      ev("frame_perf", CUTOFF - 1, { fps: 31 }),
      ev("frame_perf", CUTOFF, { fps: 32 }),
      nodeSample(CUTOFF - DAY),
      nodeSample(CUTOFF + DAY),
    ]);

    await pruneEvents(ch, CUTOFF);
    await pruneEvents(ch, CUTOFF);

    const left = await getSessionEvents(ch, "p1", "s1");
    expect(left.map((e) => [e.type, e.ts])).toEqual([
      ["frame_perf", CUTOFF],
      ["node_transform", CUTOFF + DAY],
    ]);
    // Metadata is not swept.
    const projects = await ch.query<{ n: number }>(
      `SELECT count() AS n FROM projects WHERE id = {id:String}`,
      { id: project.id },
    );
    expect(projects[0]?.n).toBe(1);
  });
});
