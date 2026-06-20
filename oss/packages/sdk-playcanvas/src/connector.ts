import type { Connector } from "@uptimizr/schema";
// playcanvas is a peer dependency; `version` is a plain module constant (a
// semver string, no WebGL / DOM), so reading it here is the idiomatic way to
// discover the engine version. esbuild keeps `playcanvas` external — it is never
// bundled.
import { version } from "playcanvas";

/**
 * Read the {@link Connector} provenance block for a PlayCanvas scene (ADR 0018):
 * the engine id, its version when discoverable, and the connector's **native**
 * world coordinate frame.
 *
 * PlayCanvas is **right-handed / y-up** and — unlike Babylon's
 * `useRightHandedSystem` — exposes no per-scene handedness flag, so the frame is a
 * fixed constant for this connector. World-space payloads are normalized to the
 * canonical frame (left-handed, y-up) at the emission boundary; `coordinateSystem`
 * records the *source* frame, not the frame the data is in.
 *
 * Pass the result to `client.start({ connector })` so it rides along on the
 * `session_start` event. `trackScene` does this automatically.
 */
export function readConnector(): Connector {
  const connector: Connector = {
    name: "playcanvas",
    coordinateSystem: { handedness: "right", upAxis: "y", unitScale: 1 },
  };

  // `version` is PlayCanvas' semver string (e.g. "2.19.2"); record it when present.
  if (typeof version === "string" && version) connector.version = version;

  return connector;
}
