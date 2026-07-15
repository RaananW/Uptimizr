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

const LOCAL = {
  backend: "local" as const,
  webllm: { model: "Llama-3.1-8B-Instruct-q4f32_1-MLC" },
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

  it("Change backend reveals the chooser cards, then the picker with both options", () => {
    render(<AssistantPanel api={fakeApi()} backend={HOSTED} />);
    fireEvent.click(screen.getByRole("button", { name: "Change backend" }));
    // The discoverable control returns the user to the selection CARDS, not the
    // raw radio form.
    expect(screen.getByRole("heading", { name: "Local (in-browser)" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Bring your own hosted key" })).toBeTruthy();
    // Picking a card routes into the per-backend picker.
    fireEvent.click(screen.getByRole("button", { name: "Use hosted key" }));
    expect(screen.getByText(/Local \(WebLLM/i)).toBeTruthy();
    expect(screen.getByText(/Bring your own hosted provider/i)).toBeTruthy();
    expect(screen.getByLabelText("Endpoint")).toBeTruthy();
    expect(screen.getByLabelText("API key")).toBeTruthy();
  });

  it("disables the local option when WebGPU is unavailable", () => {
    // happy-dom has no navigator.gpu, so the local card must be disabled.
    render(<AssistantPanel api={fakeApi()} backend={HOSTED} />);
    fireEvent.click(screen.getByRole("button", { name: "Change backend" }));
    expect((screen.getByRole("button", { name: "Use local" }) as HTMLButtonElement).disabled).toBe(
      true,
    );
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

  it("a committed backend lands in chat and exposes a Change backend control", () => {
    render(<AssistantPanel api={fakeApi()} backend={HOSTED} />);
    // Returning users go straight to chat, not the chooser.
    expect(screen.getByLabelText("Message")).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Local (in-browser)" })).toBeNull();
    // …but a discoverable affordance to change the backend is present.
    expect(screen.getByRole("button", { name: "Change backend" })).toBeTruthy();
  });

  it("Change backend shows both cards and Back to chat returns unchanged", () => {
    render(<AssistantPanel api={fakeApi()} backend={HOSTED} />);
    fireEvent.click(screen.getByRole("button", { name: "Change backend" }));
    expect(screen.getByRole("heading", { name: "Local (in-browser)" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Bring your own hosted key" })).toBeTruthy();
    // The escape hatch returns to chat with the existing backend untouched.
    fireEvent.click(screen.getByRole("button", { name: /Back to chat/i }));
    expect(screen.getByLabelText("Message")).toBeTruthy();
    expect(screen.getByText(/sent to your own provider/i)).toBeTruthy();
  });

  it("switches hosted → local from the chooser and returns to chat", () => {
    vi.stubGlobal("navigator", { gpu: {} });
    render(<AssistantPanel api={fakeApi()} backend={HOSTED} />);
    fireEvent.click(screen.getByRole("button", { name: "Change backend" }));
    const useLocal = screen.getByRole("button", { name: "Use local" }) as HTMLButtonElement;
    expect(useLocal.disabled).toBe(false);
    fireEvent.click(useLocal);
    fireEvent.click(screen.getByRole("button", { name: "Use this model locally" }));
    // Back in chat, now on the local (zero-egress) backend.
    expect(screen.getByLabelText("Message")).toBeTruthy();
    expect(screen.getByText(/Runs 100% in your browser/i)).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Local (in-browser)" })).toBeNull();
  });

  it("switches local → hosted from the chooser and returns to chat", () => {
    render(<AssistantPanel api={fakeApi()} backend={LOCAL} />);
    // A committed local backend still lands in chat.
    expect(screen.getByText(/Runs 100% in your browser/i)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Change backend" }));
    fireEvent.click(screen.getByRole("button", { name: "Use hosted key" }));
    fireEvent.change(screen.getByLabelText("Endpoint"), {
      target: { value: "https://api.other/v1" },
    });
    fireEvent.change(screen.getByLabelText("API key"), { target: { value: "key2" } });
    fireEvent.change(screen.getByLabelText("Hosted model"), { target: { value: "gpt-4o-mini" } });
    fireEvent.click(screen.getByRole("button", { name: "Use this provider" }));
    // Back in chat, now on the hosted backend.
    expect(screen.getByLabelText("Message")).toBeTruthy();
    expect(screen.getByText(/sent to your own provider/i)).toBeTruthy();
  });

  it("re-picking the same kind seeds the picker from the current config", () => {
    render(<AssistantPanel api={fakeApi()} backend={HOSTED} />);
    fireEvent.click(screen.getByRole("button", { name: "Change backend" }));
    fireEvent.click(screen.getByRole("button", { name: "Use hosted key" }));
    // The current hosted config prefills the picker so the user can just tweak it.
    expect((screen.getByLabelText("Endpoint") as HTMLInputElement).value).toBe(
      "https://api.example/v1",
    );
    expect((screen.getByLabelText("API key") as HTMLInputElement).value).toBe("k");
    expect((screen.getByLabelText("Hosted model") as HTMLInputElement).value).toBe("m");
  });
});
