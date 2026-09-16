# @uptimizr/agent-eval

**Private to this repository — not published.** It is a measuring instrument, not a shipped
package.

"AI-first" is a claim until something measures it. This package is the measurement: a bank of real
analytics questions, asked of an agent through the real collector over a deterministic fixture set,
scored on **tool selection**, **argument correctness** and **answer accuracy** (ADR 0051 §8, design
sketch §H).

It is the instrument for tuning the registry's tool descriptions: change a description, run the
eval, see whether the agent picks better tools.

## What a run does

1. Seeds the `@uptimizr/db` **parity fixtures** — the same events the DuckDB-vs-golden suite proves
   the aggregations against — plus a small supplement (`src/fixtures.ts`) for the capture channels
   the parity set does not carry, into a fresh in-memory DuckDB store.
2. Boots the **real** collector Fastify app in-process and talks to it through `app.inject()`. No
   port is bound, so a run never collides with a dev server or a parallel Playwright suite.
3. Drives `runAgent` from `@uptimizr/agent-core` with the **generated** read-tool catalog (one tool
   per served registry metric) and the chosen provider.
4. Records every tool call, its arguments, and the final answer; scores each case; writes
   `report.md` and `report.json`.
5. Compares the run to the committed baseline in `eval/baseline.json` and exits non-zero when it has
   regressed.

## Running it

```bash
# Deterministic, no key, no network — what CI gates on.
pnpm --filter @uptimizr/agent-eval run eval

# A real model. Anthropic `claude-sonnet-5` by default.
UPTIMIZR_EVAL_API_KEY=… pnpm --filter @uptimizr/agent-eval run eval -- --provider hosted

# Unit + end-to-end suites (scoring, the bank, the coverage rule).
pnpm --filter @uptimizr/agent-eval test

# What does a metric actually return over the fixtures? (How case numbers are derived.)
pnpm --filter @uptimizr/agent-eval run derive perf_summary jank_rate
```

| Flag                 | Effect                                                                          |
| -------------------- | ------------------------------------------------------------------------------- |
| `--provider`         | `scripted` (default) or `hosted`.                                               |
| `--out <dir>`        | Where `report.md` / `report.json` are written (default: the package root).      |
| `--update-baseline`  | Re-record `eval/baseline.json` for the provider that just ran.                  |
| `--skip-without-key` | A hosted run with no key becomes a visible notice and a success, not a failure. |

## Providers

| Kind       | Where it runs                    | Configuration                                                                                                                |
| ---------- | -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `scripted` | In-process, deterministic        | none                                                                                                                         |
| `hosted`   | The user's own provider endpoint | `UPTIMIZR_EVAL_PROVIDER` (`anthropic` \| `openai`), `UPTIMIZR_EVAL_MODEL`, `UPTIMIZR_EVAL_ENDPOINT`, `UPTIMIZR_EVAL_API_KEY` |
| `webllm`   | A headless browser (WebGPU)      | scaffolded only — see `scripts/webllm-eval.ts`                                                                               |

`UPTIMIZR_EVAL_API_KEY` falls back to `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` so a developer who
already exports one does not need a second. **The key is read from the environment into the
provider adapter and nowhere else** — it is never persisted, never logged, and never written to a
report (`src/__tests__/providers.test.ts` pins that).

The **scripted** provider is not a shortcut around the real thing. It drives the real agent loop
against the real collector and composes its answer from **what the collector returned**, never from
the case's own expectations — so a case whose expected answer does not follow from the data it asks
for fails in CI, with no key and no network, and the scoring code is exercised end to end on every
PR.

## The question bank

One YAML file per registry category under `cases/`. A case looks like this:

```yaml
- id: perf_headline
  category: performance
  question: How is frame rate overall — average, worst and median?
  context: { scene: lobby } # optional scene / session / range hints
  expectedTools:
    - [perf_summary, perf_distribution] # an "any-of" set: call one of these
    - [jank_rate] # …and also one of these
  expectedArgs:
    perf_summary: { scene: lobby } # subset match — extra arguments are fine
  expectedAnswer:
    numbers:
      - { value: 42.2, tolerance: 0.05, label: average FPS }
    phrases: ["lobby"]
    forbiddenPhrases: ["no data"]
```

- **`expectedTools`** is a list of any-of sets; every set must be satisfied by at least one call.
  Extra calls are not penalised — there is usually more than one defensible route to an answer, and
  a stricter rule would grade style rather than correctness.
- **`expectedArgs`** is a subset match per tool.
- **`expectedAnswer.forbiddenPhrases`** is the hallucination guard: an invented figure or a refusal
  fails the case even when the tool selection was right.
- A case may name one of the curated MCP prompts instead of a question
  (`prompt: { name: attention_hotspots, args: { scene: lobby } }`). The text is rendered from
  `@uptimizr/mcp` itself, so rewording a prompt updates the eval question automatically.

### Every number is derived, never hand-computed

Run the aggregation and read the row off it:

```bash
pnpm --filter @uptimizr/agent-eval run derive mesh_dwell
### mesh_dwell  (api/v1/meshes/dwell)
[{"mesh":"statue","visible_ms":6000, …}]
```

## Adding a case (and why you must)

`src/__tests__/coverage.test.ts` fails the build when a metric the collector serves is neither
referenced by some case's `expectedTools` nor listed in `eval/uncovered.json` with a written reason.
The tool catalog is generated from the metric registry, so a new aggregation grows the agent's
surface automatically — this rule makes sure it does not arrive un-evaluated. The same test requires
every registry category to have at least one case.

So: add the metric to the registry, then add a case here.

1. `pnpm --filter @uptimizr/agent-eval run derive <metric>` to see what it returns over the
   fixtures. If it returns nothing, the fixtures do not exercise its capture channel — extend
   `EVAL_SUPPLEMENT_EVENTS` in `src/fixtures.ts` (never the shared parity fixtures, which the
   cross-engine golden depends on).
2. Write the case into the matching `cases/*.yaml`, with derived numbers.
3. `pnpm --filter @uptimizr/agent-eval test` — the scripted run must still be 100%.
4. `pnpm --filter @uptimizr/agent-eval run eval -- --update-baseline` and commit
   `eval/baseline.json`.

## The baseline and the gate

`eval/baseline.json` holds one entry per provider: the pass rate and the per-case state behind it.

- The **scripted** baseline is exact (tolerance `0`). It is deterministic, so any drift is a real
  change.
- The **hosted** baseline is a floor with a tolerance, because a sampled model is not reproducible
  run to run. Until a key exists in CI there is no hosted entry at all, and the gate says so and
  passes rather than inventing one — a measurement nobody made must never be reported as green.

## CI

| Workflow                                 | When                                                                                  | What                                                                          |
| ---------------------------------------- | ------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| `.github/workflows/agent-eval.yml`       | PRs touching `agent-core`, `agent-eval`, `mcp`, `db/src/query`, `react/src/assistant` | scripted eval (gates), hosted eval (needs the `UPTIMIZR_EVAL_API_KEY` secret) |
| `.github/workflows/agent-eval-local.yml` | Weekly (Sunday 05:00 UTC)                                                             | local-model leg — scaffolded, see `scripts/webllm-eval.ts`                    |

Both upload `report.md` as an artefact. The hosted job emits a visible notice and passes when the
secret is absent, so a fork PR is never red for a secret it cannot have.

## Layout

```
cases/*.yaml     the question bank, one file per registry category
eval/baseline.json   committed per-provider baseline
eval/uncovered.json  metrics deliberately without a case, with reasons
src/fixtures.ts  parity fixtures + the supplement the bank needs
src/harness.ts   seeded DuckDB store + in-process collector + inject client
src/runner.ts    drives runAgent per case and records the run
src/scoring.ts   pure scoring over a recorded run
src/coverage.ts  what the bank covers, for the coverage rule
src/cli.ts       the entry point CI runs
scripts/         derive-expectations (authoring aid), webllm-eval (scaffold)
```
