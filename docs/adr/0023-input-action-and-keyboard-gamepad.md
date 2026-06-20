# ADR 0023: Input-action events and the keyboard/gamepad input layer

- **Status:** Accepted
- **Date:** 2026-06-17
- **Deciders:** RaananW, engineering

## Context

[ADR 0011](./0011-input-source-agnostic-events.md) made interaction events **source-agnostic**:
`mesh_interaction` and the `pointer_*` family all spread `inputSourceShape`
(`source` / `handedness` / `sourceId` / optional world-space `ray`), `screen` is optional, and XR
actions route through `mesh_interaction` kinds (`select` / `squeeze` / `grab` / `release` /
`teleport`). It **deliberately deferred** renaming the family to a generic `input_*` model as
"cleanest long-term, but mostly cosmetic for now," and it scoped its `source` enum to pointer- and
ray-like devices:
`mouse | touch | stylus | pen | xr-controller | hand | gaze | transient | other`.

The remaining request — _"mouse clicks are first-level events; abstract them to **input** so we
support keyboard, gamepads, and XR controllers the same way we support mouse"_ — exposes three gaps
ADR 0011 does not cover:

1. **The `source` enum has no `keyboard` and no `gamepad`.** Two first-class input devices cannot
   be expressed at all.
2. **Keyboard is not a pointer or a ray.** It has no `screen`, no `hitPoint`, no `ray`; it is a
   discrete _action_ (a key or chord, often bound to a scene action such as "rotate", "next
   camera", "jump"). It does not fit the `pointer_*` payload and must not be crammed into it.
3. **Gamepad is dual-natured.** It behaves both as a _pointer/ray_ (XR-style aim, which already fits
   the ray path) and as _continuous navigation_ (stick-driven camera, already covered by
   `camera_sample`), plus discrete _button actions_ (which have no pointer/ray home today).

XR controllers are already handled by ADR 0011, so this ADR's net-new surface is **keyboard and
gamepad**, and the **discrete-action shape** they share.

## Decision

Extend — not supersede — ADR 0011 with a minimal, additive input layer.

1. **Add `keyboard` and `gamepad` to `inputSourceSchema`.** Additive enum values; existing data and
   the `source`-absent-⇒-`"mouse"` default are unaffected (ADR 0011 §1, ADR 0007 additive pattern).

2. **Add a new `input_action` event** for _discrete, non-pointer, non-ray_ inputs. Payload:
   - `action: string` (**required**) — the semantic, app-level action (e.g. `"rotate-left"`,
     `"next-camera"`); free-text, app-defined. It is required because an action without a label is
     noise; a connector with no semantic mapping falls back to the raw `code`/`button` token as the
     action so the field is always meaningful.
   - `code?: string` — the raw key code (`KeyboardEvent.code`, e.g. `"KeyW"`) when the source is
     `keyboard`.
   - `button?: number` — the raw button index when the source is `gamepad`.
   - `pressed?: boolean` — down vs. up, so press-and-hold can be reconstructed (mirrors the
     `pointer_down`/`pointer_up` rationale) without two event types.
   - `...inputSourceShape` — so `source` (`keyboard` / `gamepad` / …), `handedness`, and `sourceId`
     come along uniformly.

   `input_action` carries **no `screen`, no `hitPoint`, no `ray`** — that is exactly what
   distinguishes it from `pointer_*`. The engine-neutral emission path is an explicit
   `client.trackInput(action, opts)` call; connectors may additionally auto-capture, but only from
   an **explicit binding allowlist** (see §5), never by listening to every key.

3. **Routing stays per-nature, not per-device.**
   - **Pointer/ray inputs** (mouse, touch, stylus, pen, XR controller/hand aim, gaze, **gamepad
     aim**) continue through `pointer_*` / `mesh_interaction`, tagged by `source`.
   - **Discrete non-pointer actions** (keyboard keys/chords, **gamepad buttons** bound to actions)
     flow through `input_action`.
   - **Continuous navigation** (stick-/key-driven camera motion) remains in `camera_sample` — it is
     pose, not a discrete interaction (consistent with ADR 0011's treatment of pose and ADR 0012's
     fidelity governance).

4. **Keep `pointer_*` named "pointer."** We do **not** revive the umbrella `input_*` rename that
   ADR 0011 §6 deferred: it would supersede three shipped events for cosmetic gain, whereas adding
   the two enum values plus `input_action` closes the real gap. `pointer_*` remains the flat-screen
   pointer path; `input_action` is the discrete keyboard/gamepad path; `mesh_interaction` remains
   the source-neutral "which object" signal.

5. **Storage, privacy, fidelity.** `input_action` ingests through the generic engine-neutral path
   like other events; `action`/`code` are low-cardinality, non-PII application labels (no free user
   text, no IME content — ADR 0003). To keep this true, a connector that auto-captures keyboard
   input does so **only for an explicit binding allowlist** (a `code → action` map the host
   supplies); unbound keys are ignored, so arbitrary typing is never recorded. Auto-capture is
   **off by default**. Key-repeat and held buttons are coalesced (the `keydown` auto-repeat is
   suppressed) rather than emitting one event per repeat tick. Replay gets an `input_action`
   handler so the timeline stays complete.

## Consequences

### Positive

- Keyboard and gamepad become first-class inputs with the **same** `source` vocabulary as mouse and
  XR, so connectors map their native input abstractions onto one ontology.
- The discrete-action gap is closed with **one** new event instead of a per-device family, keeping
  the aggregation and replay paths simple (the lesson ADR 0011 applied to XR).
- Fully backward-compatible: additive enum values + a new event; no existing event, column, or SDK
  call site changes.

### Negative / trade-offs

- `action` is free-text and app-defined, so cross-app comparison of action labels is limited; this
  is intentional (semantics are the app's), and `code`/`button` give a raw fallback.
- Keeping `pointer_*` named "pointer" while a parallel `input_action` exists continues the naming
  tension ADR 0011 accepted; preferred over superseding shipped events.
- Gamepad inputs split across three homes (aim → `pointer_*`, buttons → `input_action`, navigation
  → `camera_sample`); connectors must classify each gamepad input by nature. Documented in the
  connector guide.

## Alternatives considered

- **Revive the umbrella `input_*` rename** (supersede `pointer_*`) — cleanest single ontology, but
  supersedes three shipped events and churns SDK/connector/replay code for mostly cosmetic gain;
  deferred again, exactly as in ADR 0011 §6.
- **Cram keyboard/gamepad into `pointer_*`** with empty `screen`/`ray` — overloads a pointer payload
  with non-pointer data and pollutes pointer heatmaps; rejected.
- **A per-device family** (`key_press`, `gamepad_button`, …) — fragments aggregation and replay the
  same way ADR 0011 rejected for XR; rejected in favor of one `input_action` + `source`.
- **Treat all gamepad input as navigation** (`camera_sample` only) — loses discrete button actions
  and action semantics; rejected.

## Open questions

1. **Action vocabulary** — do we ship a small suggested set of canonical `action` labels for common
   bindings (move/rotate/zoom/select) to aid cross-app analytics, or leave it fully app-defined?
2. **Chords** — represent a multi-key chord as one `input_action` with a composite `code`/`action`,
   or as concurrent events correlated by `ts`? Lean toward one event per semantic action.
3. **Gamepad analog axes** — beyond stick-driven `camera_sample`, is there value in sampling raw
   axis magnitude (trigger pressure) as a low-rate signal? Defer until a use case appears.
