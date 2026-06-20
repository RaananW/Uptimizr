import { describe, expect, it, vi, afterEach } from "vitest";
import { render, screen, waitFor, cleanup } from "@testing-library/react";
import { UptimizrProvider } from "../provider";
import { SessionsPanel } from "../panels/SessionsPanel";
import { PerformanceSummaryPanel } from "../panels/PerformanceSummaryPanel";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function mockFetch(body: unknown): typeof fetch {
  return vi.fn(async () => ({
    ok: true,
    status: 200,
    statusText: "OK",
    json: async () => body,
    text: async () => JSON.stringify(body),
  })) as unknown as typeof fetch;
}

describe("UptimizrProvider + panels", () => {
  it("SessionsPanel fetches through the provider and renders rows", async () => {
    vi.stubGlobal(
      "fetch",
      mockFetch([
        {
          session_id: "abcdef123456",
          visitor_id: "v0001abc",
          events: "7",
          started_at: "2026-01-01 00:00:00",
        },
      ]),
    );

    render(
      <UptimizrProvider endpoint="http://localhost:4318" apiKey="k">
        <SessionsPanel />
      </UptimizrProvider>,
    );

    await waitFor(() => expect(screen.getByText("abcdef123456")).toBeTruthy());
    expect(screen.getByText("1 most recent")).toBeTruthy();
  });

  it("PerformanceSummaryPanel shows an empty state with no samples", async () => {
    vi.stubGlobal("fetch", mockFetch({ samples: 0, avg_fps: 0, min_fps: 0, p50_fps: 0 }));

    render(
      <UptimizrProvider endpoint="http://localhost:4318" apiKey="k">
        <PerformanceSummaryPanel />
      </UptimizrProvider>,
    );

    await waitFor(() => expect(screen.getByText("No performance samples in range.")).toBeTruthy());
  });

  it("throws when a panel is used without a provider", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(() => render(<SessionsPanel />)).toThrow(/UptimizrProvider/);
    spy.mockRestore();
  });
});
