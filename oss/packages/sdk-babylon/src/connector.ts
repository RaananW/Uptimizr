import type { Scene } from "@babylonjs/core";
import type { Connector } from "@uptimizr/schema";

/**
 * Minimal view of the Babylon fields we read for connector provenance. Read
 * defensively (Babylon's API varies across versions/backends) rather than binding
 * to a concrete type.
 */
interface SceneFrameView {
  useRightHandedSystem?: boolean;
  getEngine?: () => { constructor?: { Version?: string } } | undefined;
}

/**
 * Read the {@link Connector} provenance block for a Babylon scene (ADR 0018):
 * the engine id, its version when discoverable, and the scene's **native** world
 * coordinate frame.
 *
 * Babylon is left-handed / y-up by default, which is Uptimizr's canonical wire
 * frame — so world-space data needs no conversion. The handedness is read from the
 * live scene (`useRightHandedSystem`) so the recorded frame is honest if the host
 * opted into right-handed mode.
 *
 * Pass the result to `client.start({ connector })` so it rides along on the
 * `session_start` event. `trackScene` does this automatically.
 */
export function readConnector(scene: Scene): Connector {
  const view = scene as unknown as SceneFrameView;
  const handedness = view.useRightHandedSystem === true ? "right" : "left";

  const connector: Connector = {
    name: "babylon",
    coordinateSystem: { handedness, upAxis: "y", unitScale: 1 },
  };

  const engine = typeof view.getEngine === "function" ? view.getEngine() : undefined;
  const version = engine?.constructor?.Version;
  if (typeof version === "string" && version) connector.version = version;

  return connector;
}
