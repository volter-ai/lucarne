# Workflow Standard

Read this from the PM and Reviewer skills.

## The board is GitHub

Work items are **GitHub issues** (identified by number). State is **GitHub-native** —
durable across stateless runs — not a local ztrack store. ztrack is the acceptance
**gate** on each issue's content (the ACs + evidence in its body), not the board.

| State | How it is represented on GitHub |
|---|---|
| `draft` | open issue, **no** `ready` label (a raw request not yet shaped) |
| `ready` | open issue with the **`ready`** label + acceptance criteria in its body |
| in progress | a `develop` run is in flight (`runner.ts list develop`) — no separate marker needed |
| in review | an **open PR** on branch `agent/issue-<n>` (the substrate triggers the `reviewer` on it) |
| `done` | the **PR merged** (issue auto-closes via `Closes #<n>`) |
| parked | the `needs-info` or `human-required` label (waiting on a human) |

## WIP

- **At most one develop in flight.** The PM reads `runner.ts list develop` + the open agent PRs and does
  not launch a second developer while one is running or an issue already has an open PR.
- PM is the only dispatcher — it launches `develop` (and `draft` on request) **by issue number**; it does
  NOT dispatch review.
- The developer handles one issue, commits on `agent/issue-<n>`, and stops; the substrate opens the
  auto-merging PR (`Closes #<n>`) and triggers the independent `reviewer`.
- **Review is on the PR**: the `reviewer` posts the `agent-review` status. `ci` + `agent-review` green →
  native auto-merge lands it (done = merged PR). Never an agent merge.
- **Rework**: a `changes-requested` review leaves the PR open with the failure noted; the PM re-launches
  develop for that issue's number. The PM **caps rework at `max_develop_attempts`** (`.open-autonomy/autonomy.yml`,
  default **2**) by counting its own prior `oa-rework:` marker comments on the issue, and **escalates to `human-required`
  at the cap** instead of relaunching — so a permanently-failing issue can't loop and burn spend. Never loop.

## Gates

`develop` and `reviewer` run `ztrack check` against the issue body (`gh issue view <n> --json body --jq .body
> issue.md; ztrack check issue.md`) before every handoff. The reviewer cannot pass a red issue. Done is only
reached when the PR merges with all ACs passed-with-evidence and `ci` + `agent-review` both green.
