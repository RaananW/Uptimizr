"use client";

// <AssistantPanel> — a drop-in chat UI for the in-browser analytics assistant
// (ADR 0050 §2, ADR 0047, ADR 0053). It is a thin shell over `useAssistant`: a
// message list, an input, a form to connect the user's own model provider (an
// OpenAI-compatible or Anthropic endpoint and API key), and clear privacy
// messaging.
//
// It ships no model and no key. The provider adapter is code-split and loaded
// lazily by `useAssistant`, so importing this component pulls no provider code
// until a turn actually runs. The local WebLLM backend is no longer offered here
// (ADR 0053): small in-browser models could not drive the tool catalog reliably.

import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { AGENT_SKILLS, type AgentMessage } from "@uptimizr/agent-core";
import type { AssistantBackendConfig, HostedApi } from "@uptimizr/agent-core/providers";
import {
  useAssistant,
  type AssistantAnnotationTarget,
  type AssistantNotice,
  type AssistantToolActivity,
  type ToolCallStatus,
  type UseAssistantOptions,
} from "./useAssistant";

/** Props for {@link AssistantPanel}. Extends every {@link useAssistant} option. */
export interface AssistantPanelProps extends UseAssistantOptions {
  /** Panel heading. Defaults to "Analytics assistant". */
  title?: string;
  /** Input placeholder text. */
  placeholder?: string;
  /** Extra classes on the root element. */
  className?: string;
  /**
   * Where "Annotate this" should pin the note (#310). A dashboard passes its
   * active filters — the scene being looked at, the range being shown — so the
   * note lands on what the answer is actually about. Defaults to a note about
   * the whole project.
   */
  annotationTarget?: AssistantAnnotationTarget;
  /**
   * Called after "Pin as panel" stores a spec (#315), so a host that renders the
   * pinned panels can refresh its grid without waiting for a reload. Optional:
   * an embed with no panel grid simply omits it.
   */
  onPinned?: () => void;
}

/** Display-only view of a chat turn (system + tool turns are hidden). */
interface DisplayMessage {
  role: "user" | "assistant";
  content: string;
}

/** One chip in the empty conversation: what it says, and what it sends. */
interface StarterPrompt {
  /** Chip text. */
  label: string;
  /** The turn sent when it is clicked. */
  text: string;
  /** Hover text, when the chip's label is shorter than what it does. */
  title?: string;
}

/**
 * Guided starter questions shown in the empty conversation.
 *
 * The first five each map to a SINGLE core tool: a quick, reliable first answer
 * that demonstrates the agent working end to end.
 *
 * After them come the **packaged methodology skills** (ADR 0051 §7) — the same
 * investigations `@uptimizr/mcp` offers as prompt templates and
 * `uptimizr agent report --skill` runs on a schedule. They send a whole method
 * rather than a question, so they are labelled by title. Only the skills that need no argument are offered: one that requires
 * a scene cannot be rendered from a chip that does not know which scene.
 */
const EXAMPLE_PROMPTS: readonly StarterPrompt[] = [
  ...[
    "What are my top meshes this week?",
    "How's my average FPS?",
    "Which scenes had activity today?",
    "How many events in the last 24 hours?",
    "How many sessions this week?",
  ].map((text) => ({ label: text, text })),
  ...AGENT_SKILLS.filter((skill) => skill.args.every((arg) => !arg.required)).map((skill) => ({
    label: skill.title,
    text: skill.render(),
    title: skill.description,
  })),
];

function toDisplayMessages(messages: AgentMessage[]): DisplayMessage[] {
  const out: DisplayMessage[] = [];
  for (const m of messages) {
    if (m.role === "user") out.push({ role: "user", content: m.content });
    else if (m.role === "assistant" && m.content.trim()) {
      out.push({ role: "assistant", content: m.content });
    }
  }
  return out;
}

/**
 * A starting title for "Save this analysis" (#310): the question that produced
 * the answer, trimmed to the stored title bound. The user can rewrite it — this
 * only saves them typing the obvious thing.
 */
export function defaultAnalysisTitle(
  display: readonly DisplayMessage[],
  answerIndex: number,
): string {
  for (let i = answerIndex - 1; i >= 0; i -= 1) {
    const message = display[i];
    if (message?.role === "user" && message.content.trim()) {
      const title = message.content.trim();
      return title.length > 120 ? `${title.slice(0, 117)}...` : title;
    }
  }
  return "Saved analysis";
}

/**
 * A factual, non-fabricated explanation for a turn that produced no written
 * answer, plus a concrete next step. Never synthesizes an answer.
 */
function noticeMessage(notice: AssistantNotice): string {
  if (notice.kind === "stopped_on_max_steps") {
    return `The model kept using tools and didn't produce a written answer (stopped after ${notice.steps} steps). Try rephrasing, ask it to summarize the results, or connect a more capable model via “Change provider”.`;
  }
  return "The assistant finished without a text answer. Try rephrasing, or ask it to summarize the results.";
}

/** One compacted run of consecutive same-name, same-status tool calls. */
export interface CompactToolActivity {
  /** Catalog tool name (e.g. `top_meshes`). */
  name: string;
  /** Shared status of the folded run. */
  status: ToolCallStatus;
  /** How many consecutive identical entries this row represents (≥ 1). */
  count: number;
}

/**
 * Fold consecutive tool entries that share the same `name` and `status` into a
 * single counted row. A model often calls the same tool many times
 * in one turn (e.g. `top_meshes` ×12), so the raw list is long and near-duplicate;
 * this keeps it readable without changing meaning or reordering. Non-adjacent or
 * differing entries stay separate. Pure and regex-free (plain scan).
 */
export function compactToolActivity(
  entries: readonly AssistantToolActivity[],
): CompactToolActivity[] {
  const out: CompactToolActivity[] = [];
  for (const entry of entries) {
    const last = out[out.length - 1];
    if (last && last.name === entry.name && last.status === entry.status) {
      last.count += 1;
    } else {
      out.push({ name: entry.name, status: entry.status, count: 1 });
    }
  }
  return out;
}

export function AssistantPanel({
  title = "Analytics assistant",
  placeholder = "Ask about your 3D analytics…",
  className,
  annotationTarget,
  onPinned,
  ...options
}: AssistantPanelProps) {
  const assistant = useAssistant(options);

  const {
    messages,
    status,
    error,
    toolActivity,
    partialText,
    notice,
    backend: selected,
    isBusy,
    isReady,
    send,
    cancel,
    setBackend,
    canAnnotate,
    annotate,
    saveAnalysis,
    pinnableQuery,
    pinPanel,
  } = assistant;

  const [draft, setDraft] = useState("");
  // The provider form is shown on first run and whenever the user re-opens it
  // via "Change provider".
  const [reconfiguring, setReconfiguring] = useState(false);
  // This panel connects a provider by API key only (ADR 0053). A local (WebLLM)
  // selection handed in by a host is deprecated and treated as unconfigured, so
  // the user is asked for a provider instead of the panel starting a download.
  const backend = selected?.backend === "hosted" ? selected : null;

  const onSubmit = useCallback(
    (e: FormEvent) => {
      e.preventDefault();
      const text = draft;
      if (!text.trim() || isBusy) return;
      setDraft("");
      void send(text);
    },
    [draft, isBusy, send],
  );

  const display = toDisplayMessages(messages);
  const firstRun = backend === null;

  // --- Leave something behind (#310, ADR 0051 §5) --------------------------
  //
  // Two actions under each answer: store it as a project note, or save the turn
  // as a titled analysis. Both write **metadata only** — nothing here touches an
  // event — and both are hidden unless the key holds `annotate`.
  /** Which answer's "save" form is open, or `null`. */
  const [savingIndex, setSavingIndex] = useState<number | null>(null);
  const [saveTitle, setSaveTitle] = useState("");
  /** The in-flight metadata write, so the buttons cannot be double-fired. */
  const [pendingAction, setPendingAction] = useState<"annotate" | "save" | "pin" | null>(null);
  /** Which answer's "pin as panel" form is open, or `null` (#315). */
  const [pinningIndex, setPinningIndex] = useState<number | null>(null);
  const [pinTitle, setPinTitle] = useState("");
  /** One line of feedback under the actions: what happened, or what failed. */
  const [actionMessage, setActionMessage] = useState<string | null>(null);

  const onAnnotate = useCallback(
    async (text: string) => {
      setPendingAction("annotate");
      setActionMessage(null);
      try {
        await annotate(text, annotationTarget);
        setActionMessage("Saved as an annotation.");
      } catch (err) {
        setActionMessage(
          err instanceof Error ? `Could not annotate: ${err.message}` : "Could not annotate.",
        );
      } finally {
        setPendingAction(null);
      }
    },
    [annotate, annotationTarget],
  );

  const onSaveAnalysis = useCallback(
    async (conclusion: string) => {
      setPendingAction("save");
      setActionMessage(null);
      try {
        await saveAnalysis(saveTitle.trim(), conclusion);
        setSavingIndex(null);
        setActionMessage("Analysis saved.");
      } catch (err) {
        setActionMessage(
          err instanceof Error ? `Could not save: ${err.message}` : "Could not save the analysis.",
        );
      } finally {
        setPendingAction(null);
      }
    },
    [saveAnalysis, saveTitle],
  );

  /**
   * "Pin as panel" (#315): keep the question, not a screenshot of the answer.
   *
   * The answer text becomes the panel's note — it is the agent's reading, which
   * is the part a person still wants a week later — and the query is pinned
   * with `range: "inherit"`, so the panel follows the dashboard's filter bar
   * instead of freezing the window the question happened to be asked in.
   */
  const onPinPanel = useCallback(
    async (note: string) => {
      setPendingAction("pin");
      setActionMessage(null);
      try {
        await pinPanel(pinTitle.trim(), note);
        setPinningIndex(null);
        setActionMessage("Pinned to the dashboard.");
        onPinned?.();
      } catch (err) {
        setActionMessage(
          err instanceof Error ? `Could not pin: ${err.message}` : "Could not pin the panel.",
        );
      } finally {
        setPendingAction(null);
      }
    },
    [pinPanel, pinTitle, onPinned],
  );

  // Autoscroll the conversation to the newest message/indicator whenever the
  // transcript or in-flight status changes, so a freshly appended answer (or the
  // busy indicator) is never left below the fold in a fixed-height drawer.
  const bottomRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const node = bottomRef.current;
    // Guarded: happy-dom (component tests) has no scrollIntoView.
    if (node && typeof node.scrollIntoView === "function") {
      node.scrollIntoView({ block: "end" });
    }
  }, [messages, status, toolActivity, notice, partialText]);

  // An always-present busy indicator so the user can see the assistant is
  // working even when it is only generating an answer (no tool calls, model
  // already loaded). Once the answer starts streaming the same indicator turns
  // into the "Streaming…" affordance while the live text renders in the
  // conversation. The detailed tool-activity list is kept below.
  const hasRunningTool = toolActivity.some((t) => t.status === "running");
  const streaming = isBusy && partialText !== null;
  const busyLabel = !isBusy
    ? null
    : hasRunningTool
      ? "Running analytics…"
      : streaming
        ? "Streaming…"
        : "Thinking…";
  // The provider form is reachable at any time: on first run, or when the user
  // clicks "Change provider". Committing returns them to chat.
  const showSelection = firstRun || reconfiguring;

  const openSelection = useCallback(() => setReconfiguring(true), []);
  const cancelSelection = useCallback(() => setReconfiguring(false), []);

  // Commit a provider, then leave the form and return to chat.
  const commitBackend = useCallback(
    (config: AssistantBackendConfig) => {
      setBackend(config);
      setReconfiguring(false);
    },
    [setBackend],
  );

  return (
    <div className={`flex flex-col gap-3 text-sm text-fg ${className ?? ""}`}>
      <header className="flex items-center justify-between gap-2">
        <h2 className="text-base font-medium text-fg-hi">{title}</h2>
        {!showSelection && (
          <button
            type="button"
            className="rounded-md border border-edge px-2 py-1 text-xs text-fg-muted hover:text-fg"
            onClick={openSelection}
          >
            Change provider
          </button>
        )}
      </header>

      {showSelection ? (
        <div className="flex flex-col gap-2">
          <ProviderForm backend={backend} onChange={commitBackend} />
          {!firstRun && (
            <button
              type="button"
              onClick={cancelSelection}
              className="self-start text-xs text-fg-muted hover:text-fg"
            >
              ← Back to chat
            </button>
          )}
        </div>
      ) : (
        <>
          <PrivacyNote />

          <div className="flex max-h-[24rem] flex-col gap-2 overflow-y-auto">
            <ol className="flex min-h-[8rem] shrink-0 flex-col gap-2" aria-label="Conversation">
              {display.length === 0 && (
                <li className="flex flex-col gap-2 text-xs text-fg-muted">
                  <span>Ask a question to get started — or try one of these:</span>
                  <div className="flex flex-wrap gap-1.5" aria-label="Example questions">
                    {EXAMPLE_PROMPTS.map((prompt) => (
                      <button
                        key={prompt.label}
                        type="button"
                        title={prompt.title}
                        disabled={isBusy || !isReady}
                        onClick={() => void send(prompt.text)}
                        className="rounded-full border border-edge px-2.5 py-1 text-left text-fg hover:bg-ink/40 disabled:opacity-50"
                      >
                        {prompt.label}
                      </button>
                    ))}
                  </div>
                </li>
              )}
              {display.map((m, i) => (
                <li
                  key={i}
                  className={m.role === "user" ? "text-fg-hi" : "text-fg"}
                  data-role={m.role}
                >
                  <span className="mr-1 text-xs uppercase text-fg-muted">
                    {m.role === "user" ? "You" : "Assistant"}
                  </span>
                  <div className="whitespace-pre-wrap">{m.content}</div>
                  {/* Leave something behind (#310). Shown only for a key that
                      holds `annotate`, so the buttons are never offered for a
                      write that would be refused. */}
                  {m.role === "assistant" && canAnnotate && !isBusy && (
                    <div
                      className="mt-1 flex flex-wrap items-center gap-2 text-xs"
                      data-role="answer-actions"
                    >
                      <button
                        type="button"
                        data-action="annotate"
                        disabled={pendingAction !== null}
                        onClick={() => void onAnnotate(m.content)}
                        className="rounded-full border border-edge px-2 py-0.5 text-fg-muted hover:bg-ink/40 disabled:opacity-50"
                      >
                        Annotate this
                      </button>
                      <button
                        type="button"
                        data-action="save-analysis"
                        disabled={pendingAction !== null}
                        onClick={() => {
                          setSavingIndex(i);
                          setSaveTitle(defaultAnalysisTitle(display, i));
                        }}
                        className="rounded-full border border-edge px-2 py-0.5 text-fg-muted hover:bg-ink/40 disabled:opacity-50"
                      >
                        Save this analysis
                      </button>
                      {/* "Pin as panel" (#315) is offered only when the answer
                          actually came from a `query` call: that document is
                          what the panel re-runs, and a panel pinned from a
                          reconstructed question would be a different question.
                          It is DATA, not code — see `panelSpec.ts`. */}
                      {pinnableQuery != null && (
                        <button
                          type="button"
                          data-action="pin-panel"
                          disabled={pendingAction !== null}
                          onClick={() => {
                            setPinningIndex(i);
                            setPinTitle(defaultAnalysisTitle(display, i));
                          }}
                          className="rounded-full border border-edge px-2 py-0.5 text-fg-muted hover:bg-ink/40 disabled:opacity-50"
                        >
                          Pin as panel
                        </button>
                      )}
                    </div>
                  )}
                  {pinningIndex === i && (
                    <form
                      data-role="pin-panel-form"
                      className="mt-1 flex flex-wrap items-center gap-2 text-xs"
                      onSubmit={(e) => {
                        e.preventDefault();
                        // The answer becomes the panel's note: it is the
                        // agent's reading, and the part a person still wants a
                        // week later.
                        void onPinPanel(m.content);
                      }}
                    >
                      <label className="sr-only" htmlFor="uptimizr-panel-title">
                        Panel title
                      </label>
                      <input
                        id="uptimizr-panel-title"
                        value={pinTitle}
                        onChange={(e) => setPinTitle(e.target.value)}
                        placeholder="Title for this panel"
                        className="min-w-[12rem] flex-1 rounded border border-edge bg-transparent px-2 py-1 text-fg"
                      />
                      <button
                        type="submit"
                        disabled={!pinTitle.trim() || pendingAction !== null}
                        className="rounded-full border border-edge px-2 py-0.5 text-fg-muted hover:bg-ink/40 disabled:opacity-50"
                      >
                        Pin
                      </button>
                      <button
                        type="button"
                        onClick={() => setPinningIndex(null)}
                        className="rounded-full border border-edge px-2 py-0.5 text-fg-muted hover:bg-ink/40"
                      >
                        Cancel
                      </button>
                    </form>
                  )}
                  {savingIndex === i && (
                    <form
                      data-role="save-analysis-form"
                      className="mt-1 flex flex-wrap items-center gap-2 text-xs"
                      onSubmit={(e) => {
                        e.preventDefault();
                        void onSaveAnalysis(m.content);
                      }}
                    >
                      <label className="sr-only" htmlFor="uptimizr-analysis-title">
                        Analysis title
                      </label>
                      <input
                        id="uptimizr-analysis-title"
                        value={saveTitle}
                        onChange={(e) => setSaveTitle(e.target.value)}
                        placeholder="Title for this analysis"
                        className="min-w-[12rem] flex-1 rounded border border-edge bg-transparent px-2 py-1 text-fg"
                      />
                      <button
                        type="submit"
                        disabled={!saveTitle.trim() || pendingAction !== null}
                        className="rounded-full border border-edge px-2 py-0.5 text-fg-muted hover:bg-ink/40 disabled:opacity-50"
                      >
                        Save
                      </button>
                      <button
                        type="button"
                        onClick={() => setSavingIndex(null)}
                        className="rounded-full border border-edge px-2 py-0.5 text-fg-muted hover:bg-ink/40"
                      >
                        Cancel
                      </button>
                    </form>
                  )}
                </li>
              ))}
              {/* The answer as it streams in. Kept OUT of the aria-live status
                  region so screen readers are not read every token; the region
                  announces "Streaming…" instead and the finished answer lands in
                  the transcript. Replaced — never duplicated — by the final
                  assistant turn in the same render when the turn completes. */}
              {streaming && (
                <li className="text-fg" data-role="assistant" data-streaming="true">
                  <span className="mr-1 text-xs uppercase text-fg-muted">Assistant</span>
                  <div className="whitespace-pre-wrap">{partialText}</div>
                </li>
              )}
            </ol>

            {/* Live region: announced by screen readers and always in the DOM so
                inserted status text is picked up. Populated only while busy. */}
            <div role="status" aria-live="polite" className="shrink-0">
              {busyLabel && (
                <span className="flex items-center gap-2 text-xs text-fg-muted">
                  <span
                    aria-hidden="true"
                    className="h-3 w-3 animate-spin rounded-full border-2 border-fg-muted border-t-transparent"
                  />
                  {busyLabel}
                </span>
              )}
            </div>

            {actionMessage && (
              <p className="shrink-0 text-xs text-fg-muted" data-role="metadata-status">
                {actionMessage}
              </p>
            )}

            {toolActivity.length > 0 && (
              <ul
                className="flex shrink-0 flex-col gap-1 text-xs text-fg-muted"
                aria-label="Tool activity"
              >
                {compactToolActivity(toolActivity).map((t, i) => (
                  <li key={`${t.name}-${i}`} data-status={t.status} data-count={t.count}>
                    {t.status === "running" ? "⏳" : t.status === "error" ? "⚠️" : "✓"} {t.name}
                    {t.count > 1 ? ` ×${t.count}` : ""}
                  </li>
                ))}
              </ul>
            )}

            {notice && !isBusy && status !== "error" && (
              <p
                className="shrink-0 text-xs text-fg-muted"
                data-role="notice"
                data-kind={notice.kind}
              >
                {noticeMessage(notice)}
              </p>
            )}

            <div ref={bottomRef} aria-hidden="true" className="shrink-0" />
          </div>

          {status === "error" && error && (
            <div className="rounded-md bg-rose-500/20 px-2 py-1 text-xs text-rose-300" role="alert">
              <span>{error.message}</span>
            </div>
          )}

          <form onSubmit={onSubmit} className="flex items-center gap-2">
            <input
              type="text"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              placeholder={placeholder}
              disabled={isBusy}
              aria-label="Message"
              className="flex-1 rounded-md border border-edge bg-ink/40 px-2 py-1 text-fg placeholder:text-fg-muted"
            />
            {isBusy ? (
              <button
                type="button"
                onClick={cancel}
                className="rounded-md border border-edge px-3 py-1 text-xs text-fg-muted hover:text-fg"
              >
                Stop
              </button>
            ) : (
              <button
                type="submit"
                disabled={!draft.trim() || !isReady}
                className="rounded-md bg-emerald-500/70 px-3 py-1 text-xs text-fg-hi disabled:opacity-50"
              >
                Send
              </button>
            )}
          </form>
        </>
      )}
    </div>
  );
}

/**
 * Connect the user's own model provider (ADR 0050 §5, ADR 0053): which API it
 * speaks, its endpoint, an API key and a model. The key and endpoint stay in
 * this browser and are sent only to that provider. States the data-egress
 * caveat up front, before anything is sent.
 */
function ProviderForm({
  backend,
  onChange,
}: {
  backend: AssistantBackendConfig | null;
  onChange: (config: AssistantBackendConfig) => void;
}) {
  const [api, setApi] = useState<HostedApi>(backend?.hosted?.api ?? "openai");
  const [endpoint, setEndpoint] = useState(backend?.hosted?.endpoint ?? "");
  const [apiKey, setApiKey] = useState(backend?.hosted?.apiKey ?? "");
  const [hostedModel, setHostedModel] = useState(backend?.hosted?.model ?? "");

  const apply = () =>
    onChange({ backend: "hosted", hosted: { api, endpoint, apiKey, model: hostedModel } });

  return (
    <fieldset className="flex flex-col gap-2 rounded-md border border-edge p-3 text-xs">
      <legend className="px-1 text-fg-muted">Model provider</legend>
      <p className="text-fg-muted" data-role="provider-note">
        Connect an OpenAI-compatible or Anthropic endpoint with your own API key. Your questions and
        the aggregated results the assistant reads are <strong>sent to that provider</strong> (never
        raw events or PII). The key stays in this browser.
      </p>
      <label className="flex items-center gap-2">
        <span className="w-16 text-fg-muted">API</span>
        <select
          aria-label="Hosted API"
          value={api}
          className="rounded-sm border border-edge bg-ink/40 px-1 py-0.5 text-fg"
          onChange={(e) => setApi(e.target.value as HostedApi)}
        >
          <option value="openai">OpenAI-compatible</option>
          <option value="anthropic">Anthropic</option>
        </select>
      </label>
      <label className="flex items-center gap-2">
        <span className="w-16 text-fg-muted">Endpoint</span>
        <input
          type="url"
          aria-label="Endpoint"
          value={endpoint}
          placeholder="https://api.openai.com/v1"
          className="flex-1 rounded-sm border border-edge bg-ink/40 px-1 py-0.5 text-fg"
          onChange={(e) => setEndpoint(e.target.value)}
        />
      </label>
      <label className="flex items-center gap-2">
        <span className="w-16 text-fg-muted">API key</span>
        <input
          type="password"
          aria-label="API key"
          value={apiKey}
          className="flex-1 rounded-sm border border-edge bg-ink/40 px-1 py-0.5 text-fg"
          onChange={(e) => setApiKey(e.target.value)}
        />
      </label>
      <label className="flex items-center gap-2">
        <span className="w-16 text-fg-muted">Model</span>
        <input
          type="text"
          aria-label="Hosted model"
          value={hostedModel}
          placeholder="gpt-4o-mini"
          className="flex-1 rounded-sm border border-edge bg-ink/40 px-1 py-0.5 text-fg"
          onChange={(e) => setHostedModel(e.target.value)}
        />
      </label>
      <button
        type="button"
        onClick={apply}
        disabled={!endpoint || !apiKey || !hostedModel}
        className="self-start rounded-md bg-emerald-500/70 px-2 py-0.5 text-fg-hi disabled:opacity-50"
      >
        Use this provider
      </button>
    </fieldset>
  );
}

/** Short privacy statement (ADR 0050 §5). */
function PrivacyNote() {
  return (
    <p className="text-xs text-fg-muted">
      Your prompt and aggregated results are sent to your own provider — never raw events or PII.
    </p>
  );
}
