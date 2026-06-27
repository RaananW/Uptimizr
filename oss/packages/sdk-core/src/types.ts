import type {
  AnyEvent,
  CapabilityChangeKind,
  CollectRequest,
  Connector,
  CustomPropValue,
  Device,
  Graphics,
  Handedness,
  InputSource,
  PageMeta,
  SceneMeta,
  SessionUser,
} from "@uptimizr/schema";

import type { AggregatorConfig } from "./aggregation/aggregator.js";
import type { Snapshot } from "./aggregation/snapshot.js";

/**
 * Envelope fields the client fills in automatically. Collectors and callers only
 * provide the event `type` and its payload — never these.
 */
export type EnvelopeKey =
  | "projectId"
  | "visitorId"
  | "sessionId"
  | "ts"
  | "sdkVersion"
  | "url"
  | "sceneId"
  | "pageMeta";

/**
 * The shape a caller passes to `emit`: any event minus the auto-filled envelope.
 * Distributes over the event union so each variant keeps its own payload typing.
 */
export type EventInput = AnyEvent extends infer E
  ? E extends AnyEvent
    ? Omit<E, EnvelopeKey>
    : never
  : never;

/**
 * Options for {@link UptimizrClient.trackInput} — a discrete keyboard/gamepad
 * action (ADR 0023). `source` defaults to `"keyboard"`.
 */
export interface TrackInputOptions {
  /** The discrete input source. Defaults to `"keyboard"`. */
  source?: InputSource;
  /** Raw key code (`KeyboardEvent.code`) for keyboard inputs. */
  code?: string;
  /** Raw button index for gamepad inputs. */
  button?: number;
  /** Whether this is a press (`true`) or release (`false`). Omit for a single fire. */
  pressed?: boolean;
  /** Handedness for paired sources, when applicable. */
  handedness?: Handedness;
  /** Ephemeral, session-local id correlating a concurrent source (ADR 0011). */
  sourceId?: string;
}

/**
 * A capability / fidelity transition reported to
 * {@link UptimizrClient.reportCapabilityChange} (#49). Engines decide their
 * backend at init and rarely expose a runtime "I downgraded" hook, so this is
 * **app-reported**: the host app describes the fallback or recovery it performed.
 *
 * Privacy (ADR 0003): `from` / `to` / `reason` must be low-cardinality,
 * app-defined tokens (e.g. `"webgpu"`, `"webgl2"`, `"high"`) — never raw device
 * strings or PII.
 */
export interface CapabilityChangeReport {
  /** What class of capability changed. */
  kind: CapabilityChangeKind;
  /** Previous capability/level as a short app-defined token (e.g. `"webgpu"`). */
  from?: string;
  /** New capability/level as a short app-defined token (e.g. `"webgl2"`). */
  to?: string;
  /** Optional short, app-defined reason for the change (no PII). */
  reason?: string;
}

/**
 * A transport delivers a batch to the collector. Returns `true` on success.
 * Swappable so callers can provide a custom transport (extension point).
 */
export interface Transport {
  send(batch: CollectRequest): Promise<boolean>;
}
/**
 * Context handed to each collector plugin. The capture-side API surface.
 */
export interface CollectorContext {
  readonly config: ResolvedConfig;
  readonly sessionId: string;
  /** Emit a typed event; the envelope is filled in automatically. */
  emit(event: EventInput): void;
  /** Convenience for emitting a `custom` event. */
  track(name: string, props?: Record<string, CustomPropValue>): void;
  /** Emit an `input_action` for a discrete keyboard/gamepad input (ADR 0023). */
  trackInput(action: string, opts?: TrackInputOptions): void;
  /** Report a capability fallback/recovery transition (#49); emits `capability_change`. */
  reportCapabilityChange(change: CapabilityChangeReport): void;
  /** Switch the active scene/area (ADR 0010); emits a `scene_change` marker. */
  setScene(sceneId: string): void;
  /**
   * Register an aggregation channel for the offload-eligible per-frame math
   * (ADR 0031 follow-up, #10) and obtain a `snapshot` emitter. A connector calls
   * this once at start with its resolved capture config; per frame it then hands
   * raw, plain-number {@link Snapshot} DTOs to the returned function instead of
   * aggregating inline. The client routes them to a main-thread or worker-resident
   * {@link Aggregator} per the `offload` config; finalized events are always
   * emitted (and queued/flushed) on the main thread.
   *
   * High-volume channels (node/bone matrices, visibility ticks) are
   * typed-array-backed so they move to the worker zero-copy.
   */
  createAggregation(config: AggregatorConfig): (snapshot: Snapshot) => void;
  /** Current timestamp in epoch ms (overridable for testing). */
  now(): number;
}

/** Handle returned by a collector's `start`, used to tear it down. */
export interface CollectorHandle {
  stop(): void;
}

/**
 * A capture plugin. This is the primary SDK extension point: engine adapters
 * (e.g. Babylon) and custom instrumentation register as collectors via
 * `client.use(collector)`. `start` wires up listeners and returns a handle.
 */
export interface Collector {
  readonly name: string;
  start(ctx: CollectorContext): CollectorHandle | void;
}

/** A hook to inspect, modify, or drop an event before it is queued. */
export type BeforeSendHook = (event: AnyEvent) => AnyEvent | null;

/** Public configuration accepted by the client. */
export interface UptimizrConfig {
  /** Project identifier (public, non-secret). */
  projectId: string;
  /** Collector endpoint base URL, e.g. `https://collect.example.com`. */
  endpoint: string;
  /** Override the reported SDK version. Defaults to the package version. */
  sdkVersion?: string;
  /** Flush when this many events are queued. Default 20. */
  batchSize?: number;
  /** Flush at least this often, in ms. Default 5000. Set 0 to disable the timer. */
  flushIntervalMs?: number;
  /** Max events retained while offline before the oldest are dropped. Default 1000. */
  maxQueueSize?: number;
  /** Provide a custom transport. Defaults to a beacon/fetch transport. */
  transport?: Transport;
  /**
   * Where the offload-eligible processing phase runs (ADR 0031). `"main"`
   * (default) keeps serialization + network dispatch on the main thread —
   * today's behaviour, byte-for-byte. `"worker"` moves *steady-state*
   * serialization + dispatch to an opt-in Web Worker, while the terminal unload
   * flush always stays on the main thread.
   *
   * Worker mode is never required for correctness: if a worker cannot be created
   * (no `Worker`, restrictive CSP, SSR, tests) the SDK silently falls back to
   * `"main"`. Supplying a custom {@link UptimizrConfig.transport} also disables
   * worker offload, since a custom transport is a main-thread closure the worker
   * cannot run; the transport is honoured on the main thread instead.
   */
  offload?: "main" | "worker";
  /**
   * Advanced bundler escape hatch: construct the offload worker yourself when
   * the default `new Worker(new URL("./offloadWorker.js", import.meta.url))`
   * pattern is not handled by your bundler. Only consulted when
   * `offload: "worker"`.
   */
  createWorker?: () => Worker;
  /** Inspect/modify/drop each event before queueing. */
  beforeSend?: BeforeSendHook;
  /** When true, the client collects nothing (e.g. respect Do-Not-Track). */
  disabled?: boolean;
  /**
   * Capture generic browser lifecycle events — `viewport_resize` (debounced),
   * `focus_change`, and `visibility_change` — so the timeline records when the
   * canvas was resized, blurred, or backgrounded. Default true. The session
   * flush-on-hidden and end-on-pagehide behavior is always active regardless.
   */
  captureLifecycle?: boolean;
  /** Debounce window for `viewport_resize`, in ms. Default 250. */
  resizeDebounceMs?: number;
  /**
   * Capture JavaScript errors and unhandled promise rejections as
   * `runtime_error` events (`window.onerror` / `unhandledrejection`). Off by
   * default because error text can carry PII (ADR 0013) — when enabled, use
   * `beforeSend` to redact or drop. Consecutive identical errors are deduped and
   * at most 50 are emitted per session.
   */
  captureErrors?: boolean;
  /** Emit debug logs to the console. */
  debug?: boolean;
}

/** Config with defaults applied. */
export interface ResolvedConfig {
  projectId: string;
  endpoint: string;
  sdkVersion: string;
  batchSize: number;
  flushIntervalMs: number;
  maxQueueSize: number;
  offload: "main" | "worker";
  disabled: boolean;
  captureLifecycle: boolean;
  resizeDebounceMs: number;
  captureErrors: boolean;
  debug: boolean;
}

/** Optional metadata passed to `start`. */
export interface StartMeta {
  /** Device/GPU capabilities, supplied by engine adapters that can introspect them. */
  device?: Device;
  /** Underlying graphics technology (API/backend/version/shading language) (ADR 0021). */
  graphics?: Graphics;
  /** Coarse scene descriptor (camera kind, mesh count, description). */
  scene?: SceneMeta;
  /** Connector/engine provenance and the source's native coordinate frame (ADR 0018). */
  connector?: Connector;
  /** Caller-supplied, anonymized user context. Opt-in; never PII. */
  user?: SessionUser;
  /** Page/document context. */
  pageMeta?: PageMeta;
  /** Page URL. Defaults to `location.href` when available. */
  url?: string;
  /** Initial scene/area id (ADR 0010). Stamped on `session_start` and after. */
  sceneId?: string;
}
