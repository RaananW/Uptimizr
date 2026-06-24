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
});
