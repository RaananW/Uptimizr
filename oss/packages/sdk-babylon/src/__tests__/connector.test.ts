import { describe, expect, it } from "vitest";
import type { Scene } from "@babylonjs/core";
import { readConnector } from "../connector.js";

function fakeScene(opts: { rightHanded?: boolean; version?: string } = {}): Scene {
  class FakeEngine {
    static Version = opts.version;
  }
  return {
    useRightHandedSystem: opts.rightHanded ?? false,
    getEngine: () => new FakeEngine(),
  } as unknown as Scene;
}

describe("readConnector", () => {
  it("identifies the Babylon connector with the canonical left-handed y-up frame", () => {
    const connector = readConnector(fakeScene());
    expect(connector.name).toBe("babylon");
    expect(connector.coordinateSystem).toEqual({ handedness: "left", upAxis: "y", unitScale: 1 });
  });

  it("reflects a right-handed scene in the recorded coordinate frame", () => {
    const connector = readConnector(fakeScene({ rightHanded: true }));
    expect(connector.coordinateSystem?.handedness).toBe("right");
  });

  it("reports the engine library version when discoverable, and omits it otherwise", () => {
    expect(readConnector(fakeScene({ version: "7.1.0" })).version).toBe("7.1.0");
    expect(readConnector(fakeScene()).version).toBeUndefined();
  });
});
