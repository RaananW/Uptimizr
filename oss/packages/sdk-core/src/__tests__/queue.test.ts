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

describe("EventQueue.take / requeue (#402)", () => {
  const sizeOf = (e: AnyEvent) => new TextEncoder().encode(JSON.stringify(e)).length;

  it("takes at most maxEvents from the front, in order", () => {
    const q = new EventQueue(10);
    for (let i = 1; i <= 5; i++) q.enqueue(makeEvent(i));
    expect(q.take(2).events.map((e) => e.ts)).toEqual([1, 2]);
    expect(q.take(10).events.map((e) => e.ts)).toEqual([3, 4, 5]);
    expect(q.size).toBe(0);
  });

  it("stops before the serialized batch would pass maxBytes", () => {
    const q = new EventQueue(100);
    for (let i = 0; i < 10; i++) q.enqueue(makeEvent(i));
    const one = sizeOf(makeEvent(0)) + 1;
    // Room for the envelope plus three events, not four.
    const taken = q.take(100, 64 + one * 3 + 2);
    expect(taken.events).toHaveLength(3);
    expect(q.size).toBe(7);
    // The real body of the batch fits the cap.
    const body = JSON.stringify({ schemaVersion: "1.0", events: taken.events });
    expect(new TextEncoder().encode(body).length).toBeLessThanOrEqual(64 + one * 3 + 2);
  });

  it("counts multi-byte characters in UTF-8", () => {
    const wide = { ...makeEvent(1), name: "é".repeat(50) + "😀".repeat(50) } as AnyEvent;
    const exact = sizeOf(wide) + 1;
    expect(exact).toBeGreaterThan(JSON.stringify(wide).length + 1);
    const twoWide = () => {
      const q = new EventQueue(10);
      q.enqueue(wide);
      q.enqueue(wide);
      return q;
    };
    // One byte short of two events: the UTF-16 length would wrongly allow both.
    expect(twoWide().take(10, 64 + exact * 2 - 1).events).toHaveLength(1);
    expect(twoWide().take(10, 64 + exact * 2).events).toHaveLength(2);
  });

  it("always takes one event, even when it alone exceeds maxBytes", () => {
    const q = new EventQueue(10);
    q.enqueue(makeEvent(1));
    q.enqueue(makeEvent(2));
    expect(q.take(10, 1).events.map((e) => e.ts)).toEqual([1]);
  });

  it("does not serialize when maxBytes is left unbounded", () => {
    const q = new EventQueue(10);
    q.enqueue(makeEvent(1));
    const taken = q.take(10);
    expect(taken.entries[0]!.bytes).toBeUndefined();
  });

  it("requeues a run in emit order, behind nothing older and ahead of newer events", () => {
    const q = new EventQueue(20);
    for (let i = 1; i <= 6; i++) q.enqueue(makeEvent(i));
    const a = q.take(2); // 1,2
    const b = q.take(2); // 3,4
    q.enqueue(makeEvent(7));
    // Fail in the opposite order to the one they were taken in.
    q.requeue(b);
    q.requeue(a);
    expect(q.drain().map((e) => e.ts)).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });

  it("keeps the measured size across a requeue", () => {
    const q = new EventQueue(10);
    q.enqueue(makeEvent(1));
    const taken = q.take(10, 10_000);
    const measured = taken.entries[0]!.bytes;
    expect(measured).toBe(sizeOf(makeEvent(1)) + 1);
    q.requeue(taken);
    expect(q.take(10, 10_000).entries[0]!.bytes).toBe(measured);
  });

  it("drops the oldest events when a requeue passes maxSize", () => {
    const q = new EventQueue(3);
    q.enqueue(makeEvent(1));
    q.enqueue(makeEvent(2));
    const taken = q.take(2);
    q.enqueue(makeEvent(3));
    q.enqueue(makeEvent(4));
    q.enqueue(makeEvent(5));
    q.requeue(taken);
    expect(q.drain().map((e) => e.ts)).toEqual([3, 4, 5]);
  });

  it("orders a requeued run after events prepended in front of it", () => {
    const q = new EventQueue(10);
    q.enqueue(makeEvent(3));
    const taken = q.take(1);
    q.prepend([makeEvent(1), makeEvent(2)]);
    q.requeue(taken);
    expect(q.drain().map((e) => e.ts)).toEqual([1, 2, 3]);
  });
});
