---
"@uptimizr/react": patch
---

fix(react): stop the assistant tool-activity list overlapping the chat column

In `<AssistantPanel>`, the fixed-height (`max-h-[24rem]`) flex-column scroll
container let the conversation `<ol>` (which has `min-h-[8rem]`) shrink below its
content under pressure, so its `overflow:visible` messages spilled over the
following "Tool activity" list and painted on top of it. The scroll children are
now `shrink-0`, so the column keeps its natural height and the container scrolls
as one unit — the two regions can no longer visually collide. Consecutive
identical tool calls (e.g. `top_meshes` ×12) are also folded into a single
counted row so the list stays readable.
