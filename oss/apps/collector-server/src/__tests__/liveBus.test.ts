import { describe, expect, it } from "vitest";
import type { AnyEvent } from "@uptimizr/schema";
import { createLiveBus } from "../liveBus.js";

function ev(overrides: Partial<AnyEvent> & { type?: AnyEvent["type"] } = {}): AnyEvent {
  return {
    type: "custom",
    projectId: "p1",
    visitorId: "vis1",
    sessionId: "s1",
    ts: 1_000,
    sdkVersion: "0.1.0",
    ...overrides,
  } as AnyEvent;
}

describe("liveBus presence", () => {
  it("counts active sessions and distinct visitors within the window", () => {
    const t = 0;
    const bus = createLiveBus({ windowMs: 30_000, now: () => t });

    bus.publish([ev({ sessionId: "s1", visitorId: "v1", sceneId: "lobby" })]);
    bus.publish([ev({ sessionId: "s2", visitorId: "v1" })]);
    bus.publish([ev({ sessionId: "s3", visitorId: "v2" })]);

    const snap = bus.presence("p1");
    expect(snap.activeSessions).toBe(3);
    expect(snap.activeVisitors).toBe(2);
    expect(snap.sessions.map((s) => s.sessionId).sort()).toEqual(["s1", "s2", "s3"]);
  });

  it("scopes presence to the requested project", () => {
    const bus = createLiveBus({ now: () => 0 });
    bus.publish([ev({ projectId: "p1", sessionId: "s1" })]);
    bus.publish([ev({ projectId: "p2", sessionId: "s1" })]);

    expect(bus.presence("p1").activeSessions).toBe(1);
    expect(bus.presence("p2").activeSessions).toBe(1);
  });

  it("prunes sessions once they fall outside the window", () => {
    let t = 0;
    const bus = createLiveBus({ windowMs: 30_000, now: () => t });
    bus.publish([ev({ sessionId: "s1" })]);

    t = 30_000;
    expect(bus.presence("p1").activeSessions).toBe(1); // exactly at the edge is still live

    t = 30_001;
    expect(bus.presence("p1").activeSessions).toBe(0);
  });

  it("keeps a session live as long as it keeps emitting", () => {
    let t = 0;
    const bus = createLiveBus({ windowMs: 30_000, now: () => t });
    bus.publish([ev({ sessionId: "s1" })]);

    t = 20_000;
    bus.publish([ev({ sessionId: "s1" })]);
    t = 45_000;
    expect(bus.presence("p1").activeSessions).toBe(1);
  });

  it("drops a session immediately on session_end", () => {
    const bus = createLiveBus({ now: () => 0 });
    bus.publish([ev({ sessionId: "s1", type: "session_start" })]);
    expect(bus.presence("p1").activeSessions).toBe(1);

    bus.publish([ev({ sessionId: "s1", type: "session_end" })]);
    expect(bus.presence("p1").activeSessions).toBe(0);
  });

  it("derives a coarse activity bucket from recency, sorted most-recent first", () => {
    let t = 0;
    const bus = createLiveBus({ now: () => t });
    bus.publish([ev({ sessionId: "old" })]);
    t = 5_000;
    bus.publish([ev({ sessionId: "mid" })]);
    t = 20_000;
    bus.publish([ev({ sessionId: "new" })]);

    const snap = bus.presence("p1");
    expect(snap.sessions[0].sessionId).toBe("new");
    expect(snap.sessions[0].activity).toBe("active");
    expect(snap.sessions[1].activity).toBe("recent"); // mid: 15s old
    expect(snap.sessions[2].activity).toBe("idle"); // old: 20s old
  });

  it("exposes only non-identifying roster fields (no visitorId)", () => {
    const bus = createLiveBus({ now: () => 0 });
    bus.publish([ev({ sessionId: "s1", visitorId: "secret", sceneId: "lobby" })]);
    const item = bus.presence("p1").sessions[0];
    expect(item).toEqual({
      sessionId: "s1",
      sceneId: "lobby",
      startedAt: 0,
      lastSeen: 0,
      activity: "active",
    });
    expect(Object.keys(item)).not.toContain("visitorId");
  });

  it("defaults the sceneId when the event carries none", () => {
    const bus = createLiveBus({ now: () => 0 });
    bus.publish([ev({ sessionId: "s1", sceneId: undefined })]);
    expect(bus.presence("p1").sessions[0].sceneId).toBe("default");
  });
});

describe("liveBus backfill ring", () => {
  it("returns recent events for a session, oldest first, bounded by ring size", () => {
    const bus = createLiveBus({ backfillRingSize: 3, now: () => 0 });
    for (let i = 0; i < 5; i++) bus.publish([ev({ sessionId: "s1", ts: i })]);

    const recent = bus.recentForSession("p1", "s1");
    expect(recent.map((e) => e.ts)).toEqual([2, 3, 4]);
  });

  it("returns an empty array for an unknown session", () => {
    const bus = createLiveBus({ now: () => 0 });
    expect(bus.recentForSession("p1", "nope")).toEqual([]);
  });
});

describe("liveBus subscriptions", () => {
  it("delivers matching events to a project subscriber", async () => {
    const bus = createLiveBus({ now: () => 0 });
    const sub = bus.subscribe({ projectId: "p1" });

    bus.publish([ev({ sessionId: "s1" })]);
    bus.publish([ev({ projectId: "p2", sessionId: "s9" })]); // filtered out

    const it = sub[Symbol.asyncIterator]();
    const first = await it.next();
    expect(first.value?.sessionId).toBe("s1");
    sub.close();
  });

  it("filters a live-follow subscription to one session", async () => {
    const bus = createLiveBus({ now: () => 0 });
    const sub = bus.subscribe({ projectId: "p1", sessionId: "s2" });

    bus.publish([ev({ sessionId: "s1" })]);
    bus.publish([ev({ sessionId: "s2", ts: 42 })]);

    const first = await sub[Symbol.asyncIterator]().next();
    expect(first.value?.sessionId).toBe("s2");
    expect(first.value?.ts).toBe(42);
    sub.close();
  });

  it("filters by event type when a type set is given", async () => {
    const bus = createLiveBus({ now: () => 0 });
    const sub = bus.subscribe({ projectId: "p1", types: new Set(["pointer_click"]) });

    bus.publish([ev({ type: "camera_sample" })]);
    bus.publish([ev({ type: "pointer_click" })]);

    const first = await sub[Symbol.asyncIterator]().next();
    expect(first.value?.type).toBe("pointer_click");
    sub.close();
  });

  it("drops oldest events when a slow subscriber's queue overflows", async () => {
    const bus = createLiveBus({ now: () => 0 });
    const sub = bus.subscribe({ projectId: "p1", queueLimit: 2 });

    for (let i = 0; i < 5; i++) bus.publish([ev({ ts: i })]);
    expect(sub.dropped).toBe(3);

    const it = sub[Symbol.asyncIterator]();
    const a = await it.next();
    const b = await it.next();
    expect([a.value?.ts, b.value?.ts]).toEqual([3, 4]); // oldest three dropped
    sub.close();
  });

  it("tracks subscriber count and releases on close", () => {
    const bus = createLiveBus({ now: () => 0 });
    const s1 = bus.subscribe({ projectId: "p1" });
    const s2 = bus.subscribe({ projectId: "p1" });
    expect(bus.subscriberCount).toBe(2);
    s1.close();
    s1.close(); // idempotent
    expect(bus.subscriberCount).toBe(1);
    s2.close();
    expect(bus.subscriberCount).toBe(0);
  });

  it("ends the async iterator when the subscription closes", async () => {
    const bus = createLiveBus({ now: () => 0 });
    const sub = bus.subscribe({ projectId: "p1" });
    const it = sub[Symbol.asyncIterator]();
    const pending = it.next();
    sub.close();
    const result = await pending;
    expect(result.done).toBe(true);
  });

  it("stop() closes all subscribers and clears presence", async () => {
    const bus = createLiveBus({ now: () => 0 });
    const sub = bus.subscribe({ projectId: "p1" });
    bus.publish([ev({ sessionId: "s1" })]);
    bus.stop();
    expect(bus.subscriberCount).toBe(0);
    expect(bus.presence("p1").activeSessions).toBe(0);

    const it = sub[Symbol.asyncIterator]();
    const buffered = await it.next(); // the event queued before stop drains first
    expect(buffered.value?.sessionId).toBe("s1");
    const end = await it.next();
    expect(end.done).toBe(true);
  });
});
