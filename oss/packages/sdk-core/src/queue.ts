import type { AnyEvent } from "@uptimizr/schema";

/**
 * A bounded in-memory FIFO queue for pending events.
 *
 * When the queue exceeds `maxSize` (e.g. the device is offline and flushes keep
 * failing), the oldest events are dropped to cap memory use. This is a deliberate
 * trade-off: recent events are more valuable than unbounded retention.
 */
export class EventQueue {
  private items: AnyEvent[] = [];

  constructor(private readonly maxSize: number) {}

  /** Number of queued events. */
  get size(): number {
    return this.items.length;
  }

  /** Append an event, dropping the oldest if the cap is exceeded. */
  enqueue(event: AnyEvent): void {
    this.items.push(event);
    if (this.items.length > this.maxSize) {
      this.items.splice(0, this.items.length - this.maxSize);
    }
  }

  /** Remove and return all queued events. */
  drain(): AnyEvent[] {
    const drained = this.items;
    this.items = [];
    return drained;
  }

  /** Put events back at the front (e.g. after a failed flush). */
  prepend(events: AnyEvent[]): void {
    this.items = [...events, ...this.items];
    if (this.items.length > this.maxSize) {
      this.items.splice(0, this.items.length - this.maxSize);
    }
  }
}
