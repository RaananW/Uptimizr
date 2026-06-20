/**
 * Generate a random, non-persistent identifier.
 *
 * Used for in-memory session IDs only. Per ADR 0003 the SDK never stores a durable
 * identifier on the client, so these IDs live only for the lifetime of the page.
 */
export function randomId(): string {
  const c = (globalThis as { crypto?: Crypto }).crypto;
  if (c && typeof c.randomUUID === "function") {
    return c.randomUUID();
  }
  // Fallback for environments without crypto.randomUUID.
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}
