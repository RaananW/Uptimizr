/**
 * Coarse, dependency-free User-Agent → `{ browser, os }` derivation, run
 * server-side at ingestion (ADR 0041). The raw User-Agent is **never stored** — it
 * is consumed for the visitor hash and reduced here to two low-cardinality,
 * non-PII family labels used only to segment the performance panels (ADR 0003).
 *
 * Intentionally coarse: no version numbers, no device model, no exhaustive bot
 * matrix. The goal is a handful of stable buckets ("is my scene slower on Safari
 * / iOS?"), not fingerprinting. Anything unrecognized collapses to `"Other"`.
 */

/** Low-cardinality browser + OS families derived from a User-Agent. */
export interface ClientInfo {
  /** Coarse browser family, e.g. `"Chrome"`, `"Safari"`, `"Other"`. */
  browser: string;
  /** Coarse OS family, e.g. `"Windows"`, `"iOS"`, `"Other"`. */
  os: string;
}

const UNKNOWN = "Other";

/**
 * Map a User-Agent string to a coarse browser family. Order matters: more
 * specific brands (Edge, Opera, Brave) are tested before the Chrome/Safari
 * substrings they also contain.
 */
function parseBrowser(ua: string): string {
  // Edge (Chromium) advertises "Edg/"; legacy Edge advertises "Edge/".
  if (/\bEdg(?:e|A|iOS)?\//i.test(ua)) return "Edge";
  // Opera advertises "OPR/" (Chromium) or "Opera".
  if (/\bOPR\/|\bOpera\b/i.test(ua)) return "Opera";
  if (/\bSamsungBrowser\//i.test(ua)) return "Samsung Internet";
  if (/\bFirefox\/|\bFxiOS\//i.test(ua)) return "Firefox";
  // Chrome and Chrome-on-iOS ("CriOS"); excludes the brands handled above.
  if (/\bChrome\/|\bCriOS\//i.test(ua)) return "Chrome";
  // Safari must come after Chrome/Edge/Opera because they all include "Safari".
  if (/\bSafari\//i.test(ua) || /\bVersion\/.*\bMobile\b/i.test(ua)) return "Safari";
  return UNKNOWN;
}

/** Map a User-Agent string to a coarse OS family. */
function parseOs(ua: string): string {
  // iOS first: iPad/iPhone UAs also contain "Mac OS X".
  if (/\biPhone\b|\biPad\b|\biPod\b/i.test(ua)) return "iOS";
  // iPadOS 13+ reports a desktop Safari UA ("Macintosh") but is touch-capable;
  // we cannot reliably distinguish it, so it falls through to macOS — acceptable
  // for a coarse segment.
  if (/\bAndroid\b/i.test(ua)) return "Android";
  if (/\bWindows\b/i.test(ua)) return "Windows";
  if (/\bMac OS X\b|\bMacintosh\b/i.test(ua)) return "macOS";
  if (/\bCrOS\b/i.test(ua)) return "ChromeOS";
  if (/\bLinux\b/i.test(ua)) return "Linux";
  return UNKNOWN;
}

/**
 * Derive coarse `{ browser, os }` from a User-Agent header. An empty/missing UA
 * yields `{ browser: "Other", os: "Other" }`. The input string is not retained.
 */
export function parseClientInfo(ua: string | undefined): ClientInfo {
  if (!ua) return { browser: UNKNOWN, os: UNKNOWN };
  return { browser: parseBrowser(ua), os: parseOs(ua) };
}
