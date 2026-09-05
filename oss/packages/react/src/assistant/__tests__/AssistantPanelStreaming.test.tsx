import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react";
import type { LlmProvider, ProviderRequest, ProviderResponse } from "@uptimizr/agent-core";
import type { CollectorApi } from "../../api";
import { AssistantPanel } from "../AssistantPanel";

let nextProvider: LlmProvider;

vi.mock("@uptimizr/agent-core/providers/hosted", async (importActual) => ({
  ...(await importActual<Record<string, unknown>>()),
  createHostedProvider: () => nextProvider,
}));

/**
 * A provider whose single turn streams deltas on demand: the test controls
 * exactly when each token arrives and when the turn completes, so it can
 * assert the intermediate DOM.
 */
function controlledStream(finalResponse: ProviderResponse) {
  let onToken: ((delta: string) => void) | undefined;
  let finish!: () => void;
  const provider: LlmProvider = {
    complete: vi.fn(
      (request: ProviderRequest) =>
        new Promise<ProviderResponse>((resolve) => {
          onToken = request.onToken;
          finish = () => resolve(finalResponse);
        }),
    ),
  };
  return {
    provider,
    push: (delta: string) => onToken?.(delta),
    finish: () => finish(),
  };
}

function fakeApi(rows: unknown = []): CollectorApi {
  return { read: vi.fn(async () => rows) } as unknown as CollectorApi;
}

const HOSTED = {
  backend: "hosted" as const,
  hosted: { api: "openai" as const, endpoint: "https://api.example/v1", apiKey: "k", model: "m" },
};

function ask(text: string) {
  fireEvent.change(screen.getByLabelText("Message"), { target: { value: text } });
  fireEvent.click(screen.getByRole("button", { name: "Send" }));
}

beforeEach(() => localStorage.clear());
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("<AssistantPanel> streaming", () => {
  it("renders the partial answer live, flips the indicator to Streaming…, then replaces it with the final answer (no duplicate bubble)", async () => {
    const stream = controlledStream({ kind: "final", content: "Average 58 fps." });
    nextProvider = stream.provider;
    render(<AssistantPanel api={fakeApi()} backend={HOSTED} />);

    ask("how's perf?");
    // Before any token: the plain working indicator, no assistant bubble.
    await waitFor(() => expect(screen.getByRole("status").textContent).toMatch(/thinking/i));
    expect(document.querySelectorAll('[data-role="assistant"]')).toHaveLength(0);

    // Tokens arrive: the bubble shows the accumulated text and the live region
    // says it is streaming (the tokens themselves are NOT in the live region).
    stream.push("Average ");
    await waitFor(() =>
      expect(document.querySelector('[data-role="assistant"][data-streaming="true"]')).toBeTruthy(),
    );
    stream.push("58 ");
    await waitFor(() =>
      expect(
        document.querySelector('[data-role="assistant"][data-streaming="true"]')?.textContent,
      ).toContain("Average 58 "),
    );
    expect(screen.getByRole("status").textContent).toMatch(/streaming/i);
    expect(screen.getByRole("status").textContent).not.toContain("Average");

    // The turn completes: exactly one assistant bubble, the final text, no
    // streaming marker, indicator cleared, no "no answer" notice.
    stream.push("fps.");
    stream.finish();
    await waitFor(() => expect(screen.getByText("Average 58 fps.")).toBeTruthy());
    const bubbles = document.querySelectorAll('[data-role="assistant"]');
    expect(bubbles).toHaveLength(1);
    expect(bubbles[0]!.getAttribute("data-streaming")).toBeNull();
    expect(screen.getByRole("status").textContent?.trim()).toBe("");
    expect(screen.queryByText(/finished without a text answer/i)).toBeNull();
  });

  it("keeps the no-text-answer fallback when a streamed turn ends empty", async () => {
    // Nothing streams and the (non-forced) result is empty → the explicit notice.
    nextProvider = {
      complete: vi.fn(async () => ({ kind: "final", content: "" }) as ProviderResponse),
    };
    render(<AssistantPanel api={fakeApi()} backend={HOSTED} />);
    ask("summarize");
    await waitFor(() => expect(screen.getByText(/finished without a text answer/i)).toBeTruthy());
    expect(document.querySelector('[data-streaming="true"]')).toBeNull();
  });

  it("does not show a streaming bubble for a provider that answers all at once", async () => {
    nextProvider = {
      complete: vi.fn(async () => ({ kind: "final", content: "All at once." }) as ProviderResponse),
    };
    render(<AssistantPanel api={fakeApi()} backend={HOSTED} />);
    ask("q");
    await waitFor(() => expect(screen.getByText("All at once.")).toBeTruthy());
    expect(document.querySelectorAll('[data-role="assistant"]')).toHaveLength(1);
    expect(document.querySelector('[data-streaming="true"]')).toBeNull();
  });
});
