import { describe, expect, it } from "vitest";
import { REVISION } from "three";
import { readConnector } from "../connector.js";

describe("readConnector", () => {
  it("identifies the three connector with its native right-handed y-up frame", () => {
    const connector = readConnector();
    expect(connector.name).toBe("three");
    expect(connector.coordinateSystem).toEqual({ handedness: "right", upAxis: "y", unitScale: 1 });
  });

  it("reports the three.js REVISION as the version", () => {
    expect(readConnector().version).toBe(REVISION);
  });

  it("lets a connector built on top of three override the identity (e.g. r3f)", () => {
    const connector = readConnector({ name: "r3f" });
    // Identity is re-attributed to the wrapping connector...
    expect(connector.name).toBe("r3f");
    // ...but the coordinate frame is still three's native right-handed y-up frame.
    expect(connector.coordinateSystem).toEqual({ handedness: "right", upAxis: "y", unitScale: 1 });
    // Version still defaults to the detected three.js revision when not overridden.
    expect(connector.version).toBe(REVISION);
  });

  it("lets the override supply an explicit version", () => {
    expect(readConnector({ name: "r3f", version: "9.9.9" }).version).toBe("9.9.9");
  });
});
