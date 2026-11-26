import { useCallback, useEffect, useRef, useState } from "react";
import { trackGuideToggled, trackReset, trackSceneChanged } from "../analytics.js";
import {
  GUIDE_STEPS,
  SESSION_STEP,
  isSessionPath,
  readGuideEnabled,
  readGuideStep,
  writeGuideEnabled,
  writeGuideStep,
} from "../guide.js";
import { DemoGuide } from "./DemoGuide.js";

/** How often the open guide checks whether the dashboard is in a session view (ms). */
const GUIDE_WATCH_MS = 1_000;

interface SplitViewProps {
  /** Clear all collected analytics and reload both panes. */
  onReset: () => Promise<void> | void;
}

/**
 * The live demo: the playground (left) drives events into the in-browser store;
 * the dashboard (right) reads them back through the service-worker collector
 * shim. Both are the *unmodified* apps, served same-origin from `public/` so the
 * dashboard's `/api/v1/*` calls are intercepted locally.
 */
export function SplitView({ onReset }: SplitViewProps) {
  // Bump to force-remount both iframes after a manual reset.
  const [nonce, setNonce] = useState(0);
  // Bumped independently when the playground switches scene/engine: only the
  // dashboard needs to remount (the playground already reloaded itself).
  const [dashboardNonce, setDashboardNonce] = useState(0);
  const [resetting, setResetting] = useState(false);
  // The last scene/engine the embedded playground announced. The demo runs a
  // single project, so when this changes the previously-collected data is stale
  // and mixed — clear it and reload the dashboard so the panels stay correct.
  const lastContextRef = useRef<string | null>(null);

  // The guide (see guide.ts): on by default, toggled from the top bar, and
  // remembered in this browser.
  const [guideOn, setGuideOn] = useState(readGuideEnabled);
  const [guideStep, setGuideStep] = useState(readGuideStep);
  const dashboardRef = useRef<HTMLIFrameElement>(null);

  const setGuide = useCallback((on: boolean) => {
    setGuideOn(on);
    writeGuideEnabled(on);
    trackGuideToggled(on);
  }, []);

  const goToStep = useCallback((step: number) => {
    const clamped = Math.max(0, Math.min(GUIDE_STEPS.length - 1, step));
    setGuideStep(clamped);
    writeGuideStep(clamped);
  }, []);

  // Reopening the guide after finishing it starts from the top.
  const toggleGuide = () => {
    if (!guideOn && guideStep === GUIDE_STEPS.length - 1) goToStep(0);
    setGuide(!guideOn);
  };

  // While the guide is open, follow the dashboard: when the visitor opens a
  // session, jump to the step that explains the session view (once per visit
  // to it, and never backwards). The dashboard is same-origin, so reading its
  // location is allowed; it routes with pushState, which fires no event the
  // parent can hear, hence the light poll.
  const wasInSessionRef = useRef(false);
  useEffect(() => {
    if (!guideOn) return;
    const timer = setInterval(() => {
      let path: string;
      try {
        path = dashboardRef.current?.contentWindow?.location.pathname ?? "";
      } catch {
        return;
      }
      const inSession = isSessionPath(path);
      if (inSession && !wasInSessionRef.current) {
        setGuideStep((step) => {
          if (step >= SESSION_STEP) return step;
          writeGuideStep(SESSION_STEP);
          return SESSION_STEP;
        });
      }
      wasInSessionRef.current = inSession;
    }, GUIDE_WATCH_MS);
    return () => clearInterval(timer);
  }, [guideOn]);

  const guideTarget = guideOn ? GUIDE_STEPS[guideStep]?.target : undefined;
  const paneClass = (pane: "playground" | "dashboard") =>
    guideTarget === pane || guideTarget === "both"
      ? "split__pane split__pane--guided"
      : "split__pane";

  useEffect(() => {
    function onMessage(e: MessageEvent) {
      if (e.origin !== window.location.origin) return;
      const data = e.data as { type?: string; sceneId?: string; engineId?: string } | null;
      if (!data || data.type !== "uptimizr:playground-context") return;
      const key = `${data.sceneId ?? ""}|${data.engineId ?? ""}`;
      const prev = lastContextRef.current;
      lastContextRef.current = key;
      if (prev === null || prev === key) return; // first announce, or unchanged
      trackSceneChanged(data.sceneId ?? "", data.engineId ?? "");
      void Promise.resolve(onReset()).then(() => setDashboardNonce((n) => n + 1));
    }
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [onReset]);

  async function handleReset() {
    setResetting(true);
    trackReset();
    try {
      await onReset();
      setNonce((n) => n + 1);
    } finally {
      setResetting(false);
    }
  }

  return (
    <div className="split">
      <header className="split__bar">
        <span className="split__brand">Uptimizr · Live Demo</span>
        <span className="split__note">Everything runs in your browser — nothing is uploaded.</span>
        <button
          type="button"
          className="split__guide"
          onClick={toggleGuide}
          aria-pressed={guideOn}
          title={guideOn ? "Hide the guide" : "Show the guide"}
        >
          Guide
        </button>
        <button
          type="button"
          className="split__reset"
          onClick={handleReset}
          disabled={resetting}
          aria-busy={resetting}
        >
          {resetting ? "Clearing…" : "Clear data"}
        </button>
      </header>
      <div className="split__panes">
        <section className={paneClass("playground")} aria-label="3D playground">
          <iframe
            key={`playground-${nonce}`}
            className="split__frame"
            src="/playground/index.html"
            title="Uptimizr playground"
            allow="xr-spatial-tracking; fullscreen; gamepad; pointer-lock"
          />
        </section>
        <section className={paneClass("dashboard")} aria-label="Analytics dashboard">
          <iframe
            ref={dashboardRef}
            key={`dashboard-${nonce}-${dashboardNonce}`}
            className="split__frame"
            src="/dashboard/index.html"
            title="Uptimizr dashboard"
          />
        </section>
      </div>
      {guideOn ? (
        <DemoGuide step={guideStep} onStep={goToStep} onClose={() => setGuide(false)} />
      ) : null}
    </div>
  );
}
