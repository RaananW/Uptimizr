/**
 * How a `POST /api/v1/collect` response settles a batch, shared by the
 * main-thread transport ([`transport.ts`](./transport.ts)) and the offload
 * worker ([`offloadWorker.ts`](./offloadWorker.ts)) so the two delivery paths
 * cannot drift apart (#274, #403).
 *
 * This module must stay dependency-free: the worker is bundled as a separate
 * module worker, and anything imported here ships in that bundle too.
 */

/** The slice of a fetch `Response` the classification reads. */
export interface CollectResponseLike {
  readonly ok: boolean;
  readonly status: number;
}

/**
 * `true` when the batch needs no further attempt; `false` when the client
 * should re-queue it.
 *
 * A 2xx is delivered. A definitive rejection (schema/auth/oversize — any 4xx
 * other than the transient 408/429) can never succeed on retry, so it is
 * reported as handled: re-queueing it would put the same invalid payload at the
 * head of every later batch and block delivery until the queue evicts it. 5xx,
 * 408 and 429 stay retryable (network errors never produce a response, so the
 * caller reports those as `false` itself).
 */
export function isCollectResponseHandled(res: CollectResponseLike): boolean {
  if (res.ok) return true;
  return res.status >= 400 && res.status < 500 && res.status !== 408 && res.status !== 429;
}
