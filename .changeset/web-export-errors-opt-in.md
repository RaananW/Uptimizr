---
"@uptimizr/web-export": minor
"@uptimizr/unity": minor
"@uptimizr/godot": minor
"@uptimizr/unreal": minor
---

`runtime_error` capture on web exports is now off by default, as ADR 0013 requires, because error text can carry PII. Opt in with `capture: { errors: true }`. Capture now de-duplicates consecutive identical errors and stops at 50 per session, and `trackWebExport`, `trackUnity`, `trackGodot` and `trackUnreal` accept `beforeSend` for redaction.
