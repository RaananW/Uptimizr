---
---

`scripts/gen-registry-docs.mjs` now refuses a target file whose generated-block markers are
ambiguous instead of silently rewriting part of it: a duplicated `:start` or `:end`, a marker with
no partner, an `:end` before its `:start`, two sections that overlap, or a marker naming a block
the file does not declare. Closes #370.
