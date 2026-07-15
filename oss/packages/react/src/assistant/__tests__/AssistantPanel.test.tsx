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
  vi.unstubAllGlobals();
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

  it("first run presents BOTH backends, local disabled without WebGPU", () => {
    // No persisted config + no WebGPU ⇒ first-run chooser with local disabled.
    render(<AssistantPanel api={fakeApi()} />);
    expect(screen.getByRole("heading", { name: "Local (in-browser)" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Bring your own hosted key" })).toBeTruthy();
    expect((screen.getByRole("button", { name: "Use local" }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    expect(
      (screen.getByRole("button", { name: "Use hosted key" }) as HTMLButtonElement).disabled,
    ).toBe(false);
    // The chat input is NOT shown until a backend is chosen.
    expect(screen.queryByLabelText("Message")).toBeNull();
  });

  it("picking hosted shows the key/endpoint form without starting a download", () => {
    render(<AssistantPanel api={fakeApi()} />);
    fireEvent.click(screen.getByRole("button", { name: "Use hosted key" }));
    expect(screen.getByLabelText("Endpoint")).toBeTruthy();
    expect(screen.getByLabelText("API key")).toBeTruthy();
    expect(screen.getByLabelText("Hosted model")).toBeTruthy();
    // No download consent dialog is triggered by choosing hosted.
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("picking local routes to the model dropdown / download gate", () => {
    // Present WebGPU so the local option is selectable.
    vi.stubGlobal("navigator", { gpu: {} });
    render(<AssistantPanel api={fakeApi()} />);
    const useLocal = screen.getByRole("button", { name: "Use local" }) as HTMLButtonElement;
    expect(useLocal.disabled).toBe(false);
    fireEvent.click(useLocal);
    // The per-backend local config (model dropdown + explicit commit) is shown;
    // nothing downloads until the user commits and sends.
    expect(screen.getByLabelText("Local model")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Use this model locally" })).toBeTruthy();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("skips the chooser when a backend is already selected", () => {
    render(<AssistantPanel api={fakeApi()} backend={HOSTED} />);
    expect(screen.getByLabelText("Message")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Use hosted key" })).toBeNull();
  });
});
