import type { AnyEvent } from "@uptimizr/schema";

/**
 * A replay driver receives ordered events and reconstructs them in a target
 * scene. Drivers are engine-specific (e.g. Babylon) but must be **read/write to
 * the scene only** — a replay driver never emits analytics events.
 */
export interface ReplayDriver {
  /** Restore the scene to its initial state (called on stop and backward seek). */
  reset(): void;
  /** Apply a single event to the scene. */
  apply(event: AnyEvent): void;
}

export interface ReplayOptions {
  /** Playback speed multiplier. Default 1. */
  speed?: number;
  /** Called after each applied step with clamped elapsed and total duration. */
  onProgress?: (elapsedMs: number, durationMs: number) => void;
  /** Called once when playback reaches the end. */
  onComplete?: () => void;
}

/** Controls for driving playback. */
export interface ReplayHandle {
  play(): void;
  pause(): void;
  stop(): void;
  seek(elapsedMs: number): void;
  readonly durationMs: number;
  readonly isPlaying: boolean;
}

/**
 * Host environment used by {@link ReplayPlayer.play}. Injectable so the player
 * is testable without a real animation loop.
 */
export interface PlayerEnv {
  now(): number;
  requestFrame(cb: () => void): number;
  cancelFrame(id: number): void;
}
