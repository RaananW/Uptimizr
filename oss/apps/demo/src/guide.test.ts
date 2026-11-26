import { afterEach, describe, expect, it, vi } from "vitest";
import {
  GUIDE_STEPS,
  SESSION_STEP,
  isSessionPath,
  readGuideEnabled,
  readGuideStep,
  writeGuideEnabled,
  writeGuideStep,
} from "./guide.js";

/** A minimal in-memory localStorage. */
function memoryStorage() {
  const map = new Map<string, string>();
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
  };
}

afterEach(() => vi.unstubAllGlobals());

describe("demo guide", () => {
  it("recognises the dashboard session view under any base path", () => {
    expect(isSessionPath("/dashboard/projects/demo/session/abc-123")).toBe(true);
    expect(isSessionPath("/projects/demo/session/abc")).toBe(true);
    expect(isSessionPath("/dashboard/projects/demo")).toBe(false);
    expect(isSessionPath("/dashboard/index.html")).toBe(false);
  });

  it("has a session step to jump to", () => {
    expect(SESSION_STEP).toBeGreaterThan(0);
    expect(GUIDE_STEPS[SESSION_STEP]?.target).toBe("dashboard");
  });

  it("is on by default and remembers being turned off", () => {
    vi.stubGlobal("localStorage", memoryStorage());
    expect(readGuideEnabled()).toBe(true);
    writeGuideEnabled(false);
    expect(readGuideEnabled()).toBe(false);
    writeGuideEnabled(true);
    expect(readGuideEnabled()).toBe(true);
  });

  it("remembers the step and ignores an out-of-range one", () => {
    vi.stubGlobal("localStorage", memoryStorage());
    expect(readGuideStep()).toBe(0);
    writeGuideStep(3);
    expect(readGuideStep()).toBe(3);
    writeGuideStep(GUIDE_STEPS.length + 5);
    expect(readGuideStep()).toBe(0);
  });

  it("falls back to its defaults when storage throws", () => {
    const throwing = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
    };
    vi.stubGlobal("localStorage", throwing);
    expect(readGuideEnabled()).toBe(true);
    expect(readGuideStep()).toBe(0);
    expect(() => writeGuideEnabled(false)).not.toThrow();
    expect(() => writeGuideStep(2)).not.toThrow();
  });
});
