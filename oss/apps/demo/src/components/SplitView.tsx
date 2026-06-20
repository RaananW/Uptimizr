import { useState } from "react";

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
  // Bump to force-remount both iframes after a reset.
  const [nonce, setNonce] = useState(0);
  const [resetting, setResetting] = useState(false);

  async function handleReset() {
    setResetting(true);
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
          className="split__reset"
          onClick={handleReset}
          disabled={resetting}
          aria-busy={resetting}
        >
          {resetting ? "Clearing…" : "Clear data"}
        </button>
      </header>
      <div className="split__panes">
        <section className="split__pane" aria-label="3D playground">
          <iframe
            key={`playground-${nonce}`}
            className="split__frame"
            src="/playground/index.html"
            title="Uptimizr playground"
            allow="xr-spatial-tracking; fullscreen; gamepad"
          />
        </section>
        <section className="split__pane" aria-label="Analytics dashboard">
          <iframe
            key={`dashboard-${nonce}`}
            className="split__frame"
            src="/dashboard/index.html"
            title="Uptimizr dashboard"
          />
        </section>
      </div>
    </div>
  );
}
