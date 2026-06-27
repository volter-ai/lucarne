---
name: pm
description: Dispatch PM work for a ztrack simple-gh-sdlc repository; use when running scheduled PM ticks, choosing develop work, enforcing WIP, or routing outcomes. Review is automatic on the PR.
---

# ztrack simple-gh-sdlc PM

Read:

- `standards/workflow.md` (WIP + dispatch rules)
- `standards/issue-and-evidence.md`

## The board is GitHub

Work items are **GitHub issues**, identified by their **number**. State lives on
GitHub — durable and visible to every stateless run — NOT in a local ztrack store:

- **ready to develop** = the issue is open, has the **`ready`** label, and has **no
  open agent PR** yet. (The `ready` label is set by `draft` or a maintainer; an
  issue's acceptance criteria live in its body in ztrack form.)
- **in review** = an open PR exists for the issue (branch `agent/issue-<n>`); the
  substrate's independent `reviewer` gates it (`ci` + `agent-review` → native
  auto-merge). You do not dispatch review.
- **done** = the PR merged (the issue auto-closes via `Closes #<n>`).
- **`needs-info` / `human-required`** = parked for a human; skip unless a human has
  since replied.

ztrack is the **acceptance gate on the issue's content**, not the board: `develop`
and `reviewer` run `ztrack check` against the issue's ACs + evidence. The PM reads
state from GitHub.

## Tick

This is an execution skill, not a status report. A tick is complete only after
exactly one eligible dispatch happened, or after you verified none is eligible.

You LAUNCH a worker through the Runner — the substrate-agnostic seam — passing the
**GitHub issue number** as the work item, and a **`--branch`** that ISOLATES the work:

```
bun scripts/runner.ts launch develop --ref <issue-number> --branch agent/issue-<issue-number>
```

`--branch` requests isolation explicitly: a local runner runs develop in that branch's
own worktree; the github runner isolates via its job checkout and ignores it (so the
same launch is substrate-agnostic). Name the branch `agent/issue-<issue-number>` — the
same branch the proposal lands on. This dispatches the worker (it fetches issue
`<issue-number>` as its subject). Never call `gh workflow run`/`termfleet` directly,
and never inline an agent. You launch develop only; the PR is reviewed and merged
without you.

1. **Gather GitHub state.**
   - Open issues: `gh issue list --state open --json number,title,labels,assignees`.
   - Open agent PRs: `gh pr list --state open --json number,headRefName,labels,statusCheckRollup,mergeable,mergeStateStatus`
     (a PR's `agent/issue-<n>` branch ties it to issue `<n>`).
   - In-flight develop runs: `bun scripts/runner.ts list develop`.
   - **For an issue you might rework** (its PR has a failed check or a conflict), read its **comment history**:
     `gh issue view <n> --json comments`. Your own prior `oa-rework:` marker comments are the ONLY record of
     how many times this issue has been reworked — without them you cannot honor the rework cap below.
2. **Respect WIP** from `workflow.md` (at most one develop in flight).
3. **Take exactly one action**, choosing the first eligible issue:
   - **Issue has an open agent PR** → it's in review. If its `agent-review` check is
     missing/pending and `ci` is not failing, leave it (the substrate triggers the
     reviewer on the PR). If a check **failed** or it has a **merge conflict**
     (`mergeStateStatus: DIRTY`), that's rework — but **ENFORCE THE CAP FIRST so a
     broken issue can't loop forever burning model spend**: read `max_develop_attempts`
     from `.open-autonomy/autonomy.yml` (default **2**) and count this issue's prior
     **rework relaunches** — the comments you (the bot) left that contain the exact marker
     line `oa-rework: <k>` (from the comments you fetched in step 1; count only your own,
     and only that marker — NOT initial-launch or in-review status comments).
     - **count ≥ the cap**, or the failure is unclear/repeating → do **NOT** relaunch.
       **Stop and escalate**: comment the situation and label the issue `human-required`.
     - **below the cap** with a clear, addressable failure → re-launch develop for that
       issue's number, and in the comment include the marker line `oa-rework: <count+1>`
       plus the exact failure to fix (the marker is how the next tick counts attempts).
     Never loop. Do NOT open a second PR for an issue that already has one.
   - **Issue is `ready` (label), open, and WIP allows** → before launching, confirm `agent/issue-<number>`
     has **no PR yet in ANY state**: `gh pr list --head "agent/issue-<number>" --state all --json number,state`.
     - A **merged** PR exists → the work is already done; the issue is merely auto-closing (a brief GitHub
       lag between merge and `Closes #<n>` taking effect). Do **NOT** relaunch — leave it; it will close.
       Relaunching here opens a **duplicate** PR for work that already merged.
     - An **open** PR exists → it's in review (handled by the open-PR case above), not fresh.
     - **No** PR in any state → it's fresh: launch the developer:
       `bun scripts/runner.ts launch develop --ref <number> --branch agent/issue-<number>`.
   - **Else** (no `ready` issue without a PR; or WIP full) → stop without dispatch.
4. Leave a short status comment on the issue you acted on (`gh issue comment <n>`),
   saying what you decided and why. Do not wait for the launched agent to finish.

Never implement, review, or mark ACs passed yourself — develop and reviewer do that.
Never launch `draft` from a scheduled tick unless a human explicitly asked this tick
to draft new work; when they do: `bun scripts/runner.ts launch draft --ref <number>`.
