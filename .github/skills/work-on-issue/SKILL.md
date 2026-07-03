---
name: work-on-issue
description: End-to-end workflow for implementing a GitHub issue in Uptimizr — plan, branch, code, self-review, test, validate, document, and close. USE FOR: working on an issue, implementing a feature or bug fix from an issue, taking an issue to done, what tests/acceptance criteria an issue needs. Trigger phrases: work on issue, implement issue, fix issue #N, take issue to done, start this issue.
---

# Skill: Work on a GitHub issue

The standard, repeatable way to take an Uptimizr issue from "assigned" to "closed" with
consistent quality. It encodes our definition of done: a focused change, a real self-review,
the right tests, a green validation gate, updated docs/ADRs, and a documented issue trail.

Follow the repo golden rules throughout (`AGENTS.md`): keep `oss/` self-contained, keep
events defined once in `@uptimizr/schema`, stay privacy-first, validate at boundaries, keep
backends thin, and record significant decisions as ADRs.

## 1. Understand the issue before touching code

- Read the issue fully, including its acceptance criteria and any linked ADR / phase doc /
  design sketch. Open them: `gh issue view <N> --comments`.
- Confirm **scope** (`docs/phases`) — don't implement proprietary/hosted-only features in the
  self-contained OSS collector.
- Restate the goal and the acceptance criteria in your own words as a short plan, and post it as
  an issue comment so intent is visible before work starts:
  `gh issue comment <N> --body "Plan: …"`.
- If the issue is ambiguous, has no acceptance criteria, or hides multiple changes, ask for
  clarification or split it before coding. A good issue is one discrete, assignable unit.

## 2. Branch

- Branch from up-to-date `main`: `git switch main && git pull && git switch -c <type>/<short-slug>`
  (e.g. `feat/mcp-server`, `fix/pointer-throttle`). One issue → one focused branch/PR.

## 3. Implement (minimal, idiomatic, in-scope)

- Make only the change the issue asks for. No drive-by refactors, no out-of-scope scope creep, no
  speculative abstractions.
- Honor the boundaries: keep storage behind the `@uptimizr/db` contracts; import event types from
  `@uptimizr/schema`; validate external input with Zod at the edge; TypeScript strict, ESM,
  `import type` for types.
- Keep business logic in framework-agnostic packages; keep the Fastify/Next layers thin.
- If you make a significant or hard-to-reverse decision, record it as a **new ADR**
  (`docs/adr/template.md`) and reference it — never edit a historical ADR.

## 4. Tests — what is expected

Match tests to what the change touches; a change is not done until it is covered:

- **Pure logic / schemas / query builders / mapping** (schema, sdk-core, db builders, heatmap &
  replay cores) → **Vitest unit tests** for the new behavior, including invalid/edge inputs.
  These must not need a live database or browser.
- **New or changed event type** → valid + invalid schema samples in `@uptimizr/schema`, and
  coverage through any capture/store/replay paths it touches (see the `add-event-type` skill).
- **Collector-server endpoints** → tests for the success path plus boundary failures
  (validation rejects, limits enforced, auth required where applicable).
- **db** → unit-test the pure SQL/`QuerySpec` builders; real ClickHouse/Postgres integration runs
  via `infra/docker`, not in unit tests.
- **Replay** → a driver must never emit analytics; assert determinism (seek/reset) where relevant.
- **SDK capture / dashboard UI** → unit-test event construction; add/extend an
  `examples/*-playground` E2E (Playwright) when the change is user-visible behavior.
- **Major / user-visible features are not done without an E2E.** Any feature that adds a new
  user-facing capability or a new full-stack path (a new SSE/HTTP surface, a new dashboard panel
  or interaction, a new capture→collector→dashboard/replay flow) **must** add or extend a
  Playwright spec under `examples/playground/e2e/` that drives the real browser → SDK → collector
  → dashboard/replay round trip. The harness boots the collector (DuckDB), the playground, and the
  dashboard together (`examples/playground/playwright.config.ts`); run it with
  `pnpm --filter @uptimizr/example-playground test:e2e` (one-time
  `pnpm --filter @uptimizr/example-playground test:e2e:install`). Cross-origin and
  retention/privacy-gated paths must be covered explicitly — they are exactly what unit tests miss.
- Add a **regression test** for every bug fix that fails before the fix and passes after.

Run the focused tests first (`pnpm --filter @uptimizr/<pkg> test`), then the full gate in step 6.

## 5. Self-review before committing (required)

Do a real diff review of your own change — `git --no-pager diff` — against this checklist:

- **Correctness:** does it actually satisfy every acceptance criterion? Any off-by-one, unhandled
  null, or wrong async/order behavior?
- **Scope:** is everything in the diff necessary for this issue? Remove debug logs, dead code,
  stray files, and unrelated edits.
- **Security (OWASP-aware):** external input validated at the boundary; no injection
  (parameterized queries only); no secrets, raw API keys, or PII logged or returned; limits
  enforced on public/ingestion surfaces.
- **Privacy (ADR 0003):** no client-side persistent IDs, no PII by default.
- **Boundaries:** storage stays behind `@uptimizr/db`; no event shape redefined outside `@uptimizr/schema`.
- **Tests:** new behavior is covered; a fixed bug has a regression test.
- **Docs:** READMEs/`docs` updated if behavior changed; packaged `AGENTS.md`/`llms.txt` updated if
  a publishable package's API changed (ADR 0017); new ADR added if a decision changed.
- **Naming & clarity:** names match existing conventions; no `any` without justification.

If anything fails the review, fix it and re-review before moving on. For larger changes, consider
spawning a separate review pass (the repo `code-review` skill) for a second look.

## 6. Validate (the gate)

From the repo root:

```bash
pnpm format:check
pnpm exec turbo run lint --ui=stream
pnpm exec turbo run typecheck --ui=stream
pnpm exec turbo run build --ui=stream
pnpm exec turbo run test --ui=stream
```

All must pass. (CI is currently `workflow_dispatch`-only to conserve Actions minutes, so local
validation is the real gate — do not skip it.) Use `--ui=stream` for readable logs.

## 7. Commit & push

- **Conventional Commits**, scoped, imperative; reference the issue in the body or footer
  (e.g. `Implements #8` / `Fixes #12`). Keep commits coherent; do not bundle unrelated changes.
- Never use `--no-verify` or other safety bypasses. Push the branch and open a focused PR that
  describes the change and links the issue.

## 8. Document & close the issue (definition of done)

An issue is **done** only when all of the following hold — and the trail is recorded on the issue:

- Every acceptance-criteria checkbox in the issue is satisfied (tick them off).
- Tests for the new behavior exist and the full validation gate is green.
- Docs/ADRs updated where behavior or decisions changed.
- Change is committed with a Conventional-Commit message referencing the issue and pushed.
- Post a closing comment on the issue summarizing **what** changed, the **commit/PR** that did it,
  **how it was tested** (which suites + gate result), and any **follow-ups** (as new issues, not
  scope creep). Then close: `gh issue close <N> --comment "…"` (or let the merged PR close it via
  `Fixes #N`).

## Checklist

- [ ] Issue + acceptance criteria + linked ADR/phase doc read; plan posted as a comment
- [ ] Phase intent confirmed; scope is one discrete unit
- [ ] Branched from up-to-date `main`
- [ ] Change is minimal, in-scope, and respects boundaries/privacy/schema rules
- [ ] Tests added to match what changed (unit / endpoint / regression / E2E as applicable)
- [ ] Major/user-visible feature has a Playwright E2E under `examples/playground/e2e/` exercising
      the real round trip (incl. cross-origin and any retention/privacy-gated paths)
- [ ] Self-review done against the step-5 checklist (correctness, scope, security, privacy, docs)
- [ ] `pnpm format:check lint typecheck build test` all green
- [ ] Conventional commit referencing the issue; pushed; PR opened; no `--no-verify`
- [ ] Docs/ADRs and packaged `AGENTS.md`/`llms.txt` updated where needed
- [ ] Closing comment posted (what / commit / how tested / follow-ups); issue closed
