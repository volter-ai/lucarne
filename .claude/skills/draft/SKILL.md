---
name: draft
description: Draft verifiable ztrack simple-gh-sdlc issues from requests; use when converting an unshaped GitHub issue into a Ready issue with acceptance criteria.
---

# ztrack simple-gh-sdlc Draft

Read:

- `standards/issue-and-evidence.md`

Your work item is a **GitHub issue number** in `$ZTRACK_ISSUE`. You shape that
existing issue **in place** into a verifiable Ready work item: rewrite its body into
ztrack form (summary + acceptance criteria) and mark it ready with the **`ready`**
label. Never open a new issue — drafting *transitions* the request, keeping its number
(which is its identity and PR cross-reference).

## Procedure

1. `echo "$ZTRACK_ISSUE"` — stop if missing/empty. It is a GitHub issue **number**.
2. Read the raw request: `gh issue view "$ZTRACK_ISSUE" --json title,body,comments`.
3. Compose `issue.md` (start from `ztrack issue scaffold --title "<title>" > issue.md`): a
   source-grounded summary and 1-3 ACs that are each observable and provable by a commit.
   Put an `Assignee: <login>` line at the very top (the assignee the GitHub issue will carry —
   `ztrack check` on a body file reads it from there). Leave the ACs **unchecked** — develop
   adds the evidence later; do not pre-create evidence.
4. Validate the shape: `ztrack check issue.md` (it must parse + accept the ACs).
5. Update the GitHub issue **in place** and mark it ready:
   - `gh issue edit "$ZTRACK_ISSUE" --body-file issue.md` (refine the title with `--title "<refined>"` if vague),
   - `gh issue edit "$ZTRACK_ISSUE" --add-label ready` (the PM dispatches develop on `ready` issues),
   - assign it: `gh issue edit "$ZTRACK_ISSUE" --add-assignee @me` (or the requesting maintainer).
6. If the request is too vague to shape into provable ACs, do NOT mark it ready: comment the
   specific questions and add the `needs-info` label instead.

End with `OUTCOME: drafted` (issue is `ready` + has ACs) or `OUTCOME: blocked <reason>`.
