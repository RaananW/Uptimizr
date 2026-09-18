/**
 * Signing an outbound webhook body (ADR 0051 §6, design sketch §F.3/§F.4).
 *
 * Everything Uptimizr pushes out of a self-hoster's process — the scheduled
 * agent report today, conditional-subscription deliveries next — is POSTed with
 * an HMAC-SHA-256 of the **exact bytes sent**, so a receiver (Slack relay, a
 * GitHub Action, the operator's own agent) can prove the payload came from their
 * collector and was not modified in transit.
 *
 * The scheme, deliberately boring and identical to what every webhook consumer
 * already knows how to verify:
 *
 * ```
 * X-Uptimizr-Signature: sha256=<lowercase hex HMAC-SHA-256(secret, rawBody)>
 * X-Uptimizr-Delivery:  <random id, unique per delivery attempt>
 * ```
 *
 * Verification MUST be done over the raw request body **before** JSON parsing
 * (re-serialising changes bytes) and MUST use a constant-time comparison —
 * {@link verifyWebhookSignature} does both.
 *
 * No secret is ever logged, persisted or echoed: it is read from
 * `UPTIMIZR_WEBHOOK_SECRET` at the point of use and passed straight to the HMAC.
 */

import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";

/** Header carrying `sha256=<hex>` over the raw body. */
export const WEBHOOK_SIGNATURE_HEADER = "X-Uptimizr-Signature";

/** Header carrying a unique id per delivery attempt (for receiver-side dedupe). */
export const WEBHOOK_DELIVERY_HEADER = "X-Uptimizr-Delivery";

/** The algorithm prefix the signature header always carries. */
const PREFIX = "sha256=";

/**
 * Sign a raw body with the shared secret.
 *
 * @param secret The shared secret (`UPTIMIZR_WEBHOOK_SECRET`).
 * @param body The exact bytes that will be sent as the request body.
 * @returns The value for {@link WEBHOOK_SIGNATURE_HEADER} (`sha256=<hex>`).
 */
export function signWebhookBody(secret: string, body: string): string {
  return `${PREFIX}${createHmac("sha256", secret).update(body, "utf8").digest("hex")}`;
}

/**
 * Verify a received signature header against the raw body, in constant time.
 *
 * Returns `false` — never throws — for a missing header, the wrong prefix, a
 * wrong-length digest or a mismatch, so a receiver can reject uniformly without
 * leaking which check failed.
 */
export function verifyWebhookSignature(secret: string, body: string, header: string): boolean {
  if (!header.startsWith(PREFIX)) return false;
  const expected = Buffer.from(signWebhookBody(secret, body), "utf8");
  const received = Buffer.from(header, "utf8");
  // `timingSafeEqual` throws on a length mismatch, which is not secret (the
  // digest length is fixed and public), so compare lengths first.
  return expected.length === received.length && timingSafeEqual(expected, received);
}

/** A fresh delivery id for {@link WEBHOOK_DELIVERY_HEADER}. */
export function newDeliveryId(): string {
  return randomUUID();
}

/**
 * Validate an operator-supplied webhook URL.
 *
 * The URL comes from the command line (or, later, a stored subscription), so it
 * is request-controlled input to an outbound request: only `http:` and `https:`
 * are accepted, which rules out `file:`, `data:` and any other scheme a fetch
 * implementation might honour. Host reachability is deliberately **not**
 * restricted — a self-hoster posting to `http://localhost:3000/hook` or to an
 * internal Slack relay is the normal case, and the collector is not a
 * multi-tenant proxy — so the SSRF boundary here is the operator's own shell.
 * Anything that later accepts a webhook URL over HTTP must add its own
 * allow-list on top of this check.
 *
 * @returns The parsed URL.
 * @throws If the value is not a syntactically valid `http(s)` URL.
 */
export function parseWebhookUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`--webhook must be an absolute http(s) URL (got ${JSON.stringify(value)}).`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(
      `--webhook must use http or https (got ${JSON.stringify(url.protocol.replace(":", ""))}).`,
    );
  }
  return url;
}
