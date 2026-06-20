/**
 * Capture-fidelity sampling profile (ADR 0012).
 *
 * Fidelity is an explicit, per-channel, developer-owned contract with
 * conservative defaults and no hard cap. The dial governs **continuous** channels
 * only — camera/head pose, pointer move, and (ADR 0011) controller/hand poses.
 * **Discrete** semantic events (`pointer_click`, `pointer_down`/`pointer_up`,
 * `mesh_interaction`, `scene_change`, `session_start`/`session_end`, `custom`)
 * are always captured at 100% and MUST NOT be rate-limited.
 *
 * The profile is a static literal at init today; it is shaped so the same object
 * can later be fetched from the collector per project (remote config) without a
 * redesign.
 */

/**
 * A per-channel sample rate:
 * - a positive number — target rate in **Hz** (samples/second),
 * - `0` — channel off (do not sample),
 * - `"frame"` — emit every render tick (the 100% / per-frame case).
 */
export type SampleRate = number | "frame";

/**
 * Per-channel and per-source sampling rates. Omitted channels fall back to the
 * connector's conservative defaults (≈1 Hz camera, ≈4 Hz pointer, ≈0.5 Hz perf).
 */
export interface SamplingProfile {
  /** Camera/head pose channel. */
  camera?: SampleRate;
  /** Pointer-move channel. */
  pointerMove?: SampleRate;
  /** Performance (FPS) channel. */
  perf?: SampleRate;
  /**
   * Per-source overrides keyed by input-source id (ADR 0011), e.g.
   * `{ leftController: 30, rightHand: 30, gaze: 0 }`. Forward-looking: connectors
   * apply these to the continuous pose stream of each source they capture.
   */
  perSource?: Record<string, SampleRate>;
  /**
   * Scene-actor (`node_transform`) capture rates, keyed by the developer-declared
   * actor id (ADR 0027 Tier 1). **Default OFF** — only ids listed here are
   * sampled, and each MUST also be declared in the connector's `actors` map; an
   * unknown id is a no-op with a dev-mode warning. There is no "track all nodes"
   * switch (cost + privacy). Example: `{ "npc-guard": 10, elevator: "frame" }`.
   *
   * A value may also be a {@link NodeSamplingConfig} to opt the actor's **subtree**
   * into capture (ADR 0033) — e.g. a whole glTF whose internal parts move
   * independently. The descendant transforms are emitted as `node_transform`
   * samples carrying a `childPath` (engine node path relative to the actor); the
   * walk is anchored, bounded (`maxDepth`/`maxNodes`), and still opt-in.
   */
  nodes?: Record<string, SampleRate | NodeSamplingConfig>;
  /**
   * Skeleton-bone (`node_transform` with `boneId`) capture, keyed by the
   * developer-declared actor id (ADR 0027 **Tier 2** — opt-in, higher cost and
   * privacy). The actor MUST also be declared in `actors` and resolve to a
   * skinned node with a skeleton. Each entry allowlists the bones to capture
   * (`include`) and an optional rate (`hz`); bone transforms are skeleton-local.
   * A humanoid rig is ~50–65 bones, so there is **no whole-skeleton default** —
   * `include: "*"` is a permitted but explicitly expensive opt-in.
   * Example: `{ "npc-guard": { include: ["mixamorig:RightHand"], hz: 30 } }`.
   */
  bones?: Record<string, BoneSamplingConfig>;
}

/**
 * Tier-2 bone-capture configuration for one declared actor (ADR 0027 §5). The
 * `include` allowlist is required — either an explicit list of bone names or the
 * explicit `"*"` wildcard for the full rig (documented as expensive). `hz`
 * follows the same {@link SampleRate} vocabulary as every other channel and
 * defaults to the connector's node default when omitted.
 */
export interface BoneSamplingConfig {
  /** Bone names to capture, or `"*"` for the whole rig (explicit, expensive). */
  include: string[] | "*";
  /** Capture rate for this actor's bones (Hz / `"frame"` / `0`-off). */
  hz?: SampleRate;
}

/**
 * Tier-1 **subtree** capture configuration for one declared actor (ADR 0033).
 * Lets a single declared actor stand in for a moving hierarchy (e.g. a glTF whose
 * internal parts animate) without naming every descendant. Each captured
 * descendant is emitted as a `node_transform` carrying a `childPath` (the engine
 * node path relative to the actor). The walk is anchored to the actor, visits
 * transform nodes only (bones go through {@link BoneSamplingConfig}; cameras are
 * refused), and is **bounded** so a deep/wide hierarchy cannot blow up the wire.
 */
export interface NodeSamplingConfig {
  /** Capture rate for the actor and its captured descendants. */
  hz?: SampleRate;
  /**
   * Descendant node names to also capture, or `"*"` for every descendant under
   * the caps below. Omitted ⇒ root-only (identical to a bare {@link SampleRate}).
   */
  include?: string[] | "*";
  /** Max depth below the actor to descend (root is depth 0). Default 8. */
  maxDepth?: number;
  /** Max number of descendants to capture after deterministic BFS truncation. Default 64. */
  maxNodes?: number;
  /** Descendant node names to skip (and prune their subtree). */
  exclude?: string[];
}

/** A channel's resolved cadence: off, every render frame, or a fixed interval. */
export type ResolvedCadence =
  | { readonly mode: "off" }
  | { readonly mode: "frame" }
  | { readonly mode: "interval"; readonly ms: number };

/**
 * Resolve a {@link SampleRate} (or `undefined`) into a concrete cadence.
 *
 * - `undefined` ⇒ the connector default (`defaultMs`), preserving the legacy
 *   `sampleCameraMs`/`samplePerfMs`/`pointerMoveThrottleMs` knobs.
 * - `"frame"` ⇒ every render tick.
 * - `0` (or any non-positive number) ⇒ off.
 * - `N` Hz ⇒ an interval of `1000 / N` ms.
 *
 * There is no enforced upper bound in the OSS SDK (ADR 0012 §3); a caller may opt
 * into `"frame"` on every channel.
 */
export function resolveCadence(rate: SampleRate | undefined, defaultMs: number): ResolvedCadence {
  if (rate === undefined) return { mode: "interval", ms: defaultMs };
  if (rate === "frame") return { mode: "frame" };
  if (rate <= 0) return { mode: "off" };
  return { mode: "interval", ms: 1000 / rate };
}
