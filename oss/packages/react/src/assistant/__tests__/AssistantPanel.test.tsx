import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react";
import type { LlmProvider, ProviderResponse } from "@uptimizr/agent-core";
import type { CollectorApi } from "../../api";
import { AssistantPanel } from "../AssistantPanel";

let nextProvider: LlmProvider;

vi.mock("@uptimizr/agent-core/providers/hosted", async (importActual) => ({
  ...(await importActual<Record<string, unknown>>()),
  createHostedProvider: () => nextProvider,
}));
vi.mock("@uptimizr/agent-core/providers/webllm", async (importActual) => ({
  ...(await importActual<Record<string, unknown>>()),
  createWebLlmProvider: () => nextProvider,
}));

function scriptedProvider(steps: ProviderResponse[]): LlmProvider {
  let i = 0;
  return { complete: vi.fn(async () => steps[i++] ?? { kind: "final", content: "" }) };
}

function fakeApi(rows: unknown = []): CollectorApi {
  return { read: vi.fn(async () => rows) } as unknown as CollectorApi;
}

const HOSTED = {
  backend: "hosted" as const,
  hosted: { api: "openai" as const, endpoint: "https://api.example/v1", apiKey: "k", model: "m" },
};

beforeEach(() => {
  localStorage.clear();
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("<AssistantPanel>", () => {
  it("renders the heading and a backend-aware privacy note", () => {
    render(<AssistantPanel api={fakeApi()} backend={HOSTED} />);
    expect(screen.getByText("Analytics assistant")).toBeTruthy();
    expect(screen.getByText(/sent to your own provider/i)).toBeTruthy();
  });

  it("sends a message and renders the assistant answer", async () => {
    nextProvider = scriptedProvider([{ kind: "final", content: "You had 12 sessions." }]);
    render(<AssistantPanel api={fakeApi()} backend={HOSTED} />);

    fireEvent.change(screen.getByLabelText("Message"), {
      target: { value: "how many sessions?" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));

    await waitFor(() => expect(screen.getByText("You had 12 sessions.")).toBeTruthy());
    // The user's message is shown too.
    expect(screen.getByText("how many sessions?")).toBeTruthy();
  });

  it("reveals the backend picker with local and hosted options", () => {
    render(<AssistantPanel api={fakeApi()} backend={HOSTED} />);
    fireEvent.click(screen.getByRole("button", { name: "Backend" }));
    expect(screen.getByText(/Local \(WebLLM/i)).toBeTruthy();
    expect(screen.getByText(/Bring your own hosted provider/i)).toBeTruthy();
    // Hosted config fields are present when hosted is selected.
    expect(screen.getByLabelText("Endpoint")).toBeTruthy();
    expect(screen.getByLabelText("API key")).toBeTruthy();
  });

  it("disables the local option when WebGPU is unavailable", () => {
    // happy-dom has no navigator.gpu, so local must be disabled.
    render(<AssistantPanel api={fakeApi()} backend={HOSTED} />);
    fireEvent.click(screen.getByRole("button", { name: "Backend" }));
    const radios = screen.getAllByRole("radio");
    const local = radios[0] as HTMLInputElement;
    expect(local.disabled).toBe(true);
  });

  it("shows a prompt to pick a backend when none is configured", () => {
    // No persisted config + no WebGPU ⇒ no default backend ⇒ not ready.
    render(<AssistantPanel api={fakeApi()} />);
    expect(screen.getByText(/Choose an LLM backend/i)).toBeTruthy();
  });
});
