import { describe, it, expect } from "vitest";
import { EventQueue } from "../queue.js";
import type { AnyEvent } from "@uptimizr/schema";

function makeEvent(n: number): AnyEvent {
  return {
    type: "custom",
    name: `e${n}`,
    projectId: "p",
    sessionId: "s",
    ts: n,
    sdkVersion: "0.1.0",
  } as AnyEvent;
}

describe("EventQueue", () => {
  it("enqueues and drains in FIFO order", () => {
    const q = new EventQueue(10);
    q.enqueue(makeEvent(1));
    q.enqueue(makeEvent(2));
    expect(q.size).toBe(2);
    const drained = q.drain();
    expect(drained.map((e) => e.ts)).toEqual([1, 2]);
    expect(q.size).toBe(0);
  });

  it("drops the oldest events past maxSize", () => {
    const q = new EventQueue(2);
    q.enqueue(makeEvent(1));
    q.enqueue(makeEvent(2));
    q.enqueue(makeEvent(3));
    expect(q.size).toBe(2);
    expect(q.drain().map((e) => e.ts)).toEqual([2, 3]);
  });

  it("prepends events back to the front", () => {
    const q = new EventQueue(10);
    q.enqueue(makeEvent(3));
    q.prepend([makeEvent(1), makeEvent(2)]);
    expect(q.drain().map((e) => e.ts)).toEqual([1, 2, 3]);
  });
});
