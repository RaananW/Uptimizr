import type { AnyEvent } from "@uptimizr/schema";

/** A queued event plus the bookkeeping that keeps chunked delivery in order. */
export interface QueuedEvent {
  readonly event: AnyEvent;
  /** Enqueue order. Re-queued events merge back by it, so a retry never reorders. */
  readonly seq: number;
  /** Serialized UTF-8 size, measured once by the first byte-bounded {@link EventQueue.take}. */
  bytes?: number;
}

/** A run of events removed by {@link EventQueue.take}. Hand it to `requeue` if delivery fails. */
export interface TakenEvents {
  readonly events: AnyEvent[];
  readonly entries: readonly QueuedEvent[];
}

/**
 * Bytes the `CollectRequest` envelope adds around the events
 * (`{"schemaVersion":"1.0","events":[]}`), rounded up for headroom.
 */
const ENVELOPE_BYTES = 64;

/**
 * The continuous channels (ADR 0012): periodic samples whose neighbours carry
 * nearly the same information, so losing a few costs resolution, not facts.
 */
const SAMPLE_EVENT_TYPES: ReadonlySet<string> = new Set([
  "camera_sample",
  "pointer_move",
  "frame_perf",
  "node_transform",
  "resource_sample",
]);

/**
 * A bounded in-memory FIFO queue for pending events.
 *
 * When the queue exceeds `maxSize` (e.g. the device is offline, or the
 * collector rate-limits and flushes keep failing), events are dropped to cap
 * memory use: the oldest **samples** first (camera, pointer move, perf, node
 * transforms), and the oldest of the rest only once no sample is left. A click,
 * pick, custom event or session boundary is one fact that no later event
 * repeats, while a dropped camera sample sits between two that survive.
 */
export class EventQueue {
  private items: QueuedEvent[] = [];
  /** Next sequence number for {@link enqueue}. */
  private nextSeq = 0;
  /** Lowest sequence number handed out so far; {@link prepend} goes below it. */
  private lowSeq = 0;

  constructor(private readonly maxSize: number) {}

  /** Number of queued events. */
  get size(): number {
    return this.items.length;
  }

  /** Append an event, dropping the oldest if the cap is exceeded. */
  enqueue(event: AnyEvent): void {
    this.items.push({ event, seq: this.nextSeq++ });
    this.trim();
  }

  /** Remove and return all queued events. */
  drain(): AnyEvent[] {
    const drained = this.items.map((entry) => entry.event);
    this.items = [];
    return drained;
  }

  /** Put events back at the front (e.g. after a failed flush). */
  prepend(events: AnyEvent[]): void {
    this.lowSeq -= events.length;
    const base = this.lowSeq;
    this.items = [...events.map((event, i) => ({ event, seq: base + i })), ...this.items];
    this.trim();
  }

  /**
   * Remove a run of events from the front: at most `maxEvents`, and at most
   * `maxBytes` once serialized as one `CollectRequest` body. At least one event
   * is always taken when the queue is not empty, even if it alone exceeds
   * `maxBytes`, so an oversized event can never stall the queue.
   *
   * Sizing serializes each event once (`JSON.stringify`) and caches the result on
   * the entry, so a re-queued event is not measured again. Leave `maxBytes` at
   * `Infinity` to skip sizing entirely.
   */
  take(maxEvents: number, maxBytes = Infinity): TakenEvents {
    const limit = Math.min(Math.max(1, maxEvents), this.items.length);
    const sized = Number.isFinite(maxBytes);
    let count = 0;
    let bytes = ENVELOPE_BYTES;
    while (count < limit) {
      if (sized) {
        const entry = this.items[count]!;
        // +1 for the comma that separates it from its neighbour in the array.
        entry.bytes ??= serializedBytes(entry.event) + 1;
        if (count > 0 && bytes + entry.bytes > maxBytes) {
          break;
        }
        bytes += entry.bytes;
      }
      count += 1;
    }
    const entries = this.items.splice(0, count);
    return { events: entries.map((entry) => entry.event), entries };
  }

  /**
   * Return events from {@link take} after a failed delivery. They are merged
   * back by enqueue order, so the queue stays in emit order even when several
   * runs were in flight and fail in any order.
   */
  requeue(taken: TakenEvents): void {
    const back = taken.entries;
    if (back.length === 0) {
      return;
    }
    const merged: QueuedEvent[] = [];
    let i = 0;
    let j = 0;
    while (i < back.length && j < this.items.length) {
      merged.push(back[i]!.seq < this.items[j]!.seq ? back[i++]! : this.items[j++]!);
    }
    while (i < back.length) merged.push(back[i++]!);
    while (j < this.items.length) merged.push(this.items[j++]!);
    this.items = merged;
    this.trim();
  }

  /** Drop events past the cap: the oldest samples first, then the oldest of the rest. */
  private trim(): void {
    let excess = this.items.length - this.maxSize;
    if (excess <= 0) {
      return;
    }
    const kept: QueuedEvent[] = [];
    for (const entry of this.items) {
      if (excess > 0 && SAMPLE_EVENT_TYPES.has(entry.event.type)) {
        excess -= 1;
        continue;
      }
      kept.push(entry);
    }
    if (excess > 0) {
      kept.splice(0, excess);
    }
    this.items = kept;
  }
}

/** UTF-8 byte length of an event's JSON, the unit the beacon quota counts. */
function serializedBytes(event: AnyEvent): number {
  let json: string;
  try {
    json = JSON.stringify(event);
  } catch {
    // Not serializable: count it as small and let the transport report the failure.
    return 0;
  }
  let bytes = json.length;
  for (let i = 0; i < json.length; i++) {
    const code = json.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdfff) {
      bytes += 1; // each half of a surrogate pair: 4 bytes per pair
    } else if (code >= 0x800) {
      bytes += 2;
    } else if (code >= 0x80) {
      bytes += 1;
    }
  }
  return bytes;
}
