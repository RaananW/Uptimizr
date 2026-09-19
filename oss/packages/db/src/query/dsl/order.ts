/**
 * **`order`: on the delegated tier** (ADR 0051 §3).
 *
 * The generic builder puts the caller's `order` straight into its `ORDER BY`, so
 * the row cap keeps the rows the caller asked for. A *delegated* metric cannot:
 * its builder has one `ORDER BY` of its own, and it applied the `LIMIT` in that
 * order before these rows existed.
 *
 * So a delegated re-order is exactly what it looks like — a re-sort of the rows
 * that came back, done here rather than in the model's head. What it is **not**
 * is a "bottom N": asking `top_meshes` for `count ASC` returns the *top* rows
 * sorted ascending, because the store already discarded everything below the
 * cap. {@link ORDER_AFTER_CAP_CAVEAT} says so, and the collector attaches it to
 * the envelope whenever this function actually changed the order of a capped
 * result — which is the only honest way to offer the feature at all.
 */

/** A row as it leaves a store. */
type Row = Readonly<Record<string, unknown>>;

/** What `order` asks for. */
export interface ResultOrder {
  by: string;
  dir: "asc" | "desc";
}

/** Attached to a result whose delegated rows were re-ordered after the cap. */
export const ORDER_AFTER_CAP_CAVEAT =
  "`order` was applied to the rows this metric returned, which its own builder had already " +
  "capped in its own order — so an ascending sort shows the smallest of the top rows, not the " +
  "smallest overall. Raise `limit`, or group by the dimension you want the tail of.";

/**
 * Re-sort rows by a column, missing and non-numeric values last in either
 * direction (a row with no value is not "the smallest"; it is unmeasured).
 * Ties break on the remaining columns' rendered values so the order is a
 * function of the row set rather than of the engine's scan order.
 *
 * Returns a new array; the input is never mutated.
 */
export function applyOrder<T extends Row>(rows: readonly T[], order: ResultOrder): T[] {
  const sign = order.dir === "asc" ? 1 : -1;
  return [...rows].sort((a, b) => {
    const left = a[order.by];
    const right = b[order.by];
    const leftNumber = typeof left === "number" && Number.isFinite(left) ? left : null;
    const rightNumber = typeof right === "number" && Number.isFinite(right) ? right : null;
    if (leftNumber == null || rightNumber == null) {
      if (leftNumber !== rightNumber) return leftNumber == null ? 1 : -1;
    } else if (leftNumber !== rightNumber) {
      return sign * (leftNumber - rightNumber);
    }
    const leftKey = JSON.stringify(a);
    const rightKey = JSON.stringify(b);
    return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
  });
}

/**
 * Whether re-ordering `rows` could misrepresent a capped result — the condition
 * under which {@link ORDER_AFTER_CAP_CAVEAT} belongs on the envelope.
 */
export function reordersCappedResult(rows: readonly Row[], limit: number | undefined): boolean {
  return limit != null && Number.isFinite(limit) && rows.length >= limit;
}
