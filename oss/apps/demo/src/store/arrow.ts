/**
 * The minimal surface of an Arrow `Table` we read, declared structurally so the
 * demo does not take a direct `apache-arrow` dependency (and cannot drift from
 * the copy bundled inside DuckDB-Wasm). DuckDB-Wasm query results satisfy this.
 *
 * Each field carries its Arrow `type`, which we inspect to recognize temporal
 * columns — DuckDB-Wasm hands `TIMESTAMP` columns back as plain epoch-millis
 * numbers (indistinguishable by value from a count), so the schema is the only
 * reliable signal that a column should be rendered as a timestamp string.
 */
export interface ArrowFieldLike {
  readonly name: string;
  readonly type?: unknown;
}

export interface ArrowTableLike {
  readonly numRows: number;
  readonly schema: { readonly fields: ReadonlyArray<ArrowFieldLike> };
  get(index: number): unknown;
}

/** Apache Arrow `Type` enum ids for the temporal types DuckDB emits. */
const ARROW_TYPE_DATE = 8;
const ARROW_TYPE_TIMESTAMP = 10;

/**
 * Decide whether an Arrow field is a `DATE`/`TIMESTAMP` column. Prefers the
 * stable `typeId` enum, falling back to the type's class/string name so a
 * version skew in the bundled Arrow copy still resolves correctly.
 */
function isTemporalField(type: unknown): boolean {
  if (!type || typeof type !== "object") return false;
  const id = (type as { typeId?: number }).typeId;
  if (id === ARROW_TYPE_DATE || id === ARROW_TYPE_TIMESTAMP) return true;
  const name = (type as { constructor?: { name?: string } }).constructor?.name ?? String(type);
  return /Timestamp|Date/.test(name);
}

/**
 * Convert a temporal Arrow cell — a `Date`, an epoch-millis number, or a bigint
 * of millis — into the dialect's naive-UTC `YYYY-MM-DD HH:MM:SS.mmm` text, so
 * sessions/scenes timestamps match the native DuckDB store's string output that
 * the dashboard's `parseTimestamp`/`formatTime` helpers expect.
 */
function convertTemporal(value: unknown): unknown {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return formatNaiveUtc(value);
  if (typeof value === "bigint") return formatNaiveUtc(new Date(Number(value)));
  if (typeof value === "number") return formatNaiveUtc(new Date(value));
  return value;
}

/**
 * Convert one Arrow-Wasm cell value into the plain JS shape the dashboard
 * expects, mirroring the native DuckDB store's `convertValue`:
 *
 * - `bigint` (BIGINT / COUNT) → `number`
 * - Arrow list vectors and arrays (`DOUBLE[]`) → recursively converted arrays
 * - `Date` (DATE / TIMESTAMP) → naive `YYYY-MM-DD HH:MM:SS.mmm` text
 * - scalars pass through unchanged
 *
 * Keeping this aligned with the Node store keeps the in-browser results
 * byte-for-byte comparable with a self-hosted collector.
 */
export function convertArrowValue(value: unknown): unknown {
  if (value === null || value === undefined) return null;
  if (typeof value === "bigint") return Number(value);
  if (Array.isArray(value)) return value.map(convertArrowValue);
  if (value instanceof Date) return formatNaiveUtc(value);

  // Arrow list vectors expose `.toArray()`; flatten and recurse so `DOUBLE[]`
  // columns become number[] like the native `{ items: [...] }` mapping.
  if (typeof value === "object" && typeof (value as { toArray?: unknown }).toArray === "function") {
    return Array.from((value as { toArray(): unknown[] }).toArray(), convertArrowValue);
  }
  return value;
}

/** Format a `Date` as the dialect's naive-UTC `YYYY-MM-DD HH:MM:SS.mmm` text. */
function formatNaiveUtc(d: Date): string {
  const p = (n: number, w = 2) => String(n).padStart(w, "0");
  return (
    `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ` +
    `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}.${p(d.getUTCMilliseconds(), 3)}`
  );
}

/**
 * Materialize an Arrow {@link ArrowTableLike} into an array of plain row objects,
 * with every cell normalized by {@link convertArrowValue}. Reads field values by
 * column name (avoiding Arrow's `toJSON`, which leaves `bigint`/vectors raw).
 * Temporal columns are formatted to naive-UTC text using their schema type, so
 * the in-browser results stay byte-for-byte comparable with the native store.
 */
export function tableToRows<T>(table: ArrowTableLike): T[] {
  const fields = table.schema.fields.map((f) => ({ name: f.name, temporal: isTemporalField(f.type) }));
  const rows: T[] = [];
  for (let i = 0; i < table.numRows; i++) {
    const row = table.get(i);
    if (!row) continue;
    const out: Record<string, unknown> = {};
    for (const { name, temporal } of fields) {
      const raw = (row as Record<string, unknown>)[name];
      out[name] = temporal ? convertTemporal(raw) : convertArrowValue(raw);
    }
    rows.push(out as T);
  }
  return rows;
}
