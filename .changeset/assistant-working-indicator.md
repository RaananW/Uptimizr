---
"@uptimizr/react": patch
---

Make the in-browser analytics assistant show that it is working and never hide
its reply. `<AssistantPanel>` now renders an always-visible spinner + status
label (`Loading model…` / `Running analytics…` / `Thinking…`) in an `aria-live`
region while a turn is in flight — so non-streaming local (WebLLM) generation no
longer looks frozen. A turn that finishes without a natural-language answer now
shows an explicit, non-error info line instead of rendering nothing: derived
from the agent loop's own signals, it distinguishes the model stopping with no
text from it hitting the step cap while tool-calling (reporting how many steps it
took and suggesting a next step). `useAssistant` exposes a typed `notice`
(`{ kind: "no_answer" } | { kind: "stopped_on_max_steps"; steps }`) for custom
UIs, and its default `maxSteps` is raised to 12 (scoped to the assistant; the
shared `@uptimizr/agent-core` default is unchanged) so small local models have
room to wrap up. The conversation area also scrolls and auto-follows the newest
message.
