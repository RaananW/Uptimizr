import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AnyEvent } from "@uptimizr/schema";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../app.js";
import { MS_PER_DAY, PRUNE_INTERVAL_MS } from "../audit.js";
import { loadConfig, type CollectorConfig } from "../config.js";
import { createDuckdbStore } from "../duckdbStore.js";
import { startEventRetention } from "../eventRetention.js";
import { createMemoryStore } from "../memoryStore.js";
import type { CollectorStore } from "../store.js";

const NOW = Date.UTC(2026, 10, 6, 12, 0, 0);

function harness(pruneEvents: CollectorStore["pruneEvents"]) {
  const log = { info: vi.fn(), warn: vi.fn() };
  const app = { log } as unknown as FastifyInstance;
  const store = { pruneEvents } as unknown as CollectorStore;
  return { app, log, store };
}

const days = (eventRetentionDays: number) => ({ eventRetentionDays }) as CollectorConfig;

function evt(ts: number, type = "pointer_click", extra: Record<string, unknown> = {}): AnyEvent {
  return { type, projectId: "p1", sessionId: "s1", ts, sdkVersion: "0.1.0", ...extra } as AnyEvent;
}

describe("loadConfig: EVENT_RETENTION_DAYS", () => {
  const env = { VISITOR_HASH_SECRET: "test-secret" };

  it("defaults to 0, so an upgrade never deletes data", () => {
    expect(loadConfig({ ...env }).eventRetentionDays).toBe(0);
  });

  it("reads a positive number of days", () => {
    expect(loadConfig({ ...env, EVENT_RETENTION_DAYS: "90" }).eventRetentionDays).toBe(90);
  });

  it("refuses a negative or unparseable value rather than keeping events forever", () => {
    expect(() => loadConfig({ ...env, EVENT_RETENTION_DAYS: "-5" })).toThrow();
    expect(() => loadConfig({ ...env, EVENT_RETENTION_DAYS: "abc" })).toThrow();
  });
});

describe("startEventRetention", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("never sweeps when disabled", async () => {
    for (const value of [0, -1]) {
      const pruneEvents = vi.fn(async () => {});
      const { app, store } = harness(pruneEvents);
      const stop = startEventRetention(app, store, days(value));
      await vi.advanceTimersByTimeAsync(PRUNE_INTERVAL_MS * 3);
      expect(pruneEvents).not.toHaveBeenCalled();
      stop();
    }
  });

  it("sweeps at startup with the cutoff the window implies", () => {
    const pruneEvents = vi.fn(async () => {});
    const { app, store } = harness(pruneEvents);
    const stop = startEventRetention(app, store, days(30));
    expect(pruneEvents).toHaveBeenCalledTimes(1);
    expect(pruneEvents).toHaveBeenCalledWith(NOW - 30 * MS_PER_DAY);
    stop();
  });

  it("repeats on the interval against a cutoff that moves, until stopped", async () => {
    const pruneEvents = vi.fn(async () => {});
    const { app, store } = harness(pruneEvents);
    const stop = startEventRetention(app, store, days(1));

    await vi.advanceTimersByTimeAsync(PRUNE_INTERVAL_MS);
    expect(pruneEvents).toHaveBeenCalledTimes(2);
    expect(pruneEvents).toHaveBeenLastCalledWith(NOW + PRUNE_INTERVAL_MS - MS_PER_DAY);

    stop();
    await vi.advanceTimersByTimeAsync(PRUNE_INTERVAL_MS * 3);
    expect(pruneEvents).toHaveBeenCalledTimes(2);
  });

  it("logs a rejected sweep and tries again on the next one", async () => {
    const pruneEvents = vi.fn(async () => {
      throw new Error("database is locked");
    });
    const { app, log, store } = harness(pruneEvents);
    const stop = startEventRetention(app, store, days(30));

    await vi.advanceTimersByTimeAsync(0);
    expect(log.warn).toHaveBeenCalledTimes(1);
    expect(log.info).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(PRUNE_INTERVAL_MS);
    expect(pruneEvents).toHaveBeenCalledTimes(2);
    stop();
  });

  it("survives a store that throws synchronously", () => {
    const { app, log, store } = harness(() => {
      throw new Error("no such table");
    });
    let stop = (): void => {};
    expect(() => {
      stop = startEventRetention(app, store, days(30));
    }).not.toThrow();
    expect(log.warn).toHaveBeenCalledTimes(1);
    stop();
  });

  it("logs how far it pruned and nothing else", async () => {
    const { app, log, store } = harness(async () => {});
    const stop = startEventRetention(app, store, days(30));
    await vi.advanceTimersByTimeAsync(0);

    expect(log.info).toHaveBeenCalledTimes(1);
    expect(log.info.mock.calls[0]![0]).toEqual({
      cutoff: new Date(NOW - 30 * MS_PER_DAY).toISOString(),
    });
    stop();
  });

  it("logs only the first line of an error, which may quote rows below it", async () => {
    const quoted = "FLAT VARCHAR: 1 = [ secret-event-content ]";
    const { app, log, store } = harness(async () => {
      throw new Error(`Failed to delete all rows from index\n${quoted}`);
    });
    const stop = startEventRetention(app, store, days(30));
    await vi.advanceTimersByTimeAsync(0);

    expect(log.warn).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(log.warn.mock.calls)).not.toContain("secret-event-content");
    expect(log.warn.mock.calls[0]![0]).toEqual({ error: "Failed to delete all rows from index" });
    stop();
  });

  it("does not hold the process open", () => {
    const { app, store } = harness(async () => {});
    const unref = vi.fn();
    const timer = { unref } as unknown as ReturnType<typeof setInterval>;
    const setIntervalSpy = vi.spyOn(globalThis, "setInterval").mockReturnValue(timer);
    const stop = startEventRetention(app, store, days(30));
    expect(unref).toHaveBeenCalledTimes(1);
    stop();
    setIntervalSpy.mockRestore();
  });
});

describe("memory store pruneEvents", () => {
  const CUTOFF = 10_000;
  const newStore = () => createMemoryStore({ projectId: "p1", apiKey: "k1" });

  it("deletes rows older than the cutoff and keeps the rest", async () => {
    const store = newStore();
    await store.insertEvents([evt(CUTOFF - 1), evt(CUTOFF), evt(CUTOFF + 1)]);

    await store.pruneEvents(CUTOFF);

    const left = await store.getSessionEvents("p1", "s1");
    expect(left.map((e) => e.ts)).toEqual([CUTOFF, CUTOFF + 1]);
  });

  it("includes node_transform events, which share the one array here", async () => {
    const store = newStore();
    const node = { nodeId: "door", position: [0, 0, 0], rotation: [0, 0, 0, 1] };
    await store.insertEvents([
      evt(CUTOFF - 1, "node_transform", node),
      evt(CUTOFF + 1, "node_transform", node),
    ]);

    await store.pruneEvents(CUTOFF);

    expect((await store.getSessionEvents("p1", "s1")).map((e) => e.ts)).toEqual([CUTOFF + 1]);
  });

  it("is idempotent and leaves the audit log alone", async () => {
    const store = newStore();
    await store.recordAudit({
      projectId: "p1",
      keyId: "memory-key",
      surface: "http",
      toolOrPath: "/api/v1/sessions",
      params: "{}",
      durationMs: 1,
      status: 200,
      at: new Date(1),
    });
    await store.insertEvents([evt(1), evt(CUTOFF + 1)]);

    await store.pruneEvents(CUTOFF);
    await store.pruneEvents(CUTOFF);

    expect((await store.getSessionEvents("p1", "s1")).map((e) => e.ts)).toEqual([CUTOFF + 1]);
    expect(await store.listAudit("p1")).toHaveLength(1);
  });
});

describe("duckdb store pruneEvents", () => {
  it("is wired through the store contract", async () => {
    const store = await createDuckdbStore(":memory:");
    await store.insertEvents([evt(1), evt(20_000)]);

    await store.pruneEvents(10_000);

    expect((await store.getSessionEvents("p1", "s1")).map((e) => e.ts)).toEqual([20_000]);
    await store.close();
  });
});

describe("buildApp event retention", () => {
  const config = {
    ...loadConfig({ VISITOR_HASH_SECRET: "test-secret" }),
    auditRetentionDays: 0,
  };

  async function run(eventRetentionDays: number): Promise<number> {
    const store = createMemoryStore({ projectId: "p1", apiKey: "k1" });
    await store.insertEvents([evt(Date.now() - 40 * MS_PER_DAY), evt(Date.now())]);
    const app = await buildApp({ store, config: { ...config, eventRetentionDays } });
    // The sweep is fire-and-forget; closing after a macrotask lets it land.
    await new Promise((resolve) => setTimeout(resolve, 0));
    await app.close();
    return (await store.getSessionEvents("p1", "s1")).length;
  }

  it("keeps everything by default", async () => {
    expect(await run(0)).toBe(2);
  });

  it("sweeps on boot when a window is configured", async () => {
    expect(await run(30)).toBe(1);
  });
});
