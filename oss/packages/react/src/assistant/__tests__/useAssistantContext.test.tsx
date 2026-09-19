/**
 * Project-context injection in `useAssistant` (ADR 0051 §5, design sketch §E.1).
 *
 * The hook reads `GET /api/v1/context` when the collector connection is
 * established and folds a compact rendering of it into the system prompt, so the
 * model sees this project's real scene ids, region ids and custom-event names
 * before it picks tool arguments. Two outcomes have to hold:
 *
 * - **with** a context: the names are in the system message, on every send,
 *   including one continued after the document arrived;
 * - **without** one — a collector too old to serve the endpoint, or a failing
 *   read — the assistant works exactly as it did before, with no error surfaced
 *   to the user.
 */

import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act, cleanup, waitFor } from "@testing-library/react";
import type { LlmProvider, ProviderResponse } from "@uptimizr/agent-core";
import type { CollectorApi } from "../../api";
import { useAssistant } from "../useAssistant";

vi.mock("@uptimizr/agent-core/providers/webllm", async (importActual) => ({
  ...(await importActual<Record<string, unknown>>()),
  createWebLlmProvider: () => nextProvider,
  clearCachedModels: async (): Promise<string[]> => [],
}));
vi.mock("@uptimizr/agent-core/providers/hosted", async (importActual) => ({
  ...(await importActual<Record<string, unknown>>()),
  createHostedProvider: () => nextProvider,
}));

let nextProvider: LlmProvider;

const HOSTED = {
  backend: "hosted" as const,
  hosted: { api: "openai" as const, endpoint: "https://api.example/v1", apiKey: "k", model: "m" },
};

/** A context document as the collector serves it (the fields the rendering uses). */
const CONTEXT = {
  project: { id: "p1", store: "duckdb", collectorVersion: "2.0.0" },
  dataQuality: {
    lastEventAt: Date.now() - 60_000,
    sessions24h: 12,
    retention: { rawSessions: false },
  },
  scenes: [
    {
      id: "main-hall",
      label: "Main Hall",
      proxy: true,
      regions: [{ id: "counter", label: "Till" }],
    },
  ],
  vocabulary: {
    customEvents: [{ name: "add_to_cart", count28d: 311, props: { sku: "string" } }],
    meshes: { count: 3, top: ["buy_button"] },
    inputActions: [],
  },
  metrics: { disabledByCapture: ["mesh_dwell"] },
};

/**
 * A collector whose `read` answers the context endpoint from `context` (or
 * rejects with `error`) and everything else with `[]`.
 */
function fakeApi(options: { context?: unknown; error?: Error } = {}) {
  const read = vi.fn(async (path: string) => {
    if (path === "api/v1/context") {
      if (options.error) throw options.error;
      return options.context ?? null;
    }
    return [];
  });
  return { read } as unknown as CollectorApi & { read: typeof read };
}

/** Capture the system message of every provider turn. */
function capturingProvider(): { provider: LlmProvider; systems: string[] } {
  const systems: string[] = [];
  return {
    systems,
    provider: {
      complete: vi.fn(async (req: { messages: { role: string; content: string }[] }) => {
        const system = req.messages.find((m) => m.role === "system");
        systems.push(system?.content ?? "");
        return { kind: "final", content: "ok" } as ProviderResponse;
      }),
    },
  };
}

beforeEach(() => {
  localStorage.clear();
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("useAssistant — project context", () => {
  it("fetches the context once the collector connection exists", async () => {
    const api = fakeApi({ context: CONTEXT });
    const { result } = renderHook(() => useAssistant({ api, backend: HOSTED }));

    await waitFor(() => expect(result.current.projectContext).not.toBeNull());
    expect(api.read).toHaveBeenCalledWith("api/v1/context");
    expect(result.current.projectContext).toMatchObject({ project: { id: "p1" } });
  });

  it("injects the project's real scene, region and custom-event names into the system prompt", async () => {
    const { provider, systems } = capturingProvider();
    nextProvider = provider;
    const api = fakeApi({ context: CONTEXT });
    const { result } = renderHook(() => useAssistant({ api, backend: HOSTED }));
    await waitFor(() => expect(result.current.projectContext).not.toBeNull());

    await act(async () => {
      await result.current.send("what sells best?");
    });

    const system = systems[0]!;
    expect(system).toContain("main-hall");
    expect(system).toContain("counter");
    expect(system).toContain("add_to_cart");
    expect(system).toContain("sku: string");
    expect(system).toContain("mesh_dwell");
    expect(system).toContain("Raw per-session retention is OFF");
    // The original prompt is still there, ahead of the context block.
    expect(system).toContain("epoch milliseconds:");
    expect(system.indexOf("Current time:")).toBeLessThan(system.indexOf("main-hall"));
  });

  it("keeps the context on every later send, in the single system message", async () => {
    const { provider, systems } = capturingProvider();
    nextProvider = provider;
    const api = fakeApi({ context: CONTEXT });
    const { result } = renderHook(() => useAssistant({ api, backend: HOSTED }));
    await waitFor(() => expect(result.current.projectContext).not.toBeNull());

    await act(async () => {
      await result.current.send("first");
    });
    await act(async () => {
      await result.current.send("second");
    });

    expect(systems).toHaveLength(2);
    for (const system of systems) expect(system).toContain("add_to_cart");
    expect(result.current.messages.filter((m) => m.role === "system")).toHaveLength(1);
  });

  it("degrades silently when the collector has no context endpoint (404)", async () => {
    const { provider, systems } = capturingProvider();
    nextProvider = provider;
    const api = fakeApi({ error: Object.assign(new Error("Not Found"), { status: 404 }) });
    const { result } = renderHook(() => useAssistant({ api, backend: HOSTED }));

    await waitFor(() => expect(api.read).toHaveBeenCalledWith("api/v1/context"));

    await act(async () => {
      await result.current.send("what sells best?");
    });

    expect(result.current.projectContext).toBeNull();
    // No error surfaced, and the prompt is the unchanged one.
    expect(result.current.error).toBeNull();
    expect(result.current.status).toBe("idle");
    expect(systems[0]).toContain("epoch milliseconds:");
    expect(systems[0]).not.toContain("Project context");
  });

  it("leaves the context null with no collector connection", () => {
    const { result } = renderHook(() => useAssistant({ backend: HOSTED }));
    expect(result.current.projectContext).toBeNull();
  });
});
