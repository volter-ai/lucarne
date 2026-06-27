---
name: develop
description: Implement one ztrack simple-gh-sdlc issue with evidence and push a branch for PR review; use when dispatched a Ready or rework issue by PM.
---

# ztrack simple-gh-sdlc Develop

Read:

- `standards/issue-and-evidence.md`
- `standards/risk-and-review.md`

Your work item is a **GitHub issue number** in `$ZTRACK_ISSUE`. Its acceptance
criteria live in the issue **body** (ztrack markdown). You implement the ACs,
**commit your work on `agent/issue-$ZTRACK_ISSUE`**, and record evidence back into
the issue body. The substrate opens the auto-merging PR for your committed branch;
the independent `reviewer` gates it (`ci` + `agent-review` → native auto-merge). You
never open the PR, request review, or merge.

## Procedure

1. `echo "$ZTRACK_ISSUE"` — stop if missing/empty. It is a GitHub issue **number**.
2. Read the issue into a **working file OUTSIDE the repo** (so it can never be committed into the PR):
   `ISSUE_MD="$(mktemp)"; gh issue view "$ZTRACK_ISSUE" --json body --jq .body > "$ISSUE_MD"` (the ACs
   are in `$ISSUE_MD`). Implement **only** its ACs. Stop with `OUTCOME: blocked human-required`
   if it needs a human-required path/topic from `risk-and-review.md`.
   **EDIT `$ISSUE_MD` in place — never rebuild it from scratch.** A loose-file `ztrack check` reads the
   `Assignee: <login>` line at the top of the body as the issue's owner; drop it and `check` fails
   `issue_missing_assignee` even with perfect evidence. Preserve that line (and the existing AC ids) verbatim.
3. Make sure your commits land on `agent/issue-$ZTRACK_ISSUE` so they become the PR. The runner may already
   have placed you on it (a local runner gives you an isolated worktree already on that branch); create it only
   if needed — don't fail if you're already there:
   `git checkout -b "agent/issue-$ZTRACK_ISSUE" 2>/dev/null || git checkout "agent/issue-$ZTRACK_ISSUE"`.
4. Implement. Verify with a **fast, TARGETED** check — the build/typecheck plus the specific test(s) your
   change affects (or a quick runtime spot-check). **Do NOT run the project's full/slow suite locally** (e.g.
   a browser/e2e suite that takes many minutes) — CI runs the full suite on the PR and is the real gate;
   running it in-session just doubles the wait. Accept a targeted check that exits 0.
5. **Commit your implementation — stage ONLY the files you changed for this issue, BY PATH.**
   **NEVER `git add -A` / `git add .`** — those sweep OA's own working files (the tracker's `.volter/`
   sync-state, any scratch, etc.) into the PR, which the reviewer will (correctly) reject as unrelated
   scope. Add your implementation file(s) and any evidence artifact you created, explicitly:
   `git add <path/to/changed-file> [<artifact> …] && git commit -m "feat: <what> (#$ZTRACK_ISSUE)"`.
   Capture `sha="$(git rev-parse HEAD)"`. Then sanity-check the diff is clean — `git show --stat HEAD`
   must list **only** your intended change (no `.volter/`, `.open-autonomy/`, `scripts/`, or other harness
   paths).
6. Record evidence **in `$ISSUE_MD`** for each genuinely satisfied AC — check the box,
   set `status: passed`, cite the commit + a proof (see `standards/issue-and-evidence.md`):
   ```
   - [x] dev/01 v1 <text>
     - status: passed
     - evidence ev1: commit=<sha> acv=1
     - proof: "how the commit shows this AC is met" -> ev1
   ```
   For an artifact, commit the file (stage it by path in step 5) and add `image=<path>` to the evidence
   line. A checked/passed AC with no real evidence fails `check` — never fabricate one.
7. **Gate locally:** `ztrack check "$ISSUE_MD"` (it validates the AC structure and that the
   cited commits exist — your commit from step 5 does). Iterate until it is green.
8. Push the updated ACs/evidence onto the GitHub **issue body** (the evidence of record — NOT a repo file):
   `gh issue edit "$ZTRACK_ISSUE" --body-file "$ISSUE_MD"`.
9. **Leave NO background process running**, then stop. Run every check in the FOREGROUND to completion;
   never start a watcher/dev-server/`&`-backgrounded job (`tsc --watch`, `npm run dev`, a server, a
   `run_in_background` shell) and walk away. A lingering shell keeps your session "running" so the substrate
   never sees you done — it won't open the PR and the issue stalls. If you backgrounded anything, kill it
   before ending. Then the substrate pushes `agent/issue-$ZTRACK_ISSUE`, opens the auto-merging PR
   (`Closes #$ZTRACK_ISSUE`), and triggers the reviewer — do not open the PR or merge.

Honest escape (never fake green): leave the AC unchecked and end `OUTCOME: blocked <reason>`,
descope it, or `ztrack waiver sign "$ISSUE_MD" --code <code> --reason "…"` (then re-push the body).

End with `OUTCOME: ready-for-review` (branch committed; PR will open) or `OUTCOME: blocked <reason>`.
Never merge — the boundary is `ci` + the reviewer's `agent-review`, landed by native auto-merge.
