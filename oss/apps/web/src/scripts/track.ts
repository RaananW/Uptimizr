import { track } from "@vercel/analytics";

type TrackProps = Record<string, string | number | boolean>;

/**
 * Thin wrapper around Vercel's `track` so call sites don't each import the
 * vendor SDK, and so an analytics failure can never break the page. Keep event
 * names and props low-cardinality enums — no free text, no PII (ADR 0003).
 */
export function trackEvent(name: string, props?: TrackProps): void {
  try {
    track(name, props);
  } catch {
    /* analytics is best-effort; never let it throw into the UI */
  }
}

/**
 * Delegated click tracking: any element carrying `data-track="event_name"`
 * fires that custom event on click. Extra `data-track-*` attributes become
 * event props (e.g. `data-track-location="hero"` → `{ location: "hero" }`).
 */
export function initClickTracking(root: Document | HTMLElement = document): void {
  root.addEventListener("click", (event) => {
    const el = (event.target as HTMLElement | null)?.closest<HTMLElement>("[data-track]");
    const name = el?.dataset.track;
    if (!el || !name) return;

    const props: TrackProps = {};
    for (const [key, value] of Object.entries(el.dataset)) {
      if (key === "track" || !key.startsWith("track") || value == null) continue;
      // dataset key "trackLocation" → prop "location"
      const prop = key.slice("track".length).replace(/^[A-Z]/, (c) => c.toLowerCase());
      props[prop] = value;
    }

    trackEvent(name, props);
  });
}
