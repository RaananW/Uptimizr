/**
 * Rendering the collector's **project context document** for a system prompt
 * (ADR 0051 §5, design sketch §E.1).
 *
 * `GET /api/v1/context` answers, in one read, everything an agent would
 * otherwise guess about the project in front of it: the scene ids and their
 * named regions, the custom events the application emits and the props they
 * carry, which capture channels are off (and so which metrics will be
 * legitimately empty), whether raw session retention is enabled, and how fresh
 * the data is.
 *
 * The document is JSON and bounded, but it is still several kilobytes — too much
 * to paste into the system prompt of a 1–3 B local model, which has to carry ~69
 * tool schemas in the same budget. {@link renderContextForPrompt} turns it into a
 * compact, ordered block of prose-and-lists: a few hundred tokens that put the
 * *names* an agent needs in front of it, and say plainly which questions the data
 * cannot answer. Anything a model would only need after it has already decided
 * what to ask (per-channel volumes, the full metric list, the window bounds) is
 * left out — it can read the resource itself.
 *
 * Pure and dependency-free: a plain function from a structural view of the
 * document to a string. It is deliberately **tolerant** of a partial or
 * unfamiliar document — an older collector, a newer field, a proxy that trimmed
 * something — because degrading to a shorter block is always better than an
 * assistant that will not start.
 */

/** Hard cap on the rendered block, in characters (~1.5 k tokens). */
export const CONTEXT_PROMPT_MAX_CHARS = 6000;

/** Structural view of the parts of the context document the rendering uses. */
export interface PromptContextDocument {
  project?: { id?: string; store?: string; collectorVersion?: string } | null;
  dataQuality?: {
    lastEventAt?: number | null;
    sessions24h?: number;
    events24h?: number;
    retention?: { rawSessions?: boolean } | null;
  } | null;
  scenes?: readonly {
    id?: string;
    label?: string | null;
    regions?: readonly { id?: string; label?: string }[];
    proxy?: boolean;
  }[];
  vocabulary?: {
    customEvents?: readonly {
      name?: string;
      count28d?: number;
      props?: Record<string, string>;
    }[];
    meshes?: { count?: number; top?: readonly string[] } | null;
    inputActions?: readonly string[];
  } | null;
  definitions?: { glossary?: readonly { term?: string; meaning?: string }[] } | null;
  annotations?: { recent?: readonly { text?: string; at?: number }[] } | null;
  metrics?: { disabledByCapture?: readonly string[] } | null;
}

/** Join a list for prose, capping it and saying how many were left out. */
function capped(values: readonly string[], max: number): string {
  if (values.length <= max) return values.join(", ");
  return `${values.slice(0, max).join(", ")} (+${values.length - max} more)`;
}

/** `name(sku: string, qty: number)` — a custom event and what it carries. */
function renderCustomEvent(event: {
  name?: string;
  count28d?: number;
  props?: Record<string, string>;
}): string {
  const props = Object.entries(event.props ?? {})
    .slice(0, 8)
    .map(([key, type]) => `${key}: ${type}`)
    .join(", ");
  const count = typeof event.count28d === "number" ? ` ×${event.count28d}` : "";
  return `${event.name ?? "?"}${count}${props ? ` {${props}}` : ""}`;
}

/** `lobby "Main Lobby" [regions: counter, door]` — one scene line. */
function renderScene(scene: {
  id?: string;
  label?: string | null;
  regions?: readonly { id?: string; label?: string }[];
  proxy?: boolean;
}): string {
  const label = scene.label ? ` "${scene.label}"` : "";
  const regions = (scene.regions ?? []).map((region) => region.id).filter(Boolean) as string[];
  const regionPart = regions.length > 0 ? ` [regions: ${capped(regions, 8)}]` : "";
  return `- ${scene.id ?? "?"}${label}${regionPart}`;
}

/** How long ago, in whole units, for the freshness line. */
function ago(lastEventAt: number, nowMs: number): string {
  const minutes = Math.max(0, Math.round((nowMs - lastEventAt) / 60_000));
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} h ago`;
  return `${Math.round(hours / 24)} days ago`;
}

/**
 * Render a project context document as a compact system-prompt block.
 *
 * Returns `""` when there is nothing useful to say, so a caller can append the
 * result unconditionally. The output is truncated to
 * {@link CONTEXT_PROMPT_MAX_CHARS} on a line boundary, with a marker, so a
 * pathological project can never crowd out the tool schemas.
 *
 * @param context The document from `GET /api/v1/context` (any subset of it).
 * @param nowMs Current time, for the "last event" phrasing. Defaults to `Date.now()`.
 */
export function renderContextForPrompt(
  context: PromptContextDocument | null | undefined,
  nowMs: number = Date.now(),
): string {
  if (context == null || typeof context !== "object") return "";

  const lines: string[] = [];

  const scenes = (context.scenes ?? []).filter((scene) => typeof scene.id === "string");
  if (scenes.length > 0) {
    lines.push("Scenes (use these exact ids for the `scene` filter; region ids for `region`):");
    for (const scene of scenes.slice(0, 20)) lines.push(renderScene(scene));
    if (scenes.length > 20) lines.push(`- (+${scenes.length - 20} more scenes)`);
  }

  const customEvents = (context.vocabulary?.customEvents ?? []).filter(
    (event) => typeof event.name === "string",
  );
  if (customEvents.length > 0) {
    lines.push(
      "",
      "Custom events this app emits (name ×count {props}) — use these exact names:",
      ...customEvents.slice(0, 15).map((event) => `- ${renderCustomEvent(event)}`),
    );
    if (customEvents.length > 15) lines.push(`- (+${customEvents.length - 15} more)`);
  }

  const meshes = context.vocabulary?.meshes?.top ?? [];
  if (meshes.length > 0) lines.push("", `Most-interacted meshes: ${capped([...meshes], 10)}.`);

  const actions = context.vocabulary?.inputActions ?? [];
  if (actions.length > 0) lines.push(`Bound input actions: ${capped([...actions], 12)}.`);

  const glossary = (context.definitions?.glossary ?? []).filter((entry) => entry.term);
  if (glossary.length > 0) {
    lines.push(
      "",
      "Project glossary:",
      ...glossary.slice(0, 12).map((entry) => `- ${entry.term}: ${entry.meaning ?? ""}`),
    );
  }

  const annotations = (context.annotations?.recent ?? []).filter((entry) => entry.text);
  if (annotations.length > 0) {
    lines.push(
      "",
      "Recent annotations (project notes, newest first):",
      ...annotations.slice(0, 5).map((entry) => `- ${entry.text ?? ""}`),
    );
  }

  const disabled = context.metrics?.disabledByCapture ?? [];
  if (disabled.length > 0) {
    lines.push(
      "",
      `No data is captured for these metrics, so they WILL return empty — say the channel is off ` +
        `rather than reporting a zero: ${capped([...disabled], 20)}.`,
    );
  }

  const quality = context.dataQuality;
  if (quality != null) {
    const parts: string[] = [];
    if (typeof quality.lastEventAt === "number") {
      parts.push(`last event ${ago(quality.lastEventAt, nowMs)}`);
    } else if (quality.lastEventAt === null) {
      parts.push("no events recorded yet");
    }
    if (typeof quality.sessions24h === "number") {
      parts.push(`${quality.sessions24h} sessions in the last 24 h`);
    }
    if (parts.length > 0) lines.push("", `Data: ${parts.join(", ")}.`);
    if (quality.retention?.rawSessions === false) {
      lines.push(
        "Raw per-session retention is OFF: session timelines and replay are unavailable by design.",
      );
    }
  }

  if (lines.length === 0) return "";

  const header =
    "Project context (read from this collector; prefer these real names over any you infer):";
  const body = [header, "", ...lines].join("\n").trimEnd();
  if (body.length <= CONTEXT_PROMPT_MAX_CHARS) return body;

  const truncated = body.slice(0, CONTEXT_PROMPT_MAX_CHARS);
  const lastBreak = truncated.lastIndexOf("\n");
  return `${truncated.slice(0, lastBreak > 0 ? lastBreak : CONTEXT_PROMPT_MAX_CHARS)}\n… (context truncated)`;
}
