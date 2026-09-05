import { describe, expect, it } from "vitest";
import { buildConnector } from "../connector.js";
import type { NativeFrame } from "../types.js";

describe("buildConnector", () => {
  it("records the Unity native frame (left-handed, y-up, meters)", () => {
    const frame: NativeFrame = { handedness: "left", upAxis: "y", unitScale: 1 };
    expect(buildConnector("unity", frame)).toEqual({
      name: "unity",
      coordinateSystem: { handedness: "left", upAxis: "y", unitScale: 1 },
    });
  });

  it("records the Godot native frame (right-handed, y-up, meters)", () => {
    const frame: NativeFrame = { handedness: "right", upAxis: "y", unitScale: 1 };
    expect(buildConnector("godot", frame).coordinateSystem).toEqual({
      handedness: "right",
      upAxis: "y",
      unitScale: 1,
    });
  });

  it("records the Unreal native frame (left-handed, z-up, centimeters)", () => {
    const frame: NativeFrame = { handedness: "left", upAxis: "z", unitScale: 100 };
    expect(buildConnector("unreal", frame).coordinateSystem).toEqual({
      handedness: "left",
      upAxis: "z",
      unitScale: 100,
    });
  });

  it("includes a version when provided", () => {
    const frame: NativeFrame = { handedness: "left", upAxis: "y", unitScale: 1 };
    expect(buildConnector("unity", frame, "2022.3").version).toBe("2022.3");
  });

  it("omits version when not provided", () => {
    const frame: NativeFrame = { handedness: "left", upAxis: "y", unitScale: 1 };
    expect(buildConnector("unity", frame)).not.toHaveProperty("version");
  });
});
