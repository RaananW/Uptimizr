import type { SubscriptionDelivery, SubscriptionFiring } from "@uptimizr/schema";
import { clampSubscriptionError, type SubscriptionRecord } from "@uptimizr/db";
import {
  WEBHOOK_DELIVERY_HEADER,
  WEBHOOK_SIGNATURE_HEADER,
  newDeliveryId,
  parseWebhookUrl,
  signWebhookBody,
} from "../webhookSignature.js";

/**
 * **Delivering a subscription firing** (#311, ADR 0051 §6 / sketch §F.3).
 *
 * Two targets, and they are deliberately asymmetric:
 *
 * - **SSE** is a fan-out to whoever is already connected. It costs nothing, it
 *   leaves the process only over a connection the operator's own key opened, and
 *   it is the default.
 * - **A webhook is egress.** Nothing here makes an outbound request unless a
 *   subscription carries a `webhook` delivery with a URL — ADR 0051 §6, "no
 *   outbound egress happens unless a self-hoster configures a webhook URL", is
 *   enforced by {@link deliver} having nothing to do in that case.
 *
 * ## The SSRF boundary
 *
 * `parseWebhookUrl` (shared with `uptimizr agent report`) rejects anything that
 * is not `http(s)`, and its own doc is explicit that a surface which accepts a
 * URL *over HTTP* must add an allow-list on top — which is exactly this surface,
 * because a subscription is created through the API by an `annotate` key rather
 * than typed into the operator's shell. {@link checkWebhookUrl} is that
 * allow-list: `COLLECTOR_WEBHOOK_ALLOWED_HOSTS`, empty by default, which means
 * **no webhook delivery leaves the process at all until an operator names the
 * hosts it may reach**. A key holder can therefore not turn the collector into a
 * probe for the network it sits in.
 *
 * ## Retries
 *
 * Three attempts, exponential backoff, only for failures that can plausibly
 * succeed on a retry (a network error, a 408/429, any 5xx). A 4xx other than
 * those is the receiver saying "not like that", and repeating it just triples
 * the noise. Every attempt carries the same {@link WEBHOOK_DELIVERY_HEADER} id,
 * so a receiver can dedupe.
 */

/** Attempts per firing, including the first. */
export const WEBHOOK_MAX_ATTEMPTS = 3;
/** Backoff before the 2nd attempt; doubled for each further one. */
export const WEBHOOK_BASE_BACKOFF_MS = 500;
/** Per-attempt timeout. A webhook receiver that is slow is a webhook that fails. */
export const WEBHOOK_TIMEOUT_MS = 10_000;

/** The body a webhook receives. */
export interface WebhookPayload {
  /** Schema marker, so a receiver can branch on shape without guessing. */
  type: "subscription.firing";
  firing: SubscriptionFiring;
  /** Bounded `format=summary` of the metric over the window that fired. */
  summary: Record<string, unknown> | null;
}

/** Outcome of delivering one firing. */
export interface DeliveryOutcome {
  /** Whether every configured target accepted it (SSE always does). */
  ok: boolean;
  /** Bounded, redacted failure text when a webhook failed, else `null`. */
  error: string | null;
  /** How many webhook attempts were made (0 when no webhook is configured). */
  attempts: number;
  /** True when a webhook request actually left the process. */
  egress: boolean;
}

/** What {@link deliver} needs from its host. */
export interface DeliveryDeps {
  /** Push the firing to connected SSE listeners. */
  broadcast: (firing: SubscriptionFiring, summary: Record<string, unknown> | null) => void;
  /** The subscription's webhook secret, or `null`. */
  secret: string | null;
  /** Hosts a webhook may target; empty forbids all webhook egress. */
  allowedHosts: readonly string[];
  /** Injected for tests. Defaults to the global `fetch`. */
  fetchImpl?: typeof fetch;
  /** Injected for tests. Defaults to a real timer. */
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });

/**
 * Validate a webhook URL against the operator's allow-list.
 *
 * Returns the parsed URL, or a refusal string naming why. Matching is on the
 * **hostname** (case-insensitive, port-independent), because a port is not a
 * trust boundary: an operator who allows `hooks.slack.com` means the host, and
 * an operator who allows `localhost` means their own box. `*` allows every host
 * and is an explicit, documented opt-out for a collector on a closed network.
 */
export function checkWebhookUrl(
  raw: string,
  allowedHosts: readonly string[],
): { url: URL } | { refused: string } {
  let url: URL;
  try {
    url = parseWebhookUrl(raw);
  } catch (err) {
    return { refused: err instanceof Error ? err.message : "invalid webhook url" };
  }
  if (allowedHosts.length === 0) {
    return {
      refused:
        "webhook delivery is disabled: set COLLECTOR_WEBHOOK_ALLOWED_HOSTS to the hosts this " +
        "collector may POST to",
    };
  }
  const host = url.hostname.toLowerCase();
  const allowed = allowedHosts.some((entry) => {
    const candidate = entry.trim().toLowerCase();
    return candidate === "*" || candidate === host;
  });
  return allowed
    ? { url }
    : { refused: `webhook host ${JSON.stringify(host)} is not allow-listed` };
}

/** The one webhook target of a subscription, or `null`. */
export function webhookTargetOf(
  sub: SubscriptionRecord,
): Extract<SubscriptionDelivery, { kind: "webhook" }> | null {
  for (const target of sub.delivery) if (target.kind === "webhook") return target;
  return null;
}

/** Whether a subscription asks for SSE fan-out. */
export function wantsSse(sub: SubscriptionRecord): boolean {
  return sub.delivery.some((target) => target.kind === "sse");
}

/** Whether a response/error is worth another attempt. */
function retryable(status: number | null): boolean {
  if (status == null) return true; // network-level failure
  return status === 408 || status === 429 || status >= 500;
}

/**
 * POST one firing to `url`, signed, with bounded retries.
 *
 * The body is serialised **once** and the signature is taken over those exact
 * bytes, because re-serialising between signing and sending is the classic way
 * to ship a signature the receiver cannot reproduce.
 */
async function postWebhook(
  url: URL,
  payload: WebhookPayload,
  secret: string | null,
  deps: DeliveryDeps,
): Promise<{ ok: boolean; error: string | null; attempts: number }> {
  const doFetch = deps.fetchImpl ?? fetch;
  const sleep = deps.sleep ?? defaultSleep;
  const body = JSON.stringify(payload);
  const deliveryId = newDeliveryId();
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "user-agent": "uptimizr-collector",
    [WEBHOOK_DELIVERY_HEADER]: deliveryId,
  };
  if (secret != null) headers[WEBHOOK_SIGNATURE_HEADER] = signWebhookBody(secret, body);

  let lastError = "webhook delivery failed";
  for (let attempt = 1; attempt <= WEBHOOK_MAX_ATTEMPTS; attempt += 1) {
    let status: number | null = null;
    try {
      const res = await doFetch(url, {
        method: "POST",
        headers,
        body,
        signal: AbortSignal.timeout(WEBHOOK_TIMEOUT_MS),
        redirect: "error",
      });
      status = res.status;
      if (res.ok) return { ok: true, error: null, attempts: attempt };
      lastError = `webhook responded ${res.status}`;
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
    }
    if (!retryable(status) || attempt === WEBHOOK_MAX_ATTEMPTS) {
      return { ok: false, error: clampSubscriptionError(lastError), attempts: attempt };
    }
    await sleep(WEBHOOK_BASE_BACKOFF_MS * 2 ** (attempt - 1));
  }
  /* c8 ignore next */
  return { ok: false, error: clampSubscriptionError(lastError), attempts: WEBHOOK_MAX_ATTEMPTS };
}

/**
 * Deliver one firing to every target the subscription declares.
 *
 * SSE first and unconditionally — it is in-process, so a broken webhook must
 * never cost a connected agent its event.
 */
export async function deliver(
  sub: SubscriptionRecord,
  firing: SubscriptionFiring,
  summary: Record<string, unknown> | null,
  deps: DeliveryDeps,
): Promise<DeliveryOutcome> {
  if (wantsSse(sub)) deps.broadcast(firing, summary);

  const target = webhookTargetOf(sub);
  if (target == null) return { ok: true, error: null, attempts: 0, egress: false };

  const checked = checkWebhookUrl(target.url, deps.allowedHosts);
  if ("refused" in checked) {
    return {
      ok: false,
      error: clampSubscriptionError(checked.refused),
      attempts: 0,
      egress: false,
    };
  }

  const result = await postWebhook(
    checked.url,
    { type: "subscription.firing", firing, summary },
    deps.secret,
    deps,
  );
  return { ...result, egress: true };
}
