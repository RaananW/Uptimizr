import type { TrackSceneOptions } from "@uptimizr/three";

/**
 * Options for {@link useUptimizr} / {@link Uptimizr}.
 *
 * react-three-fiber renders three.js, so the capture engine is entirely
 * `@uptimizr/three`. These options are the three connector's {@link TrackSceneOptions}
 * verbatim — project id, collector `endpoint`, sampling/fidelity dials, the opt-in
 * `capture` channels, custom transport, and so on. The only thing the R3F layer adds
 * is sourcing the live `scene` / `camera` / `gl` from the R3F store, so those are not
 * part of the options surface.
 *
 * The `connector` provenance defaults to `{ name: "r3f" }` (sessions are attributed
 * to the R3F connector) while keeping three's native right-handed coordinate frame.
 * Callers may still override the connector `version`, or the `name` itself.
 */
export type UptimizrOptions = TrackSceneOptions;
