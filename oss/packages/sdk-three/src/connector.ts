import type { Connector } from "@uptimizr/schema";
// three is a peer dependency; `REVISION` is a plain module constant (no WebGL /
// DOM), so reading it here is the idiomatic way to discover the engine version.
// esbuild keeps `three` external — it is never bundled.
import { REVISION } from "three";

/**
 * Read the {@link Connector} provenance block for a three.js scene (ADR 0018):
 * the engine id, its revision when discoverable, and the connector's **native**
 * world coordinate frame.
 *
 * three.js is **right-handed / y-up** by default and — unlike Babylon's
 * `useRightHandedSystem` — exposes no per-scene handedness flag, so the frame is a
 * fixed constant for this connector. World-space payloads are normalized to the
 * canonical frame (left-handed, y-up) at the emission boundary; `coordinateSystem`
 * records the *source* frame, not the frame the data is in.
 *
 * Pass the result to `client.start({ connector })` so it rides along on the
 * `session_start` event. `trackScene` does this automatically.
 *
 * A connector built **on top of** this one (e.g. `@uptimizr/r3f`, which renders
 * through three) can pass `overrides` to re-attribute the session — `{ name: "r3f" }`
 * keeps three's native right-handed coordinate frame while reporting itself as the
 * source connector. Only the identity (`name`/`version`) is overridable; the
 * `coordinateSystem` is always three's native frame.
 */
export function readConnector(overrides?: { name?: string; version?: string }): Connector {
  const connector: Connector = {
    name: overrides?.name ?? "three",
    coordinateSystem: { handedness: "right", upAxis: "y", unitScale: 1 },
  };

  // `REVISION` is three's minor revision (e.g. "169"); record it when present.
  if (typeof REVISION === "string" && REVISION) connector.version = REVISION;
  // An explicit override wins over the detected three.js revision.
  if (overrides?.version) connector.version = overrides.version;

  return connector;
}
