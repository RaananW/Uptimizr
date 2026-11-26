import { GUIDE_STEPS, type GuideStep } from "../guide.js";

interface DemoGuideProps {
  /** The step to show (an index into `GUIDE_STEPS`). */
  step: number;
  onStep: (step: number) => void;
  /** Close the guide, which turns it off until the top-bar button turns it back on. */
  onClose: () => void;
}

/**
 * The demo guide card: one short step explaining part of the split view, with
 * Back / Next and a close button. It is deliberately non-modal so the visitor
 * can keep using the scene and the dashboard while reading it; the pane a step
 * is about is outlined by the split view, not covered.
 */
export function DemoGuide({ step, onStep, onClose }: DemoGuideProps) {
  const current: GuideStep | undefined = GUIDE_STEPS[step];
  if (!current) return null;
  const last = step === GUIDE_STEPS.length - 1;
  return (
    <aside className={`guide guide--${current.target}`} aria-label="Demo guide" aria-live="polite">
      <div className="guide__head">
        <span className="guide__count">
          {step + 1} / {GUIDE_STEPS.length}
        </span>
        <button
          type="button"
          className="guide__close"
          onClick={onClose}
          aria-label="Close the guide"
          title="Close the guide (the Guide button brings it back)"
        >
          ×
        </button>
      </div>
      <h2 className="guide__title">{current.title}</h2>
      <p className="guide__body">{current.body}</p>
      <div className="guide__nav">
        <button
          type="button"
          className="guide__btn"
          onClick={() => onStep(step - 1)}
          disabled={step === 0}
        >
          Back
        </button>
        <button
          type="button"
          className="guide__btn guide__btn--primary"
          onClick={() => (last ? onClose() : onStep(step + 1))}
        >
          {last ? "Done" : "Next"}
        </button>
      </div>
    </aside>
  );
}
