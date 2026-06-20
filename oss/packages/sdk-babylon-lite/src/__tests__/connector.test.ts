import { describe, expect, it } from "vitest";
import { VERSION } from "@babylonjs/lite";
import { readConnector } from "../connector.js";

describe("readConnector", () => {
  it("identifies the babylon-lite connector with its native left-handed y-up frame", () => {
    const connector = readConnector();
    expect(connector.name).toBe("babylon-lite");
    expect(connector.coordinateSystem).toEqual({ handedness: "left", upAxis: "y", unitScale: 1 });
  });

  it("reports the Babylon Lite VERSION as the version", () => {
    expect(readConnector().version).toBe(VERSION);
  });

  it("lets a connector built on top of Lite override the identity", () => {
    const connector = readConnector({ name: "my-engine" });
    expect(connector.name).toBe("my-engine");
    // ...but the coordinate frame is still Lite's native left-handed y-up frame.
    expect(connector.coordinateSystem).toEqual({ handedness: "left", upAxis: "y", unitScale: 1 });
    expect(connector.version).toBe(VERSION);
  });

  it("lets the override supply an explicit version", () => {
    expect(readConnector({ name: "x", version: "9.9.9" }).version).toBe("9.9.9");
  });
});
