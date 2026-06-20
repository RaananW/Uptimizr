import type { PrepareProgress } from "../prepare.js";
import { DemoLimitations } from "./DemoLimitations.js";

interface WelcomeScreenProps {
  /** Idle until the visitor opts in; then a coarse progress phase; or an error. */
  state: "idle" | "preparing" | "error";
  /** The current preparation phase (only meaningful while `state === "preparing"`). */
  progress: PrepareProgress | null;
  /** Error message to surface when `state === "error"`. */
  error: string | null;
  /** Begin (or retry) preparation. */
  onPrepare: () => void;
}

const PHASE_LABEL: Record<PrepareProgress, string> = {
  registering: "Installing the in-browser collector…",
  caching: "Downloading the analytics engine (one time)…",
  warming: "Starting the in-browser database…",
  done: "Ready!",
};

/**
 * The landing screen. It explains that the whole demo runs in the browser, then
 * gates the heavy one-time asset download behind an explicit "Prepare demo"
 * click so nothing is fetched until the visitor opts in. After preparation the
 * demo works offline.
 */
export function WelcomeScreen({ state, progress, error, onPrepare }: WelcomeScreenProps) {
  const busy = state === "preparing";
  return (
    <div className="welcome">
      <div className="welcome__card">
        <h1 className="welcome__title">Uptimizr — Live Demo</h1>
        <p className="welcome__lede">
          This is the real Uptimizr, running <strong>entirely in your browser</strong>. Interact
          with the 3D scene on the left and watch the analytics dashboard on the right update live —
          view-direction and click heatmaps, mesh interactions, performance, and more.
        </p>
        <p className="welcome__lede">
          There is <strong>no backend and no database server</strong>. Every event is stored in an
          in-browser DuckDB database and queried locally. Nothing you do here leaves your device.
        </p>

        <div className="welcome__prepare">
          <button
            type="button"
            className="welcome__button"
            onClick={onPrepare}
            disabled={busy}
            aria-busy={busy}
          >
            {busy ? "Preparing…" : "Prepare demo"}
          </button>
          {busy && progress ? (
            <p className="welcome__progress" role="status">
              {PHASE_LABEL[progress]}
            </p>
          ) : null}
          {state === "error" && error ? (
            <p className="welcome__error" role="alert">
              Preparation failed: {error}. <button onClick={onPrepare}>Try again</button>
            </p>
          ) : null}
          {state === "idle" ? (
            <p className="welcome__hint">
              The first click downloads the analytics engine (~a few MB) once, then caches it for
              offline use.
            </p>
          ) : null}
        </div>

        <DemoLimitations />
      </div>
    </div>
  );
}
