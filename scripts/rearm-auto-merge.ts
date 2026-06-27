#!/usr/bin/env bun
// Deterministic re-arm: ensure every open agent-proposed PR has native auto-merge ARMED. The proposer dispatches
// merge.yml right after `pr create` to arm it, but that dispatch (and the arm itself) can miss transiently
// (GitHub is still computing the PR's mergeability) — and nothing an agent runs re-arms it: no agent holds
// contents:write, and the PM is forbidden to merge. Without this backstop a PR's checks go green with auto-merge
// never armed and it sits unmerged forever, so issues never close and the roadmap never advances. This sweep
// re-arms any agent PR missing it. It is mechanical WIRING, not judgment — it CANNOT bypass review: branch
// protection still requires ci + agent-review server-side, so `--auto` only ever lands a PR once those checks
// are green. Run by the merge.yml code-host resource (dispatch + schedule); idempotent — re-arming an
// armed/merged PR is a no-op.
import { execFileSync } from 'node:child_process';

const repo = process.env.GITHUB_REPOSITORY;
if (!repo) {
  process.stderr.write('rearm: no GITHUB_REPOSITORY — skipping\n');
  process.exit(0);
}

const gh = (args: string[]): string => {
  try {
    return execFileSync('gh', args, { encoding: 'utf8' }).trim();
  } catch (e) {
    process.stderr.write(`rearm: gh ${args.join(' ')} failed: ${e instanceof Error ? e.message : String(e)}\n`);
    return '';
  }
};
const ghOk = (args: string[]): boolean => {
  try {
    execFileSync('gh', args, { encoding: 'utf8', stdio: 'pipe' });
    return true;
  } catch {
    return false; // transient (mergeability still computing, conflict, …) → retried below / next sweep
  }
};
const sleep = (s: number): void => {
  try { execFileSync('sleep', [String(s)]); } catch { /* best-effort pacing */ }
};
// Arm with a bounded RETRY. Right after `pr create` GitHub reports mergeable=UNKNOWN for a few seconds, so a
// single `--auto` loses that race and the PR sits green-but-unarmed until the next scheduled sweep (~15 min).
// The proposer dispatches merge.yml on the hot path, so this sweep must ride out the UNKNOWN window itself —
// the same 6×retry the old inline arm had. Bounded + idempotent: a genuinely-stuck PR (conflict) just exhausts
// the retries and is caught next sweep; arming an already-armed/merged PR is a no-op.
const armWithRetry = (number: number): boolean => {
  for (let i = 0; i < 6; i++) {
    if (ghOk(['pr', 'merge', String(number), '-R', repo as string, '--squash', '--auto'])) return true;
    if (i < 5) sleep(4);
  }
  return false;
};

// An intentionally-held PR must not be re-armed. Branch protection's red required check already blocks a held
// PR from merging, but skipping these avoids needless churn and respects an explicit pause/hold.
const HOLD = new Set(['agent-paused', 'agent-maintainer-hold', 'human-required', 'do-not-merge']);
// Only ever touch agent-proposed branches — never a human's PR.
const AGENT_BRANCH = /^(agent|strategist)\//;

interface PR {
  number: number;
  headRefName: string;
  isDraft: boolean;
  autoMergeRequest: unknown | null;
  labels: { name: string }[];
}

let prs: PR[] = [];
try {
  prs = JSON.parse(gh(['pr', 'list', '-R', repo, '--state', 'open', '--limit', '100', '--json', 'number,headRefName,isDraft,autoMergeRequest,labels']) || '[]');
} catch {
  prs = [];
}

let armed = 0;
let skipped = 0;
for (const pr of prs) {
  if (pr.isDraft) { continue; }
  if (pr.autoMergeRequest) { continue; } // already armed
  if (!AGENT_BRANCH.test(pr.headRefName || '')) { continue; } // not an agent-proposed PR — leave human PRs alone
  if ((pr.labels || []).some((l) => HOLD.has(l.name))) { skipped++; continue; } // intentionally held
  if (armWithRetry(pr.number)) {
    process.stdout.write(`rearm: armed auto-merge on #${pr.number} (${pr.headRefName})\n`);
    armed++;
  } else {
    process.stdout.write(`rearm: could not arm #${pr.number} yet (${pr.headRefName}) — will retry next sweep\n`);
  }
}
process.stdout.write(`rearm: ${armed} PR(s) re-armed, ${skipped} held (${prs.length} open)\n`);
