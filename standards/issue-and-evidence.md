# Issue And Evidence Standard

Read this from every simple-gh-sdlc skill.

## Issue Shape

- Work ztrack validates has `type:case` or `type:bug`.
- Non-canceled issues have an assignee.
- Bodies include `## Acceptance Criteria`; each checked AC carries its evidence inline (below).

## Acceptance Criteria

ACs must be observable, testable, and small enough to prove with a real commit.
Do not use subjective ACs like "code is clean".

## Checked AC Evidence

Evidence is **commit + proof** at its core (an image/artifact is optional). A
checked AC carries its evidence as **inline sub-bullets** pinned to a real git
commit. A checked AC with **no** evidence fails `check` (`checked_ac_no_evidence`).

Current grammar (what `ztrack check` verifies). In this GitHub-synced flow the issue is a **loose file in a
temp path outside the repo** (`ISSUE_MD="$(mktemp)"; gh issue view --json body --jq .body > "$ISSUE_MD"` —
never write `issue.md` into the tree; it must never enter a PR), not a local ztrack store, so you **edit
`$ISSUE_MD` by hand** — `ztrack ac patch` targets a stored tracker issue and does not apply here. Keep the
top `Assignee:` line and the existing AC ids; just fill in the evidence sub-bullets:

```markdown
- [x] dev/01 v1 API returns 409 for insufficient stock
  - status: passed
  - evidence ev1: commit=abc1234 acv=1
  - proof: "test covers the insufficient-stock branch" -> ev1
```

Mark an AC passed **with its evidence + proof together** — a checked/passed AC with no evidence fails
`check` (`passed_ac_missing_evidence`). Commit first (the SHA is the evidence), then hand-edit the AC's
sub-bullets in `$ISSUE_MD`:

```bash
git commit -m "…"          # -> <sha>; then in $ISSUE_MD, under the AC:
#   - [x] dev/01 v1 <text>
#     - status: passed
#     - evidence ev1: commit=<sha> acv=1     # (optional) add image=<path> for a committed artifact
#     - proof: "how the commit shows this AC is met" -> ev1
```

> `ztrack check`'s fix hints suggest `ztrack ac patch …` — that targets a **stored** tracker issue and does
> NOT apply to this loose-file GitHub-synced flow; hand-edit `$ISSUE_MD` as above instead.

Then run `ztrack check "$ISSUE_MD"`: it verifies each cited commit exists (and, when relevance is required, that
it touches the AC's declared paths), and that every passed AC's proof references real evidence.

Never invent commits, images, source text, or approvals. If evidence does not
exist, leave the AC pending (unchecked).
