import type { Connector } from "@uptimizr/schema";
import type { NativeFrame } from "./types.js";

/**
 * Build the {@link Connector} provenance block for a web-export connector (ADR
 * 0018 / ADR 0045): the engine id, an optional version, and the engine's **native**
 * world coordinate frame.
 *
 * Web exports compile the engine to WebAssembly and render into a `<canvas>`, so —
 * unlike the JS-engine connectors — there is no live scene object to read a
 * handedness flag from; the frame is a fixed property of the engine and is passed
 * in by the engine package (`@uptimizr/unity` / `@uptimizr/godot` / `@uptimizr/unreal`).
 *
 * The payload that rides the wire is always **canonical** (left-handed, y-up, unit
 * scale 1); `coordinateSystem` records what the *source* frame was. Pass the result
 * to `client.start({ connector })`.
 *
 * No `@uptimizr/schema` change is required: `connector.name` is a free string and
 * `coordinateSystem` already encodes `handedness`, `upAxis`, and `unitScale`.
 */
export function buildConnector(name: string, frame: NativeFrame, version?: string): Connector {
  const connector: Connector = {
    name,
    coordinateSystem: {
      handedness: frame.handedness,
      upAxis: frame.upAxis,
      unitScale: frame.unitScale,
    },
  };
  if (version) connector.version = version;
  return connector;
}
