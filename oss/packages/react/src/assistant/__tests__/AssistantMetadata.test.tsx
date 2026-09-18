import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react";
import type { LlmProvider, ProviderResponse } from "@uptimizr/agent-core";
import type { CollectorApi } from "../../api";
import { AssistantPanel, defaultAnalysisTitle } from "../AssistantPanel";

/**
 * "Annotate this" and "Save this analysis" (#310, ADR 0051 §5).
 *
 * The two things worth pinning: the actions appear **only** for a key that
 * holds `annotate`, and what they send is the answer the user is looking at
 * (plus the reads it came from), not a reconstruction.
 */

let nextProvider: LlmProvider;

vi.mock("@uptimizr/agent-core/providers/hosted", async (importActual) => ({
  ...(await importActual<Record<string, unknown>>()),
  createHostedProvider: () => nextProvider,
}));
vi.mock("@uptimizr/agent-core/providers/webllm", async (importActual) => ({
  ...(await importActual<Record<string, unknown>>()),
  createWebLlmProvider: () => nextProvider,
  clearCachedModels: async () => [],
}));

function scriptedProvider(steps: ProviderResponse[]): LlmProvider {
  let i = 0;
  return { complete: vi.fn(async () => steps[i++] ?? { kind: "final", content: "" }) };
}

interface Fakes {
  api: CollectorApi;
  createAnnotation: ReturnType<typeof vi.fn>;
  saveAnalysis: ReturnType<typeof vi.fn>;
  read: ReturnType<typeof vi.fn>;
}

function fakeApi(capabilities: string[]): Fakes {
  const createAnnotation = vi.fn(async (body: unknown) => ({ id: "an_1", ...(body as object) }));
  const saveAnalysis = vi.fn(async (body: unknown) => ({ id: "sa_1", ...(body as object) }));
  const read = vi.fn(async () => [{ sessions: 12 }]);
  return {
    createAnnotation,
    saveAnalysis,
    read,
    api: {
      read,
      whoami: vi.fn(async () => ({
        projectId: "p1",
        keyId: "k1",
        capabilities,
        label: null,
      })),
      createAnnotation,
      saveAnalysis,
    } as unknown as CollectorApi,
  };
}

const HOSTED = {
  backend: "hosted" as const,
  hosted: { api: "openai" as const, endpoint: "https://api.example/v1", apiKey: "k", model: "m" },
};

/** Ask a question and wait for the answer to land in the transcript. */
async function ask(question: string, answer: string): Promise<void> {
  fireEvent.change(screen.getByRole("textbox"), { target: { value: question } });
  fireEvent.click(screen.getByRole("button", { name: /^send$/i }));
  await waitFor(() => expect(screen.getByText(answer)).toBeTruthy());
}

beforeEach(() => {
  localStorage.clear();
  nextProvider = scriptedProvider([{ kind: "final", content: "You had 12 sessions." }]);
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("answer actions", () => {
  it("are hidden for a key without `annotate`", async () => {
    const { api } = fakeApi(["query"]);
    render(<AssistantPanel api={api} backend={HOSTED} />);
    await ask("How many sessions?", "You had 12 sessions.");
    expect(screen.queryByRole("button", { name: /annotate this/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /save this analysis/i })).toBeNull();
  });

  it("are hidden when the collector cannot answer whoami at all", async () => {
    const api = {
      read: vi.fn(async () => []),
      whoami: vi.fn(async () => {
        throw new Error("404");
      }),
    } as unknown as CollectorApi;
    render(<AssistantPanel api={api} backend={HOSTED} />);
    await ask("How many sessions?", "You had 12 sessions.");
    expect(screen.queryByRole("button", { name: /annotate this/i })).toBeNull();
  });

  it("appear for a key holding `annotate`", async () => {
    const { api } = fakeApi(["query", "annotate"]);
    render(<AssistantPanel api={api} backend={HOSTED} />);
    await ask("How many sessions?", "You had 12 sessions.");
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /annotate this/i })).toBeTruthy(),
    );
    expect(screen.getByRole("button", { name: /save this analysis/i })).toBeTruthy();
  });

  it("stores the answer text as a project annotation", async () => {
    const { api, createAnnotation } = fakeApi(["query", "annotate"]);
    render(<AssistantPanel api={api} backend={HOSTED} />);
    await ask("How many sessions?", "You had 12 sessions.");
    const button = await screen.findByRole("button", { name: /annotate this/i });
    fireEvent.click(button);
    await waitFor(() => expect(createAnnotation).toHaveBeenCalledTimes(1));
    expect(createAnnotation.mock.calls[0]![0]).toEqual({
      targetKind: "project",
      text: "You had 12 sessions.",
    });
    expect(screen.getByText(/saved as an annotation/i)).toBeTruthy();
  });

  it("pins the note to the target the dashboard passed", async () => {
    const { api, createAnnotation } = fakeApi(["query", "annotate"]);
    render(
      <AssistantPanel
        api={api}
        backend={HOSTED}
        annotationTarget={{ targetKind: "scene", targetId: "lobby", since: 1000, until: 2000 }}
      />,
    );
    await ask("How many sessions?", "You had 12 sessions.");
    fireEvent.click(await screen.findByRole("button", { name: /annotate this/i }));
    await waitFor(() => expect(createAnnotation).toHaveBeenCalledTimes(1));
    expect(createAnnotation.mock.calls[0]![0]).toEqual({
      targetKind: "scene",
      targetId: "lobby",
      since: 1000,
      until: 2000,
      text: "You had 12 sessions.",
    });
  });

  it("reports a refusal instead of failing silently", async () => {
    const { api, createAnnotation } = fakeApi(["query", "annotate"]);
    createAnnotation.mockRejectedValueOnce(new Error("api key not permitted to write metadata"));
    render(<AssistantPanel api={api} backend={HOSTED} />);
    await ask("How many sessions?", "You had 12 sessions.");
    fireEvent.click(await screen.findByRole("button", { name: /annotate this/i }));
    await waitFor(() => expect(screen.getByText(/could not annotate/i)).toBeTruthy());
  });

  it("saves the analysis with a title, the recorded reads and the answer", async () => {
    // A tool-calling turn, so there is a real read to record as the question.
    nextProvider = scriptedProvider([
      {
        kind: "tool_calls",
        toolCalls: [{ id: "c1", name: "list_sessions", arguments: { limit: 5 } }],
      },
      { kind: "final", content: "You had 12 sessions." },
    ]);
    const { api, saveAnalysis, read } = fakeApi(["query", "annotate"]);
    render(<AssistantPanel api={api} backend={HOSTED} />);
    await ask("How many sessions?", "You had 12 sessions.");
    expect(read).toHaveBeenCalled();

    fireEvent.click(await screen.findByRole("button", { name: /save this analysis/i }));
    const input = screen.getByLabelText(/analysis title/i);
    expect((input as HTMLInputElement).value).toBe("How many sessions?");
    fireEvent.change(input, { target: { value: "Weekly session count" } });
    fireEvent.click(screen.getByRole("button", { name: /^save$/i }));

    await waitFor(() => expect(saveAnalysis).toHaveBeenCalledTimes(1));
    const body = saveAnalysis.mock.calls[0]![0] as {
      title: string;
      query: { reads: { path: string }[] };
      conclusion: string;
    };
    expect(body.title).toBe("Weekly session count");
    expect(body.conclusion).toBe("You had 12 sessions.");
    expect(body.query.reads[0]!.path).toBe("api/v1/sessions");
    expect(screen.getByText(/analysis saved/i)).toBeTruthy();
  });

  it("closes the save form on cancel without writing anything", async () => {
    const { api, saveAnalysis } = fakeApi(["query", "annotate"]);
    render(<AssistantPanel api={api} backend={HOSTED} />);
    await ask("How many sessions?", "You had 12 sessions.");
    fireEvent.click(await screen.findByRole("button", { name: /save this analysis/i }));
    expect(screen.getByLabelText(/analysis title/i)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /^cancel$/i }));
    expect(screen.queryByLabelText(/analysis title/i)).toBeNull();
    expect(saveAnalysis).not.toHaveBeenCalled();
  });
});

describe("defaultAnalysisTitle", () => {
  it("uses the question that produced the answer", () => {
    const display = [
      { role: "user" as const, content: "How many sessions?" },
      { role: "assistant" as const, content: "12." },
    ];
    expect(defaultAnalysisTitle(display, 1)).toBe("How many sessions?");
  });

  it("trims an over-long question to the stored bound", () => {
    const display = [
      { role: "user" as const, content: "x".repeat(300) },
      { role: "assistant" as const, content: "12." },
    ];
    expect(defaultAnalysisTitle(display, 1)).toHaveLength(120);
  });

  it("falls back when there is no earlier question", () => {
    expect(defaultAnalysisTitle([{ role: "assistant", content: "12." }], 0)).toBe("Saved analysis");
  });
});
