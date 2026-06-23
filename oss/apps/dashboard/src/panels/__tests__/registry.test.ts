import { describe, expect, it } from "vitest";
import type { PanelContext } from "@uptimizr/react";
import { builtinPanels } from "../registry";

/** Minimal context stub for exercising a panel's `enabled` predicate. */
function ctxWithCameraMode(cameraMode: "viewer" | "first-person" | undefined): PanelContext {
  return { filters: { window: "24h", cameraMode } } as unknown as PanelContext;
}

describe("builtinPanels — floor-plan panel", () => {
  const panel = builtinPanels.find((p) => p.id === "floor-plan");

  it("is registered with the expected metadata", () => {
    expect(panel).toBeDefined();
    expect(panel?.span).toBe(1);
    expect(panel?.clientOnly).toBe(true);
    expect(panel?.surfaces).toEqual(["overview", "session"]);
  });

  it("is hidden in the orbit/viewer camera mode and shown otherwise", () => {
    expect(panel?.enabled?.(ctxWithCameraMode("viewer"))).toBe(false);
    expect(panel?.enabled?.(ctxWithCameraMode("first-person"))).toBe(true);
    expect(panel?.enabled?.(ctxWithCameraMode(undefined))).toBe(true);
  });
});
