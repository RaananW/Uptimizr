import { useCallback, useEffect, useState } from "react";
import { SplitView } from "./components/SplitView.js";
import { WelcomeScreen } from "./components/WelcomeScreen.js";
import { prepareDemo, type PrepareProgress } from "./prepare.js";
import { disposeDb, resetData } from "./store/host.js";

type Phase = "welcome" | "ready";
type PrepareState = "idle" | "preparing" | "error";

/**
 * The demo shell: a welcome/prepare gate, then the live split view. The heavy
 * one-time asset download and the in-browser database are only started once the
 * visitor clicks "Prepare demo". The database is torn down when the page is
 * hidden so it never lingers in memory.
 */
export function App() {
  const [phase, setPhase] = useState<Phase>("welcome");
  const [prepareState, setPrepareState] = useState<PrepareState>("idle");
  const [progress, setProgress] = useState<PrepareProgress | null>(null);
  const [error, setError] = useState<string | null>(null);

  const onPrepare = useCallback(async () => {
    setPrepareState("preparing");
    setError(null);
    try {
      await prepareDemo(setProgress);
      setPhase("ready");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setPrepareState("error");
    }
  }, []);

  // Proactive teardown: release the worker + database when the tab goes away so
  // the demo never burdens the device after the visitor leaves.
  useEffect(() => {
    const teardown = () => void disposeDb();
    window.addEventListener("pagehide", teardown);
    return () => window.removeEventListener("pagehide", teardown);
  }, []);

  if (phase === "ready") {
    return <SplitView onReset={resetData} />;
  }
  return (
    <WelcomeScreen
      state={prepareState}
      progress={progress}
      error={error}
      onPrepare={() => void onPrepare()}
    />
  );
}
