import { describe, expect, it } from "vitest";
import type { AnyEvent } from "@uptimizr/schema";
import { createMemoryStore } from "../memoryStore.js";

function evt(partial: Partial<AnyEvent> & { type: string }): AnyEvent {
  return {
    projectId: "p1",
    sessionId: "s1",
    ts: Date.now(),
    sdkVersion: "0.1.0",
    ...partial,
  } as AnyEvent;
}

describe("memory store", () => {
  it("resolves only the seeded api key", async () => {
    const store = createMemoryStore({ projectId: "p1", apiKey: "k1" });
    expect(await store.resolveApiKey("k1")).toEqual({ projectId: "p1", capability: "query" });
    expect(await store.resolveApiKey("nope")).toBeNull();
  });

  it("stores and returns a session timeline in ts order", async () => {
    const store = createMemoryStore({ projectId: "p1", apiKey: "k1" });
    await store.insertEvents([
      evt({ type: "pointer_click", ts: 200 } as Partial<AnyEvent> & { type: string }),
      evt({ type: "session_start", ts: 100 } as Partial<AnyEvent> & { type: string }),
    ]);
    const timeline = await store.getSessionEvents("p1", "s1");
    expect(timeline.map((e) => e.type)).toEqual(["session_start", "pointer_click"]);
  });

  it("scopes reads to the matching project and session", async () => {
    const store = createMemoryStore({ projectId: "p1", apiKey: "k1" });
    await store.insertEvents([
      evt({ type: "pointer_click", sessionId: "s1" } as Partial<AnyEvent> & { type: string }),
      evt({ type: "pointer_click", sessionId: "s2" } as Partial<AnyEvent> & { type: string }),
      evt({ type: "pointer_click", projectId: "other" } as Partial<AnyEvent> & { type: string }),
    ]);
    expect(await store.getSessionEvents("p1", "s1")).toHaveLength(1);
    const sessions = await store.listSessions("p1");
    expect(sessions.map((s) => s.session_id).sort()).toEqual(["s1", "s2"]);
  });

  it("derives coarse session meta from session_start", async () => {
    const store = createMemoryStore({ projectId: "p1", apiKey: "k1" });
    await store.insertEvents([
      evt({
        type: "session_start",
        scene: { cameraType: "arc-rotate", cameraName: "camera", meshCount: 6 },
        user: { id: "anon" },
      } as Partial<AnyEvent> & { type: string }),
    ]);
    const meta = await store.getSessionMeta("p1", "s1");
    expect(meta).toMatchObject({
      sessionId: "s1",
      scene: { cameraType: "arc-rotate" },
      user: { id: "anon" },
    });
  });

  it("computes an ordered funnel with per-step drop-off", async () => {
    const store = createMemoryStore({ projectId: "p1", apiKey: "k1" });
    await store.insertEvents([
      // sA reaches all three steps in order.
      evt({ type: "session_start", sessionId: "sA", ts: 1 } as Partial<AnyEvent> & {
        type: string;
      }),
      evt({ type: "camera_gesture", sessionId: "sA", ts: 2, kind: "orbit" } as Partial<AnyEvent> & {
        type: string;
      }),
      evt({
        type: "mesh_interaction",
        sessionId: "sA",
        ts: 3,
        kind: "pick",
        mesh: "box",
      } as Partial<AnyEvent> & { type: string }),
      // sB opens + rotates, never selects.
      evt({ type: "session_start", sessionId: "sB", ts: 1 } as Partial<AnyEvent> & {
        type: string;
      }),
      evt({ type: "camera_gesture", sessionId: "sB", ts: 2, kind: "orbit" } as Partial<AnyEvent> & {
        type: string;
      }),
    ]);
    const rows = await store.funnel("p1", {
      steps: [
        { type: "session_start" },
        { type: "camera_gesture", name: "orbit" },
        { type: "mesh_interaction", name: "pick" },
      ],
    });
    expect(rows).toEqual([
      { step: 0, sessions: 2 },
      { step: 1, sessions: 2 },
      { step: 2, sessions: 1 },
    ]);
  });

  it("computes a variant leaderboard with views, conversions, and dwell (#150)", async () => {
    const store = createMemoryStore({ projectId: "p1", apiKey: "k1" });
    const c = (sessionId: string, name: string, ts: number) =>
      evt({ type: "custom", sessionId, ts, name } as Partial<AnyEvent> & { type: string });
    await store.insertEvents([
      // sA: red → blue → add_to_cart (converts after both).
      c("sA", "red", 0),
      c("sA", "blue", 2000),
      c("sA", "add_to_cart", 5000),
      // sB: red → red (same-variant re-view) → green; never converts.
      c("sB", "red", 1000),
      c("sB", "red", 4000),
      c("sB", "green", 8000),
      // sC: blue only.
      c("sC", "blue", 0),
    ]);
    const rows = await store.variantLeaderboard("p1", {
      conversion: { type: "custom", name: "add_to_cart" },
    });
    const byVariant = Object.fromEntries(rows.map((r) => [r.variant, r]));
    // Ranked by views: red (3), blue (2), then add_to_cart / green tie by name.
    expect(rows.map((r) => r.variant)).toEqual(["red", "blue", "add_to_cart", "green"]);
    expect(byVariant.red).toMatchObject({ views: 3, sessions: 2, conversions: 1 });
    expect(byVariant.red.avg_dwell_ms).toBeCloseTo(13000 / 3, 3);
    expect(byVariant.blue).toMatchObject({ views: 2, sessions: 2, conversions: 1 });
    expect(byVariant.blue.avg_dwell_ms).toBeCloseTo(3000, 3);
    expect(byVariant.green).toMatchObject({ views: 1, conversions: 0, avg_dwell_ms: 0 });
  });
});
