---
"@uptimizr/react": minor
---

`CollectorApi` no longer needs to coerce aggregate columns: the collector now guarantees JSON
numbers on every store (ADR 0051 §2). The coercion is **kept as a documented back-compat shim**
rather than removed, in one place (`num()`) instead of ~165 unexplained `Number(...)` casts —
`@uptimizr/react` is published independently of the collector, so a dashboard (including the
redistributable static export) can legitimately be pointed at an older collector that still emits
strings, and silently summing strings there would be the worse failure. The same call sites also
supply the `?? 0` that turns a `null` aggregate — SQL's "no samples" — into a chartable zero, which
is a display decision rather than a wire-format one. Behaviour is unchanged; drop the shim once the
supported collector range no longer includes a pre-#298 release.
