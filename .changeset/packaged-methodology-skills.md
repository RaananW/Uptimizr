---
"@uptimizr/agent-core": minor
"@uptimizr/mcp": minor
"@uptimizr/react": patch
"@uptimizr/collector-server": patch
---

Packaged methodology skills (ADR 0051 §7)

A prompt that names tools still leaves the method to the model. A **skill** carries the
method: an Agent Skills file — `skills/<name>/SKILL.md` — whose frontmatter declares the
tools it relies on, the key capabilities it needs and the arguments it takes, and whose
body is the investigation written out as numbered steps.

Five ship, in both the `@uptimizr/agent-core` and `@uptimizr/mcp` tarballs:

- **`weekly_scene_health`** — the recurring health check: score first, then what moved,
  whether the new level is outside baseline, whether the change is real, and the date the
  anomaly scan puts on it.
- **`attention_hotspots`** — where attention concentrates in a scene, and the cold half:
  dwell without interaction, and the meshes nobody ever notices.
- **`conversion_investigation`** _(new)_ — where a funnel loses people and why: the bounce
  before the first step, the worst transition, and the interaction failure (dead clicks,
  rage clicks, an unreachable target) that usually _is_ the drop-off.
- **`performance_regression_triage`** _(new)_ — confirm, date, locate, then name the
  mechanism: jank versus a uniform slowdown, compile stalls, memory pressure, a
  render-scale change or a shift in the rendering-technology mix.
- **`xr_comfort_audit`** — rapid rotation, locomotion style and early exits, with tracking
  loss and guardian contacts ruled out first.

The files are the source of truth. `scripts/gen-agent-skills.mjs` compiles them into
`skills.generated.ts`, so `AGENT_SKILLS` is derived from them and `@uptimizr/agent-core`
stays browser-safe (nothing reads them from disk at runtime). `pnpm gen:skills:check` is
the CI gate that fails a hand-edited generated file.

Every surface reads the same text: `@uptimizr/mcp` registers one prompt template per skill
and adds a **`uptimizr://skills`** resource listing the catalog, `uptimizr agent report
--skill` runs one headlessly (and now fills the skill's `range` from `--window`), and the
`@uptimizr/react` assistant offers the argument-free ones as starter prompts.

`getAgentSkill(name)` accepts either spelling — `xr_comfort_audit` or `xr-comfort-audit` —
and `AgentSkill` gains `id` and `capabilities`. The XR skill was widened from comfort
signals to a full audit and renamed `xr_comfort_review` → `xr_comfort_audit`; the old name
still resolves, so saved prompt references and cron lines keep working.
