import type { AnyEvent } from "@uptimizr/schema";
import type { PlayerEnv, ReplayDriver, ReplayHandle, ReplayOptions } from "./types.js";

function defaultEnv(): PlayerEnv {
  const hasRaf = typeof requestAnimationFrame === "function";
  return {
    now: () => (typeof performance !== "undefined" ? performance.now() : Date.now()),
    requestFrame: (cb) =>
      hasRaf ? requestAnimationFrame(cb) : (setTimeout(cb, 16) as unknown as number),
    cancelFrame: (id) => (hasRaf ? cancelAnimationFrame(id) : clearTimeout(id)),
  };
}

/**
 * Drives an ordered session stream through a {@link ReplayDriver}, reconstructing
 * the session in the host's own scene.
 *
 * The core is the pure {@link update} method (apply everything up to a relative
 * elapsed time); {@link play} simply ticks it from an animation loop. Seeking
 * backward resets the driver and replays from the start — replay is deterministic.
 */
export class ReplayPlayer implements ReplayHandle {
  private readonly events: AnyEvent[];
  private readonly baseTs: number;
  readonly durationMs: number;

  private cursor = 0;
  private elapsed = 0;
  private playing = false;
  private completed = false;
  private rafId: number | null = null;
  private startWall = 0;
  private startElapsed = 0;

  constructor(
    events: readonly AnyEvent[],
    private readonly driver: ReplayDriver,
    private readonly options: ReplayOptions = {},
    private readonly env: PlayerEnv = defaultEnv(),
  ) {
    this.events = [...events].sort((a, b) => a.ts - b.ts);
    this.baseTs = this.events.length > 0 ? this.events[0]!.ts : 0;
    this.durationMs =
      this.events.length > 0 ? this.events[this.events.length - 1]!.ts - this.baseTs : 0;
  }

  get isPlaying(): boolean {
    return this.playing;
  }

  private rel(event: AnyEvent): number {
    return event.ts - this.baseTs;
  }

  /** Apply all events up to `elapsedMs` (relative to the first event). */
  update(elapsedMs: number): void {
    const clamped = Math.max(0, elapsedMs);
    if (clamped < this.elapsed) {
      this.driver.reset();
      this.cursor = 0;
      this.completed = false;
    }
    while (this.cursor < this.events.length && this.rel(this.events[this.cursor]!) <= clamped) {
      this.driver.apply(this.events[this.cursor]!);
      this.cursor++;
    }
    this.elapsed = clamped;
    this.options.onProgress?.(Math.min(clamped, this.durationMs), this.durationMs);

    if (!this.completed && this.cursor >= this.events.length && clamped >= this.durationMs) {
      this.completed = true;
      this.pause();
      this.options.onComplete?.();
    }
  }

  seek(elapsedMs: number): void {
    this.update(elapsedMs);
  }

  play(): void {
    if (this.playing || this.events.length === 0) return;
    if (this.completed) {
      this.update(0);
    }
    this.playing = true;
    this.startWall = this.env.now();
    this.startElapsed = this.elapsed;

    const speed = this.options.speed ?? 1;
    const loop = () => {
      if (!this.playing) return;
      const wall = this.env.now();
      this.update(this.startElapsed + (wall - this.startWall) * speed);
      if (this.playing) this.rafId = this.env.requestFrame(loop);
    };
    this.rafId = this.env.requestFrame(loop);
  }

  pause(): void {
    this.playing = false;
    if (this.rafId !== null) {
      this.env.cancelFrame(this.rafId);
      this.rafId = null;
    }
  }

  stop(): void {
    this.pause();
    this.driver.reset();
    this.cursor = 0;
    this.elapsed = 0;
    this.completed = false;
  }
}
