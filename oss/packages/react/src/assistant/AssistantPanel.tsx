"use client";

// <AssistantPanel> — a drop-in chat UI for the in-browser analytics assistant
// (ADR 0050 §2, ADR 0047). It is a thin shell over `useAssistant`: a message
// list, an input, a backend/model picker (local WebLLM vs bring-your-own hosted),
// the WebLLM download-consent + progress UI, and clear privacy messaging.
//
// It ships no model and no key. The LLM runtime is code-split and loaded lazily
// by `useAssistant`, so importing this component pulls no LLM code until a turn
// actually runs (@mlc-ai/web-llm stays an optional peer).

import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import type { AgentMessage } from "@uptimizr/agent-core";
import type {
  AssistantBackendConfig,
  BackendKind,
  CuratedModel,
  HostedApi,
} from "@uptimizr/agent-core/providers";
import {
  useAssistant,
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
}

/** Display-only view of a chat turn (system + tool turns are hidden). */
interface DisplayMessage {
  role: "user" | "assistant";
  content: string;
}

/**
 * Guided starter questions shown in the empty conversation. Each maps to a
 * SINGLE core tool, which is where small local models are strongest: clicking one
 * both boosts first-run success and demonstrates the agent working end to end.
 */
const EXAMPLE_PROMPTS: readonly string[] = [
  "What are my top meshes this week?",
  "How's my average FPS?",
  "Which scenes had activity today?",
  "How many events in the last 24 hours?",
  "How many sessions this week?",
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
 * A factual, non-fabricated explanation for a turn that produced no written
 * answer, plus a concrete next step. Never synthesizes an answer.
 */
function noticeMessage(notice: AssistantNotice): string {
  if (notice.kind === "stopped_on_max_steps") {
    return `The model kept using tools and didn't produce a written answer (stopped after ${notice.steps} steps). Try rephrasing, ask it to summarize the results, or switch to a hosted model for tougher questions.`;
  }
  return "The assistant finished without a text answer. Try rephrasing, or ask it to summarize the results.";
}

/**
 * Whether an error is the local-backend browser-storage-quota error thrown by
 * the WebLLM adapter ({@link WebLlmStorageError}). Matched by `name` (not the
 * message, and not a cross-realm `instanceof`) so it stays robust and regex-free.
 */
function isStorageError(error: Error): boolean {
  return error.name === "WebLlmStorageError";
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
 * single counted row. A small local model often calls the same tool many times
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
  ...options
}: AssistantPanelProps) {
  // A consent dialog drives WebLLM's download gate unless the caller supplied one.
  const [consent, setConsent] = useState<{
    model: CuratedModel;
    resolve: (ok: boolean) => void;
  } | null>(null);

  const dialogConfirm = useCallback(
    (model: CuratedModel) => new Promise<boolean>((resolve) => setConsent({ model, resolve })),
    [],
  );

  const assistant = useAssistant({
    ...options,
    confirmDownload: options.confirmDownload ?? dialogConfirm,
  });

  const {
    messages,
    status,
    error,
    toolActivity,
    initProgress,
    notice,
    backend,
    webGpuAvailable,
    isBusy,
    isReady,
    send,
    cancel,
    setBackend,
    models,
    clearCachedModels,
  } = assistant;

  const [draft, setDraft] = useState("");
  // The selection stage (chooser cards → per-backend picker) is shown on first
  // run and whenever the user explicitly re-opens it via "Change backend".
  const [reconfiguring, setReconfiguring] = useState(false);
  // Which backend the user picked in the chooser cards (null = show the cards).
  const [chooserKind, setChooserKind] = useState<BackendKind | null>(null);

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
  }, [messages, status, toolActivity, notice]);

  // An always-present busy indicator so the user can see the assistant is
  // working even when it is only generating an answer (no tool calls, model
  // already loaded) — WebLLM generation is non-streaming and can take a while.
  // The detailed tool-activity list is kept below; the initProgress bar already
  // covers the download phase, so the label defers to it when present.
  const hasRunningTool = toolActivity.some((t) => t.status === "running");
  const busyLabel =
    !isBusy || initProgress
      ? null
      : hasRunningTool
        ? "Running analytics…"
        : status === "initializing"
          ? "Loading model…"
          : "Thinking…";
  // The full selection stage is reachable at any time: on first run, or when the
  // user clicks "Change backend" (ADR 0050). Committing returns them to chat.
  const showSelection = firstRun || reconfiguring;

  const openSelection = useCallback(() => {
    setChooserKind(null);
    setReconfiguring(true);
  }, []);

  const cancelSelection = useCallback(() => {
    setChooserKind(null);
    setReconfiguring(false);
  }, []);

  // Commit a backend choice, then leave the selection stage and return to chat.
  const commitBackend = useCallback(
    (config: AssistantBackendConfig) => {
      setBackend(config);
      setChooserKind(null);
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
            Change backend
          </button>
        )}
      </header>

      {showSelection ? (
        chooserKind === null ? (
          <div className="flex flex-col gap-2">
            <BackendChooser webGpuAvailable={webGpuAvailable} onPick={setChooserKind} />
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
          <div className="flex flex-col gap-2">
            <button
              type="button"
              onClick={() => setChooserKind(null)}
              className="self-start text-xs text-fg-muted hover:text-fg"
            >
              ← Choose a different backend
            </button>
            <BackendPicker
              backend={backend}
              initialKind={chooserKind}
              webGpuAvailable={webGpuAvailable}
              models={models}
              onChange={commitBackend}
            />
          </div>
        )
      ) : (
        <>
          <PrivacyNote backend={backend} />

          <div className="flex max-h-[24rem] flex-col gap-2 overflow-y-auto">
            <ol className="flex min-h-[8rem] shrink-0 flex-col gap-2" aria-label="Conversation">
              {display.length === 0 && (
                <li className="flex flex-col gap-2 text-xs text-fg-muted">
                  <span>Ask a question to get started — or try one of these:</span>
                  <div className="flex flex-wrap gap-1.5" aria-label="Example questions">
                    {EXAMPLE_PROMPTS.map((q) => (
                      <button
                        key={q}
                        type="button"
                        disabled={isBusy || !isReady}
                        onClick={() => void send(q)}
                        className="rounded-full border border-edge px-2.5 py-1 text-left text-fg hover:bg-ink/40 disabled:opacity-50"
                      >
                        {q}
                      </button>
                    ))}
                  </div>
                  {backend?.backend === "local" && (
                    <p data-role="capability-note">
                      The local model answers quick, single-metric questions well. For deeper,
                      multi-step analysis, switch to a hosted backend with your own key via “Change
                      backend”.
                    </p>
                  )}
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
                </li>
              ))}
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

          {initProgress && (
            <div
              className="flex flex-col gap-1 text-xs text-fg-muted"
              aria-label="Model download progress"
            >
              <span>{initProgress.text}</span>
              <div className="h-1.5 w-full overflow-hidden rounded-full bg-ink/60">
                <div
                  className="h-full bg-emerald-400"
                  style={{ width: `${Math.round(initProgress.progress * 100)}%` }}
                />
              </div>
            </div>
          )}

          {status === "error" && error && (
            <div className="rounded-md bg-rose-500/20 px-2 py-1 text-xs text-rose-300" role="alert">
              {isStorageError(error) ? (
                <div className="flex flex-col gap-1" data-kind="storage">
                  <span className="font-medium">
                    Your browser is out of storage for the local model.
                  </span>
                  <span>
                    Each local model caches about 4 GB in this site&apos;s browser storage. To fix
                    it: clear the cached models below, free up disk space, or pick the smallest
                    model — or switch to a hosted backend. Then retry.
                  </span>
                  <ClearCachedModelsButton
                    clearCachedModels={clearCachedModels}
                    disabled={isBusy}
                    models={models}
                  />
                </div>
              ) : (
                <span>{error.message}</span>
              )}
            </div>
          )}

          {backend?.backend === "local" && (
            <div
              className="flex flex-wrap items-center gap-2 text-[11px] text-fg-muted"
              data-role="cache-controls"
            >
              <span>
                Model weights are cached in this browser (~4 GB each); switching models reclaims the
                previous one.
              </span>
              <ClearCachedModelsButton
                clearCachedModels={clearCachedModels}
                disabled={isBusy}
                models={models}
              />
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

      {consent && (
        <ConsentDialog
          model={consent.model}
          onDecision={(ok) => {
            consent.resolve(ok);
            setConsent(null);
          }}
        />
      )}
    </div>
  );
}

/**
 * First-run backend chooser (ADR 0050 §4, amended). Presents BOTH backends side
 * by side with honest tradeoffs — including the hosted data-egress caveat (§5) —
 * so a first-time user explicitly picks instead of being defaulted into a
 * multi-GB local download. Nothing loads until a choice is made.
 */
function BackendChooser({
  webGpuAvailable,
  onPick,
}: {
  webGpuAvailable: boolean;
  onPick: (kind: BackendKind) => void;
}) {
  return (
    <div className="flex flex-col gap-2">
      <p className="text-xs text-fg-muted">
        Choose how the assistant runs. Nothing is loaded or downloaded until you pick — your choice
        is remembered next time.
      </p>
      <div className="grid gap-2 sm:grid-cols-2">
        <div
          className={`flex flex-col gap-2 rounded-md border border-edge p-3 ${
            webGpuAvailable ? "" : "opacity-60"
          }`}
        >
          <div className="flex items-center gap-2">
            <h3 className="text-sm font-medium text-fg-hi">Local (in-browser)</h3>
            {webGpuAvailable && (
              <span className="rounded-full bg-emerald-500/20 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-emerald-300">
                Recommended
              </span>
            )}
          </div>
          <p className="text-xs text-fg-muted">
            Private — <strong>nothing leaves your device</strong>. Runs on your GPU. Requires a
            WebGPU browser with ~5&nbsp;GB free VRAM and a one-time ~4&nbsp;GB model download.
          </p>
          <button
            type="button"
            disabled={!webGpuAvailable}
            onClick={() => onPick("local")}
            className="mt-auto self-start rounded-md bg-emerald-500/70 px-3 py-1 text-xs text-fg-hi disabled:opacity-50"
          >
            Use local
          </button>
          {!webGpuAvailable && (
            <p className="text-[11px] text-fg-muted">Requires a WebGPU browser.</p>
          )}
        </div>

        <div className="flex flex-col gap-2 rounded-md border border-edge p-3">
          <h3 className="text-sm font-medium text-fg-hi">Bring your own hosted key</h3>
          <p className="text-xs text-fg-muted">
            Lightweight — no download. You supply an OpenAI-compatible or Anthropic endpoint + key.
            Your questions and aggregated analytics context are{" "}
            <strong>sent to that provider</strong> (never raw events or PII).
          </p>
          <button
            type="button"
            onClick={() => onPick("hosted")}
            className="mt-auto self-start rounded-md bg-emerald-500/70 px-3 py-1 text-xs text-fg-hi"
          >
            Use hosted key
          </button>
        </div>
      </div>
    </div>
  );
}

/** Local vs bring-your-own hosted backend selector with a model/key form. */
function BackendPicker({
  backend,
  webGpuAvailable,
  models,
  onChange,
  initialKind,
}: {
  backend: AssistantBackendConfig | null;
  webGpuAvailable: boolean;
  models: readonly CuratedModel[];
  onChange: (config: AssistantBackendConfig) => void;
  /** First-run seed for which backend to configure (when `backend` is null). */
  initialKind?: BackendKind;
}) {
  // A card the user just picked (`initialKind`) wins over the persisted backend's
  // kind, so switching local↔hosted from the chooser lands on the chosen kind.
  // When re-picking the SAME kind, the field seeds below prefill from `backend`.
  const [kind, setKind] = useState<BackendKind>(
    initialKind ?? backend?.backend ?? (webGpuAvailable ? "local" : "hosted"),
  );
  const [localModel, setLocalModel] = useState(backend?.webllm?.model ?? models[0]?.id ?? "");
  const [api, setApi] = useState<HostedApi>(backend?.hosted?.api ?? "openai");
  const [endpoint, setEndpoint] = useState(backend?.hosted?.endpoint ?? "");
  const [apiKey, setApiKey] = useState(backend?.hosted?.apiKey ?? "");
  const [hostedModel, setHostedModel] = useState(backend?.hosted?.model ?? "");

  const applyLocal = () => onChange({ backend: "local", webllm: { model: localModel } });
  const applyHosted = () =>
    onChange({ backend: "hosted", hosted: { api, endpoint, apiKey, model: hostedModel } });

  return (
    <fieldset className="flex flex-col gap-2 rounded-md border border-edge p-2 text-xs">
      <legend className="px-1 text-fg-muted">LLM backend</legend>

      <label className="flex items-center gap-2">
        <input
          type="radio"
          name="assistant-backend"
          checked={kind === "local"}
          disabled={!webGpuAvailable}
          onChange={() => setKind("local")}
        />
        <span className={webGpuAvailable ? "text-fg" : "text-fg-muted"}>
          Local (WebLLM / WebGPU) — runs in your browser, zero egress
          {!webGpuAvailable && " (WebGPU unavailable)"}
        </span>
      </label>

      {kind === "local" && webGpuAvailable && (
        <div className="ml-6 flex flex-col gap-1">
          <label className="flex items-center gap-2">
            <span className="text-fg-muted">Model</span>
            <select
              aria-label="Local model"
              value={localModel}
              className="rounded-sm border border-edge bg-ink/40 px-1 py-0.5 text-fg"
              onChange={(e) => setLocalModel(e.target.value)}
            >
              {models.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.label} ({m.downloadSize})
                </option>
              ))}
            </select>
          </label>
          <button
            type="button"
            onClick={applyLocal}
            disabled={!localModel}
            className="self-start rounded-md bg-emerald-500/70 px-2 py-0.5 text-fg-hi disabled:opacity-50"
          >
            Use this model locally
          </button>
        </div>
      )}

      <label className="flex items-center gap-2">
        <input
          type="radio"
          name="assistant-backend"
          checked={kind === "hosted"}
          onChange={() => setKind("hosted")}
        />
        <span className="text-fg">
          Bring your own hosted provider (OpenAI-compatible or Anthropic)
        </span>
      </label>

      {kind === "hosted" && (
        <div className="ml-6 flex flex-col gap-1">
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
            onClick={applyHosted}
            disabled={!endpoint || !apiKey || !hostedModel}
            className="self-start rounded-md bg-emerald-500/70 px-2 py-0.5 text-fg-hi disabled:opacity-50"
          >
            Use this provider
          </button>
        </div>
      )}
    </fieldset>
  );
}

/** Outcome of the last "Clear cached models" click, for the inline status text. */
type ClearCacheState =
  | { kind: "idle" }
  | { kind: "clearing" }
  | { kind: "cleared"; count: number }
  | { kind: "error"; message: string };

/** Friendly label for a curated model id (falls back to the raw id). */
function modelLabel(id: string, models: readonly CuratedModel[]): string {
  return models.find((m) => m.id === id)?.label ?? id;
}

/**
 * "Clear cached models" — deletes every curated local model's cached weights
 * from this browser's Cache Storage via the WebLLM adapter (#216), reclaiming
 * the multi-GB space without the user hunting for the browser's "clear site
 * data". Reports exactly what was reclaimed (or that nothing was cached) inline,
 * and surfaces a failure as text rather than throwing. Errors are shown by
 * `message` only — no parsing of their text.
 */
function ClearCachedModelsButton({
  clearCachedModels,
  disabled,
  models = [],
}: {
  clearCachedModels: () => Promise<string[]>;
  disabled?: boolean;
  models?: readonly CuratedModel[];
}) {
  const [state, setState] = useState<ClearCacheState>({ kind: "idle" });
  const [clearedIds, setClearedIds] = useState<string[]>([]);

  const onClick = useCallback(async () => {
    setState({ kind: "clearing" });
    try {
      const ids = await clearCachedModels();
      setClearedIds(ids);
      setState({ kind: "cleared", count: ids.length });
    } catch (err) {
      setState({
        kind: "error",
        message: err instanceof Error ? err.message : "Could not clear the cached models.",
      });
    }
  }, [clearCachedModels]);

  const statusText =
    state.kind === "clearing"
      ? "Clearing cached models…"
      : state.kind === "cleared"
        ? state.count === 0
          ? "No cached models to clear."
          : `Cleared ${state.count} cached model${state.count === 1 ? "" : "s"} (${clearedIds
              .map((id) => modelLabel(id, models))
              .join(", ")}).`
        : state.kind === "error"
          ? `Could not clear cached models: ${state.message}`
          : null;

  return (
    <span className="inline-flex flex-wrap items-center gap-2">
      <button
        type="button"
        onClick={() => void onClick()}
        disabled={disabled || state.kind === "clearing"}
        className="rounded-md border border-edge px-2 py-0.5 text-[11px] text-fg-muted hover:text-fg disabled:opacity-50"
      >
        Clear cached models
      </button>
      {statusText && (
        <span role="status" data-role="cache-status" data-kind={state.kind}>
          {statusText}
        </span>
      )}
    </span>
  );
}

/** Short, backend-aware privacy statement (ADR 0050 §5). */
function PrivacyNote({ backend }: { backend: AssistantBackendConfig | null }) {
  const text =
    backend?.backend === "hosted"
      ? "Your prompt and aggregated results are sent to your own provider — never raw events or PII."
      : "Runs 100% in your browser. Nothing — not your prompt nor your data — leaves this device.";
  return <p className="text-xs text-fg-muted">{text}</p>;
}

/** WebLLM download-consent modal shown before any weights are fetched. */
function ConsentDialog({
  model,
  onDecision,
}: {
  model: CuratedModel;
  onDecision: (ok: boolean) => void;
}) {
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Download model"
      className="flex flex-col gap-2 rounded-md border border-edge bg-surface p-3 text-xs"
    >
      <p className="text-fg">
        Download <strong>{model.label}</strong> ({model.downloadSize}, needs ~{model.vram} VRAM)? It
        runs 100% locally in your browser and nothing leaves this device.
      </p>
      <p className="text-fg-muted">{model.description}</p>
      <div className="flex gap-2">
        <button
          type="button"
          onClick={() => onDecision(true)}
          className="rounded-md bg-emerald-500/70 px-3 py-1 text-fg-hi"
        >
          Download &amp; run locally
        </button>
        <button
          type="button"
          onClick={() => onDecision(false)}
          className="rounded-md border border-edge px-3 py-1 text-fg-muted hover:text-fg"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}
