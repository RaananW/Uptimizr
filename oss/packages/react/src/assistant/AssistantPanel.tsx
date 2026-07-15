"use client";

// <AssistantPanel> — a drop-in chat UI for the in-browser analytics assistant
// (ADR 0050 §2, ADR 0047). It is a thin shell over `useAssistant`: a message
// list, an input, a backend/model picker (local WebLLM vs bring-your-own hosted),
// the WebLLM download-consent + progress UI, and clear privacy messaging.
//
// It ships no model and no key. The LLM runtime is code-split and loaded lazily
// by `useAssistant`, so importing this component pulls no LLM code until a turn
// actually runs (@mlc-ai/web-llm stays an optional peer).

import { useCallback, useState, type FormEvent } from "react";
import type { AgentMessage } from "@uptimizr/agent-core";
import type {
  AssistantBackendConfig,
  CuratedModel,
  HostedApi,
} from "@uptimizr/agent-core/providers";
import { useAssistant, type UseAssistantOptions } from "./useAssistant";

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
    backend,
    webGpuAvailable,
    isBusy,
    isReady,
    send,
    cancel,
  } = assistant;

  const [draft, setDraft] = useState("");
  const [showSettings, setShowSettings] = useState(false);

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

  return (
    <div className={`flex flex-col gap-3 text-sm text-fg ${className ?? ""}`}>
      <header className="flex items-center justify-between gap-2">
        <h2 className="text-base font-medium text-fg-hi">{title}</h2>
        <button
          type="button"
          className="rounded-md border border-edge px-2 py-1 text-xs text-fg-muted hover:text-fg"
          onClick={() => setShowSettings((s) => !s)}
        >
          {showSettings ? "Hide settings" : "Backend"}
        </button>
      </header>

      {showSettings && (
        <BackendPicker
          backend={backend}
          webGpuAvailable={webGpuAvailable}
          models={assistant.models}
          onChange={assistant.setBackend}
        />
      )}

      <PrivacyNote backend={backend} />

      <ol className="flex min-h-[8rem] flex-col gap-2" aria-label="Conversation">
        {display.length === 0 && (
          <li className="text-xs text-fg-muted">
            Ask a question to get started — e.g. “What were the most-clicked meshes this week?”
          </li>
        )}
        {display.map((m, i) => (
          <li key={i} className={m.role === "user" ? "text-fg-hi" : "text-fg"} data-role={m.role}>
            <span className="mr-1 text-xs uppercase text-fg-muted">
              {m.role === "user" ? "You" : "Assistant"}
            </span>
            <div className="whitespace-pre-wrap">{m.content}</div>
          </li>
        ))}
      </ol>

      {toolActivity.length > 0 && (
        <ul className="flex flex-col gap-1 text-xs text-fg-muted" aria-label="Tool activity">
          {toolActivity.map((t, i) => (
            <li key={`${t.name}-${i}`} data-status={t.status}>
              {t.status === "running" ? "⏳" : t.status === "error" ? "⚠️" : "✓"} {t.name}
            </li>
          ))}
        </ul>
      )}

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
        <p className="rounded-md bg-rose-500/20 px-2 py-1 text-xs text-rose-300" role="alert">
          {error.message}
        </p>
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

      {!isReady && !backend && (
        <p className="text-xs text-fg-muted">
          Choose an LLM backend under <strong>Backend</strong> to begin.
        </p>
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

/** Local vs bring-your-own hosted backend selector with a model/key form. */
function BackendPicker({
  backend,
  webGpuAvailable,
  models,
  onChange,
}: {
  backend: AssistantBackendConfig | null;
  webGpuAvailable: boolean;
  models: readonly CuratedModel[];
  onChange: (config: AssistantBackendConfig) => void;
}) {
  const kind = backend?.backend ?? (webGpuAvailable ? "local" : "hosted");
  const [localModel, setLocalModel] = useState(backend?.webllm?.model ?? models[0]?.id ?? "");
  const [api, setApi] = useState<HostedApi>(backend?.hosted?.api ?? "openai");
  const [endpoint, setEndpoint] = useState(backend?.hosted?.endpoint ?? "");
  const [apiKey, setApiKey] = useState(backend?.hosted?.apiKey ?? "");
  const [hostedModel, setHostedModel] = useState(backend?.hosted?.model ?? "");

  const selectLocal = () => onChange({ backend: "local", webllm: { model: localModel } });
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
          onChange={selectLocal}
        />
        <span className={webGpuAvailable ? "text-fg" : "text-fg-muted"}>
          Local (WebLLM / WebGPU) — runs in your browser, zero egress
          {!webGpuAvailable && " (WebGPU unavailable)"}
        </span>
      </label>

      {kind === "local" && webGpuAvailable && (
        <label className="ml-6 flex items-center gap-2">
          <span className="text-fg-muted">Model</span>
          <select
            aria-label="Local model"
            value={localModel}
            className="rounded-sm border border-edge bg-ink/40 px-1 py-0.5 text-fg"
            onChange={(e) => {
              setLocalModel(e.target.value);
              onChange({ backend: "local", webllm: { model: e.target.value } });
            }}
          >
            {models.map((m) => (
              <option key={m.id} value={m.id}>
                {m.label} ({m.downloadSize})
              </option>
            ))}
          </select>
        </label>
      )}

      <label className="flex items-center gap-2">
        <input
          type="radio"
          name="assistant-backend"
          checked={kind === "hosted"}
          onChange={applyHosted}
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
