import { useRef } from "react";

/** Whether two arrays hold the same items in the same order (by `Object.is`). */
export function sameItems<T>(
  a: readonly T[] | null | undefined,
  b: readonly T[] | null | undefined,
): boolean {
  if (a === b) return true;
  if (!a || !b || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (!Object.is(a[i], b[i])) return false;
  return true;
}

/**
 * The previous array while the new one holds the same items, so an effect keyed
 * on it runs only when the contents change. A host that builds an array prop
 * inline (`labels={labelsFor(rows)}`, or a `= []` default) hands a view a new
 * array on every render, and the 3D views' repaint effects rebuilt their scene
 * and re-rendered it each time, several times a second, while nothing changed.
 */
export function useStableArray<A extends readonly unknown[] | null | undefined>(value: A): A {
  const ref = useRef(value);
  if (!sameItems(ref.current, value)) ref.current = value;
  return ref.current;
}
