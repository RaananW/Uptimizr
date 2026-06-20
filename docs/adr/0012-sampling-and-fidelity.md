# ADR 0012: Sampling, fidelity, and cost controls

- **Status:** Accepted
- **Date:** 2026-06-16
- **Deciders:** Project owner, engineering

## Context

Continuous signals — camera/head pose, pointer movement, and (with
[ADR 0011](./0011-input-source-agnostic-events.md)) controller/hand poses — can be emitted at any
rate from "occasionally" up to **once per rendered frame** (per-source, 60–90+ Hz in WebXR). The
SDK already samples per channel, conservatively:

- `sampleCameraMs` — default 1000 ms (1 Hz)
- `pointerMoveThrottleMs` — default 250 ms (4 Hz)
- `samplePerfMs` — default 2000 ms (0.5 Hz)
- `suppressIdleSamples: true` — skip timer samples when nothing changed

The owner's intent: **the tracking org decides how deep tracking goes — up to 100% of events and
positions every frame, per device and per controller** — with **conservative defaults**, and with
the explicit understanding that **higher fidelity costs storage/ingest** (a per-frame, multi-source
capture fills the database very quickly). This depth dial spans several event channels and
interacts with gaze-raycast cost (ADR 0010 Open Question 1), input devices (ADR 0011), privacy
(ADR 0003), and capture-cost trade-offs — so it is recorded as its own decision rather
than buried in any one of those.

## Decision

Treat **capture fidelity as an explicit, per-source, developer-owned contract** with conservative
defaults and no hard cap, governed by one principle: **the dial controls continuous channels only;
discrete semantic events are always captured at 100%.**

1. **Sampleable vs never-drop (the core boundary).**
   - **Continuous / sampleable:** camera/head pose, pointer move, controller/hand poses. These are
     a fidelity dial — sampling them changes resolution, not correctness.
   - **Discrete / never-sampled:** `pointer_click`, `pointer_down`/`pointer_up`, `mesh_interaction`
     (select/grab/…), `scene_change`, `session_start`/`session_end`, `custom`. These are **never**
     thinned regardless of the dial, because dropping them breaks replay-completeness (ADR 0006)
     and loses the actual conversions/interactions. The SDK MUST NOT apply rate limiting to discrete
     events.
2. **A `sampling` profile, per channel and per source.** A single config object expressed in **Hz**
   (or interval ms) per continuous channel, with per-source overrides:
   - `0` / off = do not sample that channel.
   - `N` Hz = throttle to at most N samples/second.
   - `"frame"` = emit every render tick (the 100% / per-frame case — explicitly allowed).
   - Per source: e.g. `head: 10, leftController: 30, rightHand: 30, mouse: 60, gaze: 0`.
   - `suppressIdleSamples` stays a free volume win (no motion ⇒ no sample) and is on by default.
3. **Conservative defaults, uncapped ceiling.** Defaults stay at today's low rates (≈1 Hz camera,
   ≈4 Hz pointer). There is **no enforced upper bound** in the SDK — a developer may opt into
   `"frame"` on every source.
4. **Static now, remote-ready.** The SDK accepts the `sampling` profile as a literal at init
   (`trackScene({ sampling })`). The init contract is designed so the same profile object can later
   be **fetched** from the collector per project (an org admin tunes fidelity from the dashboard
   without redeploying the host app). v1 is static; the remote-config fetch is a drop-in successor,
   not a re-design. We do **not** build remote config now.
5. **Fidelity and privacy are coupled (ADR 0003 / ADR 0010 OQ5).** Higher head/hand sample rates
   expose finer biometric-adjacent detail (height, gait, tremor, room layout). The sampling profile
   sits alongside privacy controls (sampling/rounding/opt-in for pose retention); turning fidelity
   up should consciously engage those controls, and per-frame pose capture is opt-in, never a
   default.
6. **Cost is surfaced.** Self-hosters own their store and bear their own volume. The SDK/dashboard
   SHOULD provide a **volume estimate** (e.g. "90 Hz × 5
   sources × ~4 min avg session ≈ N events/session ≈ ~G GB/month") so the choice is informed. An
   uncapped, per-frame, many-session configuration is otherwise a runaway cost.
7. **Adaptive degradation (principle, optional).** Because `framePerf` is already captured,
   connectors MAY auto-throttle continuous sampling when the host app's FPS drops below a threshold,
   so analytics never harms the experience it measures. Off unless enabled; never drops discrete
   events.

## Consequences

### Positive

- One coherent dial spans every continuous channel and every input source, from conservative to
  100%/per-frame, decided by the tracking org.
- Discrete conversions/interactions stay complete at any fidelity, so replay (ADR 0006) and
  conversion analytics remain correct no matter how the dial is set.
- Generalizes the sampling knobs the SDK already has rather than inventing a new mechanism;
  backward-compatible (existing `sampleCameraMs`/`pointerMoveThrottleMs` map onto the profile, old
  defaults preserved).
- Static-now/remote-ready keeps the SDK simple while leaving a clean path to dashboard-driven, no-redeploy
  fidelity control.

### Negative / trade-offs

- An uncapped ceiling means a misconfigured `"frame"`-everything project can generate very large
  data volumes; mitigated by conservative defaults and the volume estimate (6).
- Per-source/per-channel config is more surface area than a single global rate; mitigated by sane
  defaults so most integrators touch nothing.
- Remote config (deferred) will add a config endpoint, caching, and a "server influences client
  capture" privacy surface to reason about when it lands.
- Adaptive degradation makes effective sample rate variable, which downstream consumers must treat
  as "best effort, timestamped," not a guaranteed cadence (consistent with replay fidelity already
  depending on sampling).

## Alternatives considered

- **Single global sample rate** — simplest, but cannot express "60 Hz mouse but 1 Hz camera," nor
  per-controller depth; rejected for a per-channel/per-source profile.
- **Hard upper cap on rate** — would protect storage but contradicts the explicit "support 100% /
  every frame" requirement; rejected — the ceiling stays uncapped by default.
- **Sample discrete events too** (e.g. drop some clicks under load) — smaller volume, but breaks
  replay-completeness and loses conversions; firmly rejected — only continuous channels are
  sampleable.
- **Remote/dynamic config from day one** — matches "org decides from the dashboard" most directly,
  but adds an endpoint, caching, and a privacy surface before they are needed; deferred behind a
  static profile that is shaped to accept a fetched value later.
- **Bury sampling inside ADR 0011 (input sources)** — but the dial governs camera pose and pointer
  move too, not just input devices, and couples to cost and privacy; kept as its own ADR.
