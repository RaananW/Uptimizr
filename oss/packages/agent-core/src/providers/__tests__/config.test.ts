import { describe, expect, it } from "vitest";
import {
  BACKEND_CONFIG_STORAGE_KEY,
  clearBackendConfig,
  defaultBackendKind,
  isWebGpuAvailable,
  loadBackendConfig,
  saveBackendConfig,
  type AssistantBackendConfig,
  type KeyValueStorage,
} from "../config.js";

function memoryStorage(initial: Record<string, string> = {}): KeyValueStorage & {
  map: Map<string, string>;
} {
  const map = new Map(Object.entries(initial));
  return {
    map,
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => void map.set(k, v),
    removeItem: (k) => void map.delete(k),
  };
}

const hosted: AssistantBackendConfig = {
  backend: "hosted",
  hosted: { api: "openai", endpoint: "https://api.example.com/v1", apiKey: "sk-x", model: "gpt-x" },
};

describe("backend config persistence", () => {
  it("round-trips a saved selection", () => {
    const storage = memoryStorage();
    saveBackendConfig(hosted, storage);
    expect(storage.map.get(BACKEND_CONFIG_STORAGE_KEY)).toBe(JSON.stringify(hosted));
    expect(loadBackendConfig(storage)).toEqual(hosted);
  });

  it("returns null when nothing is stored", () => {
    expect(loadBackendConfig(memoryStorage())).toBeNull();
  });

  it("treats corrupt or malformed entries as absent", () => {
    expect(loadBackendConfig(memoryStorage({ [BACKEND_CONFIG_STORAGE_KEY]: "{not json" }))).toBeNull();
    expect(
      loadBackendConfig(memoryStorage({ [BACKEND_CONFIG_STORAGE_KEY]: '{"backend":"bogus"}' })),
    ).toBeNull();
  });

  it("clears a stored selection", () => {
    const storage = memoryStorage({ [BACKEND_CONFIG_STORAGE_KEY]: JSON.stringify(hosted) });
    clearBackendConfig(storage);
    expect(storage.map.has(BACKEND_CONFIG_STORAGE_KEY)).toBe(false);
  });

  it("is a no-op (does not throw) when storage is unavailable", () => {
    expect(() => saveBackendConfig(hosted, undefined)).not.toThrow();
    expect(loadBackendConfig(undefined)).toBeNull();
    expect(() => clearBackendConfig(undefined)).not.toThrow();
  });
});

describe("WebGPU detection and default backend", () => {
  it("detects WebGPU from navigator.gpu", () => {
    expect(isWebGpuAvailable({ gpu: {} } as unknown as Navigator)).toBe(true);
    expect(isWebGpuAvailable({} as unknown as Navigator)).toBe(false);
    expect(isWebGpuAvailable(undefined)).toBe(false);
  });

  it("defaults to local when WebGPU is present, hosted otherwise", () => {
    expect(defaultBackendKind({ gpu: {} } as unknown as Navigator)).toBe("local");
    expect(defaultBackendKind({} as unknown as Navigator)).toBe("hosted");
  });
});
