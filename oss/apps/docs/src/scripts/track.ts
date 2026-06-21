import { track } from "@vercel/analytics";

/** Classify an outbound destination into a low-cardinality bucket (no PII). */
function classify(url: URL): string {
  const host = url.hostname;
  if (host === "github.com" || host.endsWith(".github.com")) return "github";
  if (host === "demo.uptimizr.com") return "demo";
  if (host === "npmjs.com" || host.endsWith(".npmjs.com")) return "npm";
  return "external";
}

/**
 * Track clicks that leave the docs site as `docs_outbound` events. Internal
 * navigation is already covered by Vercel page views, so we only fire for
 * cross-host links. Props stay low-cardinality (a bucket + the host).
 */
export function initOutboundTracking(): void {
  document.addEventListener("click", (event) => {
    const anchor = (event.target as HTMLElement | null)?.closest<HTMLAnchorElement>("a[href]");
    if (!anchor) return;

    let url: URL;
    try {
      url = new URL(anchor.href, location.href);
    } catch {
      return;
    }
    if (url.host === location.host || (url.protocol !== "http:" && url.protocol !== "https:")) {
      return;
    }

    try {
      track("docs_outbound", { target: classify(url), host: url.host });
    } catch {
      /* analytics is best-effort; never block navigation */
    }
  });
}
