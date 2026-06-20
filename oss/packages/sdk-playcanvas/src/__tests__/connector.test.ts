import { describe, expect, it } from "vitest";
import { version } from "playcanvas";
import { readConnector } from "../connector.js";

describe("readConnector", () => {
  it("identifies the playcanvas connector with its native right-handed y-up frame", () => {
    const connector = readConnector();
    expect(connector.name).toBe("playcanvas");
    expect(connector.coordinateSystem).toEqual({ handedness: "right", upAxis: "y", unitScale: 1 });
  });

  it("reports the PlayCanvas version string as the version", () => {
    expect(readConnector().version).toBe(version);
  });
});
