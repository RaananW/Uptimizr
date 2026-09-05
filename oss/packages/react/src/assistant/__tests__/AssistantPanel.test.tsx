import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup, within } from "@testing-library/react";
import type { LlmProvider, ProviderResponse } from "@uptimizr/agent-core";
import type { CollectorApi } from "../../api";
import { AssistantPanel } from "../AssistantPanel";

let nextProvider: LlmProvider;
// The cache-clearing helper is mocked: the real one loads the WebLLM runtime
// and touches the browser Cache API, neither of which exists in happy-dom.
const clearCachedModelsMock = vi.fn(async (): Promise<string[]> => []);

vi.mock("@uptimizr/agent-core/providers/hosted", async (importActual) => ({
  ...(await importActual<Record<string, unknown>>()),
  createHostedProvider: () => nextProvider,
}));
vi.mock("@uptimizr/agent-core/providers/webllm", async (importActual) => ({
  ...(await importActual<Record<string, unknown>>()),
  createWebLlmProvider: () => nextProvider,
  clearCachedModels: () => clearCachedModelsMock(),
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
  clearCachedModelsMock.mockReset();
  clearCachedModelsMock.mockResolvedValue([]);
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

  it("sends a guided example prompt when its button is clicked", async () => {
    nextProvider = scriptedProvider([{ kind: "final", content: "Your top mesh is Box." }]);
    render(<AssistantPanel api={fakeApi()} backend={HOSTED} />);

    // The empty state offers labelled example-question buttons; clicking one
    // sends it verbatim (single-tool questions where small models are strongest).
    const example = screen.getByRole("button", { name: "What are my top meshes this week?" });
    fireEvent.click(example);

    await waitFor(() => expect(screen.getByText("Your top mesh is Box.")).toBeTruthy());
    // The clicked question is surfaced as the user's turn.
    expect(screen.getByText("What are my top meshes this week?")).toBeTruthy();
  });

  it("shows an honest local-only capability note for the local backend", () => {
    render(<AssistantPanel api={fakeApi()} backend={LOCAL} />);
    expect(screen.getByText(/quick, single-metric questions/i)).toBeTruthy();
  });

  it("omits the local capability note for a hosted backend", () => {
    render(<AssistantPanel api={fakeApi()} backend={HOSTED} />);
    expect(screen.queryByText(/quick, single-metric questions/i)).toBeNull();
  });

  it("shows a working/thinking indicator while generating with the model loaded", async () => {
    // Hold the turn open so status stays "thinking" with no running tool: the
    // panel must show an always-visible busy indicator, not just a disabled input.
    let resolveTurn!: (r: ProviderResponse) => void;
    nextProvider = {
      complete: vi.fn(() => new Promise<ProviderResponse>((resolve) => (resolveTurn = resolve))),
    };
    render(<AssistantPanel api={fakeApi()} backend={HOSTED} />);

    fireEvent.change(screen.getByLabelText("Message"), { target: { value: "how's perf?" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));

    // A live status region announces the assistant is working.
    await waitFor(() => expect(screen.getByRole("status").textContent).toMatch(/thinking/i));

    // Once the answer arrives the indicator clears and the reply renders.
    resolveTurn({ kind: "final", content: "Average 58 fps." });
    await waitFor(() => expect(screen.getByText("Average 58 fps.")).toBeTruthy());
    expect(screen.getByRole("status").textContent?.trim()).toBe("");
  });

  it("surfaces a no_answer info line when a turn ends without any text answer", async () => {
    // An empty final answer must not render nothing — the user is told the turn
    // finished without text (a distinct info line, not an error).
    nextProvider = scriptedProvider([{ kind: "final", content: "   " }]);
    render(<AssistantPanel api={fakeApi()} backend={HOSTED} />);

    fireEvent.change(screen.getByLabelText("Message"), { target: { value: "summarize" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));

    await waitFor(() => expect(screen.getByText(/finished without a text answer/i)).toBeTruthy());
    // It is informational, not an error alert.
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("shows distinct, actionable guidance for a browser-storage-quota error (not the raw message)", async () => {
    // The local backend throws WebLlmStorageError when the origin's Cache Storage
    // is full. The panel must explain it's a browser-storage limit with a remedy,
    // never the bare "Quota exceeded." (which reads like an API quota).
    const storageError = new Error(
      "Your browser is out of storage for the local model (each model needs ~4 GB of cache).",
    );
    storageError.name = "WebLlmStorageError";
    nextProvider = {
      complete: vi.fn(async () => {
        throw storageError;
      }),
    };
    render(<AssistantPanel api={fakeApi()} backend={HOSTED} />);

    fireEvent.change(screen.getByLabelText("Message"), { target: { value: "top meshes?" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toMatch(/out of storage for the local model/i);
    expect(alert.textContent).toMatch(/clear the cached models/i);
    // Offers concrete alternatives (smaller model / hosted backend).
    expect(alert.textContent).toMatch(/hosted backend/i);
    // And the one-click remedy lives right inside the alert (#216).
    expect(within(alert).getByRole("button", { name: "Clear cached models" })).toBeTruthy();
  });

  it("offers Clear cached models for the local backend and reports what was reclaimed (#216)", async () => {
    clearCachedModelsMock.mockResolvedValue([
      "Hermes-3-Llama-3.1-8B-q4f16_1-MLC",
      "Hermes-2-Pro-Mistral-7B-q4f16_1-MLC",
    ]);
    render(<AssistantPanel api={fakeApi()} backend={LOCAL} />);

    fireEvent.click(screen.getByRole("button", { name: "Clear cached models" }));

    await waitFor(() =>
      expect(screen.getByText(/Cleared 2 cached models/i).textContent).toMatch(
        /Hermes 3 \(Llama 3\.1 8B\), Hermes 2 Pro \(Mistral 7B\)/,
      ),
    );
    expect(clearCachedModelsMock).toHaveBeenCalledTimes(1);
  });

  it("says so when there was nothing cached to clear", async () => {
    clearCachedModelsMock.mockResolvedValue([]);
    render(<AssistantPanel api={fakeApi()} backend={LOCAL} />);

    fireEvent.click(screen.getByRole("button", { name: "Clear cached models" }));

    await waitFor(() => expect(screen.getByText(/No cached models to clear/i)).toBeTruthy());
  });

  it("surfaces a Cache API failure from Clear cached models as inline text (not a throw)", async () => {
    clearCachedModelsMock.mockRejectedValue(new Error("cache denied"));
    render(<AssistantPanel api={fakeApi()} backend={LOCAL} />);

    fireEvent.click(screen.getByRole("button", { name: "Clear cached models" }));

    await waitFor(() =>
      expect(screen.getByText(/Could not clear cached models: cache denied/i)).toBeTruthy(),
    );
  });

  it("does not show the cache controls for a hosted backend", () => {
    render(<AssistantPanel api={fakeApi()} backend={HOSTED} />);
    expect(screen.queryByRole("button", { name: "Clear cached models" })).toBeNull();
  });

  it("renders a generic error's message for non-storage failures", async () => {
    nextProvider = {
      complete: vi.fn(async () => {
        throw new Error("Provider returned 500");
      }),
    };
    render(<AssistantPanel api={fakeApi()} backend={HOSTED} />);

    fireEvent.change(screen.getByLabelText("Message"), { target: { value: "hi" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toMatch(/Provider returned 500/);
    expect(alert.textContent).not.toMatch(/out of storage/i);
  });

  it("explains a stopped-on-max-steps give-up with the step count (not an error)", async () => {
    // A provider that only ever tool-calls drives the loop to its cap; the panel
    // must explain that outcome (with N) instead of silence, and offer a next step.
    nextProvider = {
      complete: vi.fn(async () => ({
        kind: "tool_calls",
        toolCalls: [{ id: "t", name: "list_sessions", arguments: {} }],
      })),
    };
    render(<AssistantPanel api={fakeApi()} backend={HOSTED} maxSteps={3} />);

    fireEvent.change(screen.getByLabelText("Message"), { target: { value: "keep going" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));

    await waitFor(() => expect(screen.getByText(/stopped after 3 steps/i)).toBeTruthy());
    expect(screen.getByText(/switch to a hosted model/i)).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("compacts a long run of the same tool into one counted row", async () => {
    // A small model often calls the same tool every step; the panel folds the
    // near-duplicate lines into a single `✓ top_meshes ×N` row instead of N rows.
    nextProvider = {
      complete: vi.fn(async () => ({
        kind: "tool_calls",
        toolCalls: [{ id: "t", name: "top_meshes", arguments: {} }],
      })),
    };
    render(<AssistantPanel api={fakeApi()} backend={HOSTED} maxSteps={4} />);

    fireEvent.change(screen.getByLabelText("Message"), { target: { value: "top meshes" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));

    const list = await screen.findByRole("list", { name: "Tool activity" });
    await waitFor(() => expect(list.querySelectorAll("li")).toHaveLength(1));
    const [row] = list.querySelectorAll("li");
    expect(row.textContent).toContain("top_meshes");
    // Folded into a single counted row (the exact N depends on the loop's forced
    // final pass; what matters is that N repeats collapse to one `×N` line).
    expect(row.textContent).toContain("×");
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
