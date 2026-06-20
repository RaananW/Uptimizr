import type { Connector } from "@uptimizr/schema";
// `@babylonjs/lite` is an (optional) peer dependency; `VERSION` is a plain module
// constant (no WebGPU / DOM), so reading it here is the idiomatic way to discover
// the engine version. esbuild keeps `@babylonjs/lite` external — it is never
// bundled. NOTE: at the reviewed release the exported `VERSION` reads "0.1.0",
// which is stale relative to the published package version (1.0.1); we emit it
// verbatim for provenance rather than fabricating a value, and let an explicit
// `overrides.version` win.
import { VERSION } from "@babylonjs/lite";

/**
 * Read the {@link Connector} provenance block for a Babylon Lite scene (ADR
 * 0018): the engine id, its library version when discoverable, and the
 * connector's **native** world coordinate frame.
 *
 * Babylon Lite is **left-handed / y-up / unit-scale 1** — the same frame as the
 * canonical wire frame — so the `toCanonical*` helpers at the emission boundary
 * are identities. They are still called for symmetry/provenance with the other
 * connectors; `coordinateSystem` records the source frame regardless.
 *
 * Pass the result to `client.start({ connector })` so it rides along on the
 * `session_start` event. `trackScene` does this automatically.
 */
export function readConnector(overrides?: { name?: string; version?: string }): Connector {
  const connector: Connector = {
    name: overrides?.name ?? "babylon-lite",
    coordinateSystem: { handedness: "left", upAxis: "y", unitScale: 1 },
  };

  if (typeof VERSION === "string" && VERSION) connector.version = VERSION;
  // An explicit override wins over the (possibly stale) detected Lite version.
  if (overrides?.version) connector.version = overrides.version;

  return connector;
}
