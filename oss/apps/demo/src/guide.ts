/**
 * The demo guide's content and its per-visitor preference.
 *
 * The guide explains what the visitor is looking at in the split view, one
 * short step at a time. It is on by default and can be switched off (and back
 * on) from the top bar; that choice and the current step are remembered in this
 * browser only. Storage can be unavailable (private windows, blocked site data),
 * so every read and write is guarded and the guide falls back to its defaults.
 */

/** Which pane a step is about; that pane is outlined while the step shows. */
export type GuideTarget = "playground" | "dashboard" | "both";

export interface GuideStep {
  id: string;
  title: string;
  body: string;
  target: GuideTarget;
}

export const GUIDE_STEPS: readonly GuideStep[] = [
  {
    id: "overview",
    title: "What you're looking at",
    body:
      "On the left is a real 3D scene with an Uptimizr connector installed. On the right is the " +
      "real Uptimizr dashboard. There is no server in between: every event goes into a database " +
      "running in this tab, and the dashboard queries it.",
    target: "both",
  },
  {
    id: "interact",
    title: "Move around the scene",
    body:
      "Drag to orbit, scroll to zoom and click the objects. The connector records where the " +
      "camera looks, where the pointer goes and what you click. A drag counts as camera " +
      "navigation, not a click. The Events → DB counter above the scene goes up as each batch " +
      "is stored.",
    target: "playground",
  },
  {
    id: "engines",
    title: "Try another engine or scene",
    body:
      "Use the Scene and Engine menus above the scene to switch between Babylon.js, three.js, " +
      "PlayCanvas and the others. Every connector sends the same events. Switching clears the " +
      "collected data, so the dashboard only ever shows the scene in front of you.",
    target: "playground",
  },
  {
    id: "live",
    title: "Your visit, live",
    body:
      "The Live presence panel lists your session while it is active. The heatmaps and charts " +
      "below it catch up every few seconds as new events arrive.",
    target: "dashboard",
  },
  {
    id: "heatmaps",
    title: "Read the heatmaps",
    body:
      "The view-direction heatmap shows where the camera pointed. The pointer heatmap shows " +
      "where on screen you pointed and clicked. The 3D heatmaps place the same activity in the " +
      "scene itself. Scroll the dashboard to see every panel.",
    target: "dashboard",
  },
  {
    id: "session",
    title: "Open your session",
    body:
      "Click your session in Live presence. The replay redraws your camera path and clicks " +
      "from above, and the panels below narrow to that one session and keep updating while you " +
      "play. ← All sessions takes you back.",
    target: "dashboard",
  },
  {
    id: "assistant",
    title: "Ask the assistant",
    body:
      "On the overview, Ask the assistant answers questions about this data in plain language. " +
      "It reads the same numbers the panels show, and its setup explains exactly what it sends " +
      "and where.",
    target: "dashboard",
  },
  {
    id: "reset",
    title: "Start over any time",
    body:
      "Clear data empties the in-browser database. Close this guide whenever you like; the " +
      "Guide button in the top bar brings it back.",
    target: "both",
  },
];

/** Index of the step that explains the session view. */
export const SESSION_STEP = GUIDE_STEPS.findIndex((s) => s.id === "session");

const ENABLED_KEY = "uptimizr.demo.guide.enabled";
const STEP_KEY = "uptimizr.demo.guide.step";

/** Whether the guide is on. Defaults to on for a first visit. */
export function readGuideEnabled(): boolean {
  try {
    return localStorage.getItem(ENABLED_KEY) !== "false";
  } catch {
    return true;
  }
}

export function writeGuideEnabled(enabled: boolean): void {
  try {
    localStorage.setItem(ENABLED_KEY, String(enabled));
  } catch {
    /* storage unavailable: the choice lasts for this page only */
  }
}

/** The step to resume at, clamped to the current step list. */
export function readGuideStep(): number {
  try {
    const n = Number(localStorage.getItem(STEP_KEY));
    return Number.isInteger(n) && n >= 0 && n < GUIDE_STEPS.length ? n : 0;
  } catch {
    return 0;
  }
}

export function writeGuideStep(step: number): void {
  try {
    localStorage.setItem(STEP_KEY, String(step));
  } catch {
    /* storage unavailable */
  }
}

/**
 * Whether a dashboard pathname is the per-session drill-down
 * (`…/projects/:id/session/:sid`, under any base path).
 */
export function isSessionPath(pathname: string): boolean {
  return /\/projects\/[^/]+\/session\/[^/]+/.test(pathname);
}
