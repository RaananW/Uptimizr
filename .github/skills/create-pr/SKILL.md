---
name: create-pr
description: Open a pull request against the Uptimizr repo so it passes CI on the first run. Reproduces every PR gate locally (format, audit, license, lint, typecheck, build, test, changeset, scrub-gate, secret-scan, CodeQL) before pushing, then opens a focused PR that fills the template. USE FOR: creating a PR, opening a pull request, submitting a change for review, preparing a branch for merge, avoiding red CI on a PR. Trigger phrases: create a PR, open a pull request, submit this change, raise a PR, get my branch ready to merge, why is my PR failing CI.
---

# Skill: Create a pull request that passes CI

The repeatable way to open an Uptimizr PR that goes **green on the first CI run**. Every check
that CI enforces is reproducible locally — an agent must run them all and fix every failure
**before** pushing. A red PR wastes Actions minutes and review cycles; treat that as a defect.

Follow the repo golden rules throughout (`AGENTS.md`): keep `oss/` self-contained, define events
once in `@uptimizr/schema`, stay privacy-first, validate at boundaries, keep backends thin, and
record significant decisions as ADRs.

## What CI runs on every PR

The PR workflow (`.github/workflows/pr.yml`) has six gates; CodeQL runs separately
(`.github/workflows/codeql.yml`). All must pass:

| Gate (CI job)   | What it runs                                                                      | Reproduce locally                                                          |
| --------------- | --------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| **checks**      | `pnpm format:check`, `pnpm audit --prod --audit-level=high`, `pnpm license-check` | same commands                                                              |
| **build**       | `pnpm lint`, `pnpm typecheck`, `pnpm build`, `pnpm test`                          | same commands                                                              |
| **changeset**   | requires a new `.changeset/*.md` (not README) added vs `main`                     | `pnpm changeset` (or `--empty`)                                            |
| **scrub-gate**  | `bash scripts/scrub-gate.sh` — no reserved non-OSS tokens leak in                 | `pnpm scrub-gate`                                                          |
| **secret-scan** | `gitleaks detect` over **full history** — no secrets committed                    | `gitleaks detect --source . --log-opts="--all" --redact -v` (if installed) |
| **CodeQL**      | static security analysis of JS/TS                                                 | covered by lint + a clean self-review                                      |

## 1. Confirm the branch and scope

- One change → one focused branch/PR. Branch from up-to-date `main`:
  `git switch main && git pull && git switch -c <type>/<short-slug>`
  (e.g. `feat/mcp-server`, `fix/pointer-throttle`, `docs/og-card`). Never open a PR from `main`.
- Keep the diff in scope: no drive-by refactors, no out-of-scope scope creep, no stray files. Review it:
  `git --no-pager diff main...HEAD`.

## 2. Add a changeset (always required)

Every PR **must** add a changeset, or the `changeset` gate fails. (The only exception is the bot's
`changeset-release/main` branch, which agents never push to.)

- Change touches a publishable `@uptimizr/*` package → `pnpm changeset`, pick the affected
  packages + bump (`patch` / `minor` / `major`), write a one-line summary.
- Change needs no release note (docs, CI, examples, private apps) → `pnpm changeset --empty`,
  then write the summary line into the generated file (an empty `--empty` changeset has frontmatter
  `---\n---` and a body line; match the existing files in `.changeset/`).
- **Format the changeset before committing.** `.changeset/*.md` is markdown and is checked by the
  `format:check` gate, but `pnpm changeset` output — and any summary line you hand-edit in — is
  frequently **not** Prettier-clean (trailing space, missing final newline, wrong wrapping). This
  is a common cause of a red `Format, audit, license` job on an otherwise-good PR. Run
  `pnpm exec prettier --write ".changeset/*.md"` (or `pnpm format`) right after creating/editing
  the changeset, then re-check with `pnpm exec prettier --check ".changeset/*.md"`.
- Commit the changeset file with the change. Verify one exists:
  `ls .changeset/*.md | grep -v README` shows a new file.

## 3. Run the scrub gate

The public repo must not leak tokens reserved for non-OSS variants:

```bash
pnpm scrub-gate
```

If it fails, the offending token is in the diff — remove it (don't add it to the allow-list unless
it's a genuine false positive in a comment, and even then prefer rewording).

## 4. Don't commit secrets (gitleaks scans full history)

The secret-scan gate runs `gitleaks` over the **entire git history**, not just the diff — so a
secret in any commit on the branch fails the PR even if a later commit removes it.

- Never commit real keys, tokens, connection strings, or `.env` files. Use placeholders/fixtures.
- If a secret was committed earlier on the branch, rebase/amend it out of history (not just delete
  in a new commit) before pushing. If `gitleaks` is installed locally, run
  `gitleaks detect --source . --log-opts="--all" --redact --no-banner -v` to confirm clean.

## 5. Run the full validation gate

From the repo root, run every build/checks-job command and make them all pass:

```bash
pnpm format:check
pnpm audit --prod --audit-level=high
pnpm license-check
pnpm exec turbo run lint --ui=stream
pnpm exec turbo run typecheck --ui=stream
pnpm exec turbo run build --ui=stream
pnpm exec turbo run test --ui=stream
```

- `format:check` red → run `pnpm format` and re-commit. The most common offender is a freshly
  created `.changeset/*.md`; new/edited docs and JSON are next. `format:check` covers **every**
  tracked `**/*.{ts,tsx,js,jsx,json,md,yml,yaml}`, including the changeset you just added.
- `audit` red → a production dependency has a high+ advisory; bump/replace it or, if it's a
  documented false positive, follow the repo's audit handling (see `npm-audit-notes`). Do not
  weaken the audit level.
- `lint` / `typecheck` red → fix the code; never use `eslint-disable` or `@ts-ignore` to silence a
  real problem, and never bypass with `--no-verify`.
- Add/extend a **Playwright E2E** under `examples/playground/e2e/` for any user-visible feature or
  new full-stack path (`pnpm --filter @uptimizr/example-playground test:e2e`); CI doesn't gate it,
  but the definition of done (see `work-on-issue`) requires it.

## 6. Docs in the same change

A feature isn't done until it's documented (golden rule 8). Before opening the PR, confirm any new
feature/option/event/endpoint is reflected in the public docs site (`oss/apps/docs`) and the
integration/API reference (`docs/integration.md`), and that a new **ADR** captures any significant
decision. Update packaged `AGENTS.md`/`llms.txt` if a publishable package's API changed (ADR 0017).

## 7. Self-review, commit, push

- Self-review the diff against the `work-on-issue` step-5 checklist (correctness, scope, security
  OWASP-aware, privacy ADR 0003, boundaries, tests, docs, naming).
- **Conventional Commits**, scoped and imperative (`feat(playground): …`, `fix(db): …`,
  `docs(adr): …`, `chore(ci): …`). Reference the issue in the body/footer (`Closes #123`). Never
  `--no-verify`.
- Push: `git push -u origin HEAD`.

## 8. Open the PR and fill the template

Open the PR with `gh` and fill `.github/PULL_REQUEST_TEMPLATE.md` — don't leave it as the raw
comment skeleton:

```bash
gh pr create --base main --title "<conventional title>" --body "<filled template>"
```

In the body:

- **Summary** — what changed and why.
- **Linked issue** — `Closes #<n>` (so the merge closes it).
- **Type of change** — tick the right box.
- **Checklist** — only tick boxes that are actually true: `lint typecheck build test` pass locally;
  docs updated; changeset added; E2E added/updated for user-visible features; ADR added where
  significant.
- **AI-assisted contribution** — if an agent authored the change with little human review, tick
  "This PR was generated primarily by an AI agent" (CONTRIBUTING.md transparency rule).

## 9. Watch CI and fix red fast

After opening, confirm the run is green: `gh pr checks --watch`. If any gate fails, map it back to
the table above, reproduce it locally, fix it, and push again — don't leave a red PR open.

## Pre-push checklist

- [ ] Focused branch off up-to-date `main`; diff reviewed and in scope
- [ ] Changeset added (`pnpm changeset` or `--empty`), **Prettier-formatted**, and committed
- [ ] `pnpm scrub-gate` passes
- [ ] No secrets anywhere in branch history (gitleaks-clean)
- [ ] `format:check`, `audit --prod --audit-level=high`, `license-check` all pass
- [ ] `lint`, `typecheck`, `build`, `test` all pass
- [ ] Playwright E2E added/updated for user-visible features
- [ ] Docs / `docs/integration.md` / ADR / packaged `AGENTS.md`+`llms.txt` updated where applicable
- [ ] Conventional-commit messages referencing the issue; no `--no-verify`
- [ ] PR template fully filled (summary, linked issue, type, checklist, AI-assisted box)
- [ ] `gh pr checks` green
