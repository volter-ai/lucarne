#!/usr/bin/env bun
// Deterministic reconcile: close every open issue whose linked PR has MERGED. GitHub's `Closes #n` keyword
// does not auto-close on bot-enabled auto-merge (see docs), and the bot merge fires no event to hook, so the
// close must happen on a periodic sweep — but it is mechanical WIRING, not a judgment, so it runs as a
// deterministic step (not in the PM model skill, which a model can skip). Run by the merge.yml code-host
// resource (dispatch + schedule), decoupled from any agent run; idempotent, so running it on every sweep is
// safe. Needs issues:write + GH_TOKEN, which the merge.yml job holds.
import { execFileSync } from 'node:child_process';

const repo = process.env.GITHUB_REPOSITORY;
if (!repo) {
  process.stderr.write('reconcile: no GITHUB_REPOSITORY — skipping\n');
  process.exit(0);
}
const gh = (args: string[]) => {
  try {
    return execFileSync('gh', args, { encoding: 'utf8' }).trim();
  } catch (e) {
    process.stderr.write(`reconcile: gh ${args.join(' ')} failed: ${e instanceof Error ? e.message : String(e)}\n`);
    return '';
  }
};

// Go from MERGED PRs to their issue. GitHub's `closedByPullRequestsReferences` does NOT reliably include a
// MERGED PR (it drops/relists it without a MERGED state once merged), so issue->link doesn't work. Instead
// use our own convention: a developer PR is on branch `agent/issue-<N>`, so the issue number is the branch.
// (Robust + independent of GitHub's flaky closing-keyword link tracking.) Idempotent: closing an already-
// closed issue is a no-op we skip.
const openSet = new Set<number>();
try {
  for (const it of JSON.parse(gh(['issue', 'list', '-R', repo, '--state', 'open', '--limit', '200', '--json', 'number']) || '[]') as { number: number }[]) {
    openSet.add(it.number);
  }
} catch {
  /* none */
}

let mergedPrs: { number: number; headRefName: string }[] = [];
try {
  mergedPrs = JSON.parse(gh(['pr', 'list', '-R', repo, '--state', 'merged', '--limit', '100', '--json', 'number,headRefName']) || '[]');
} catch {
  mergedPrs = [];
}

let closed = 0;
for (const pr of mergedPrs) {
  const m = /^agent\/issue-(\d+)$/.exec(pr.headRefName || '');
  if (!m) continue; // not an issue-bound developer PR (e.g. a strategist roadmap branch)
  const issue = Number(m[1]);
  if (!openSet.has(issue)) continue; // already closed (or no such open issue)
  gh(['issue', 'close', String(issue), '-R', repo, '-c', `Resolved by #${pr.number} (merged). Closed by the deterministic reconcile.`]);
  process.stdout.write(`reconcile: closed #${issue} (resolved by merged #${pr.number})\n`);
  closed++;
}
process.stdout.write(`reconcile: ${closed} issue(s) closed (${mergedPrs.length} merged PRs, ${openSet.size} open issues)\n`);
