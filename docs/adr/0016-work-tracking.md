# ADR 0016: Work tracking — GitHub Issues vs. Markdown docs

- **Status:** Accepted
- **Date:** 2026-06-17
- **Deciders:** RaananW

## Context

Uptimizr has tracked all planning and remaining work in Markdown under `docs/` — ADRs, phase
plans, design sketches, and ad-hoc checklists such as `docs/pre-release-requirements.md`. This is
excellent for narrative, ordered, and versioned content, but it is a poor fit for granular,
assignable, status-bearing work items:

- Markdown checkboxes cannot carry assignees, milestones, labels, or status across people.
- There is no link between a task and the commit/PR that resolved it.
- It gives external contributors no surface to report bugs or pick up work.

We are preparing to publish the repository publicly (see `docs/pre-release-requirements.md`), so a
public contribution and bug-tracking surface is required regardless. A private GitHub repository
now exists at `https://github.com/RaananW/Uptimizr` and is configured as the `origin` remote.

## Decision

Use **both**, with a clear split by content type. Markdown docs remain the source of truth for
_intent and decisions_; GitHub Issues become the tracker for _discrete, actionable work_.

| Content                                                  | Home                       | Rationale                                   |
| -------------------------------------------------------- | -------------------------- | ------------------------------------------- |
| Architecture decisions (ADRs)                            | Markdown (`docs/adr`)      | Immutable, append-only, versioned with code |
| Roadmap / phase plans                                    | Markdown (`docs/phases`)   | Narrative, ordered, reviewed via PR         |
| Pre-phase design sketches                                | Markdown (`docs/phases/*`) | Mutable thinking, not trackable tasks       |
| Discrete tasks, release blockers, bugs, feature requests | **GitHub Issues**          | Assignable, labelable, milestone-tracked    |
| Cross-cutting initiatives spanning many issues           | **GitHub Milestones**      | Group issues toward a dated goal            |

Rules of thumb:

- **Write it in Markdown** when the content is a decision, narrative, ordered plan, or design
  rationale that is reviewed through a PR and should live next to the code.
- **Open an Issue** when the work is a discrete, assignable unit with a state (open/closed), or
  when it is a bug or request that a contributor might pick up.
- Phase docs remain the **map**; issues are the **moving pieces**. An actionable line in a phase
  doc may become an issue that links back to the doc section, and the issue references the doc —
  not the other way around. Do not duplicate large task lists in both places.
- Significant decisions still get an ADR, even when the work itself is tracked as issues.

## Consequences

### Positive

- External contributors get the bug/feature surface expected of a public OSS repo.
- Discrete work gains assignees, labels, milestones, and commit/PR linkage.
- Decision history and roadmap narrative stay versioned with the code and reviewed via PR.

### Negative / trade-offs

- Two systems to keep coherent; risk of drift if task lists are duplicated. Mitigated by the
  "docs are the map, issues are the pieces" rule and by not duplicating task lists.
- Issues are mutable and can be edited or lost; anything meant to be a durable record belongs in
  an ADR, not an issue.

## Alternatives considered

- **Markdown only** — keeps everything versioned in one place, but offers no assignment, status,
  milestones, or contributor-facing bug tracker; unworkable for a public repo.
- **GitHub Issues (or Projects) only** — good for tasks, but a poor home for immutable decision
  records and ordered narrative plans that benefit from PR review and living beside the code.
