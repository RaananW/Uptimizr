import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react";
import { getAgentSkill } from "@uptimizr/agent-core";
import type { LlmProvider, ProviderResponse } from "@uptimizr/agent-core";
import type { CollectorApi } from "../../api";
import { AssistantPanel } from "../AssistantPanel";

let nextProvider: LlmProvider;

vi.mock("@uptimizr/agent-core/providers/hosted", async (importActual) => ({
  ...(await importActual<Record<string, unknown>>()),
  createHostedProvider: () => nextProvider,
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

  it("sends a guided example prompt when its button is clicked", async () => {
    nextProvider = scriptedProvider([{ kind: "final", content: "Your top mesh is Box." }]);
    render(<AssistantPanel api={fakeApi()} backend={HOSTED} />);

    // The empty state offers labelled example-question buttons; clicking one
    // sends it verbatim (single-tool questions that answer quickly).
    const example = screen.getByRole("button", { name: "What are my top meshes this week?" });
    fireEvent.click(example);

    await waitFor(() => expect(screen.getByText("Your top mesh is Box.")).toBeTruthy());
    // The clicked question is surfaced as the user's turn.
    expect(screen.getByText("What are my top meshes this week?")).toBeTruthy();
  });

  it("offers the packaged methodology skills as starter prompts (#316)", async () => {
    nextProvider = scriptedProvider([{ kind: "final", content: "Health score: 72." }]);
    render(<AssistantPanel api={fakeApi()} backend={HOSTED} />);

    // A skill chip is labelled by its title, not by the whole method — and
    // clicking it sends the rendered methodology as the user's turn.
    const skill = getAgentSkill("weekly_scene_health")!;
    fireEvent.click(screen.getByRole("button", { name: skill.title }));

    await waitFor(() => expect(screen.getByText("Health score: 72.")).toBeTruthy());
    // The user turn is the rendered method, so its opening sentence is on screen.
    const opening = skill.render().split("\n")[0]!;
    expect(screen.getByText(opening, { exact: false })).toBeTruthy();
  });

  it("omits a skill that cannot be rendered without a scene", () => {
    render(<AssistantPanel api={fakeApi()} backend={HOSTED} />);
    const scoped = getAgentSkill("attention_hotspots")!;
    expect(screen.queryByRole("button", { name: scoped.title })).toBeNull();
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

  it("renders a provider error's message", async () => {
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
    expect(screen.getByText(/connect a more capable model/i)).toBeTruthy();
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

  it("first run asks for a provider and nothing else (ADR 0053)", () => {
    // Even with WebGPU present there is no local option to pick.
    vi.stubGlobal("navigator", { gpu: {} });
    render(<AssistantPanel api={fakeApi()} />);
    expect(screen.getByLabelText("Endpoint")).toBeTruthy();
    expect(screen.getByLabelText("API key")).toBeTruthy();
    expect(screen.getByLabelText("Hosted model")).toBeTruthy();
    expect(screen.getByText(/sent to that provider/i)).toBeTruthy();
    expect(screen.queryByText(/WebLLM|in-browser|Use local/i)).toBeNull();
    expect(screen.queryByLabelText("Local model")).toBeNull();
    // The chat input is NOT shown until a provider is connected.
    expect(screen.queryByLabelText("Message")).toBeNull();
  });

  it("keeps Use this provider disabled until endpoint, key and model are set", () => {
    render(<AssistantPanel api={fakeApi()} />);
    const use = () =>
      screen.getByRole("button", { name: "Use this provider" }) as HTMLButtonElement;
    expect(use().disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("Endpoint"), { target: { value: "https://api.x/v1" } });
    fireEvent.change(screen.getByLabelText("API key"), { target: { value: "key" } });
    expect(use().disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("Hosted model"), { target: { value: "m" } });
    expect(use().disabled).toBe(false);
  });

  it("connecting a provider lands in chat with a Change provider control", () => {
    render(<AssistantPanel api={fakeApi()} />);
    fireEvent.change(screen.getByLabelText("Endpoint"), { target: { value: "https://api.x/v1" } });
    fireEvent.change(screen.getByLabelText("API key"), { target: { value: "key" } });
    fireEvent.change(screen.getByLabelText("Hosted model"), { target: { value: "m" } });
    fireEvent.click(screen.getByRole("button", { name: "Use this provider" }));
    expect(screen.getByLabelText("Message")).toBeTruthy();
    expect(screen.getByText(/sent to your own provider/i)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Change provider" })).toBeTruthy();
  });

  it("skips the provider form when a provider is already selected", () => {
    render(<AssistantPanel api={fakeApi()} backend={HOSTED} />);
    expect(screen.getByLabelText("Message")).toBeTruthy();
    expect(screen.queryByLabelText("Endpoint")).toBeNull();
  });

  it("Change provider prefills the current config and Back to chat returns unchanged", () => {
    render(<AssistantPanel api={fakeApi()} backend={HOSTED} />);
    fireEvent.click(screen.getByRole("button", { name: "Change provider" }));
    expect((screen.getByLabelText("Endpoint") as HTMLInputElement).value).toBe(
      "https://api.example/v1",
    );
    expect((screen.getByLabelText("API key") as HTMLInputElement).value).toBe("k");
    expect((screen.getByLabelText("Hosted model") as HTMLInputElement).value).toBe("m");
    fireEvent.click(screen.getByRole("button", { name: /Back to chat/i }));
    expect(screen.getByLabelText("Message")).toBeTruthy();
    expect(screen.getByText(/sent to your own provider/i)).toBeTruthy();
  });

  it("treats a deprecated local backend as unconfigured and asks for a provider", () => {
    render(<AssistantPanel api={fakeApi()} backend={LOCAL} />);
    expect(screen.getByLabelText("Endpoint")).toBeTruthy();
    expect(screen.queryByLabelText("Message")).toBeNull();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("does not restore a persisted local choice (ADR 0053)", () => {
    localStorage.setItem("uptimizr.assistant.backend", JSON.stringify(LOCAL));
    render(<AssistantPanel api={fakeApi()} />);
    expect(screen.getByLabelText("Endpoint")).toBeTruthy();
    expect(screen.queryByLabelText("Message")).toBeNull();
  });

  it("restores a persisted provider", () => {
    localStorage.setItem("uptimizr.assistant.backend", JSON.stringify(HOSTED));
    render(<AssistantPanel api={fakeApi()} />);
    expect(screen.getByLabelText("Message")).toBeTruthy();
  });
});
