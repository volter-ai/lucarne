#!/usr/bin/env bun
// The github-code-host PROPOSE effect — what a `code:propose` agent DOES after its skill runs: turn the
// working tree into an auto-merging PR. This is agent methodology, deterministic (mechanical wiring a model
// must not skip), and runner-INDEPENDENT: it uses git + gh, which behave identically whether the agent was
// launched by GitHub Actions or by a local termfleet window. The RUNNER only provides the credential + env;
// this script (agent-owned) performs the propose. It used to be inline shell in substrate-github's emitted
// workflow — that conflated agent methodology into the runner (docs/CODE_HOST_RESOURCES.md, the runner=launch
// principle). Now the runner just invokes it.
//
// Env (the runner supplies these; GITHUB_* are ambient on Actions, set explicitly by the local runner):
//   ISSUE_REF        work-item ref the trigger forwarded (empty for an autonomous/cron proposer)
//   AGENT_NAME       the agent's name (for the run-history folder + commit/PR title)
//   AGENT_BOT_NAME   / AGENT_BOT_EMAIL   git author identity for the agent-proposed commit
//   REVIEW_WORKFLOW  the reviewer's workflow to dispatch on github (empty if no review edge / non-github runner)
//   REVIEW_AGENT     the reviewer AGENT to launch via the runner seam (a local runner's review-edge realization)
//   GH_TOKEN, GITHUB_RUN_ID  (the repo is resolved from the remote via gh's {owner}/{repo} placeholders)
import { execFileSync } from 'node:child_process';

const env = process.env;
const ref = (env.ISSUE_REF ?? '').trim();
const agentName = env.AGENT_NAME || 'agent';
const runId = env.GITHUB_RUN_ID || '0';
const rid = `ir-${agentName}-${runId}`;
const reviewWorkflow = (env.REVIEW_WORKFLOW ?? '').trim();
const reviewAgent = (env.REVIEW_AGENT ?? '').trim();
const isNumericRef = /^[0-9]+$/.test(ref);
const branch = ref ? `agent/issue-${ref}` : `agent/${rid}`;

const sh = (cmd: string, args: string[], opts: { allowFail?: boolean } = {}): string => {
  try {
    return execFileSync(cmd, args, { encoding: 'utf8' }).trim();
  } catch (e) {
    if (opts.allowFail) return '';
    throw e;
  }
};
const ok = (cmd: string, args: string[]): boolean => {
  try {
    execFileSync(cmd, args, { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
};
const sleep = (s: number) => { try { execFileSync('sleep', [String(s)]); } catch { /* pacing */ } };
// Dispatch a code-host workflow with retry — a bot-opened PR fires no pull_request event (GITHUB_TOKEN
// anti-recursion), so ci/agent-review/merge are kicked here; a swallowed dispatch leaves a required check
// unposted and the PR permanently unmergeable, so retry until it lands.
const dispatch = (label: string, args: string[]): void => {
  for (let i = 0; i < 6; i++) { if (ok('gh', ['workflow', 'run', ...args])) return; sleep(4); }
  process.stdout.write(`${label} dispatch failed after retries (non-fatal)\n`);
};

// Deterministic dedup backstop: if this branch ALREADY has a merged PR, the work has landed — never open a
// duplicate. (A proposer can be relaunched in the lag between a PR merging and its `Closes #<n>` auto-closing
// the issue; this guard stops the second run from opening a redundant PR for already-merged work.)
if (isNumericRef && sh('gh', ['pr', 'list', '--head', branch, '--state', 'merged', '--json', 'number', '--jq', '.[0].number // empty'], { allowFail: true })) {
  process.stdout.write(`branch ${branch} already has a merged PR; nothing to propose\n`);
  process.exit(0);
}

// Propose only if the skill left changes OR already committed onto its own agent branch (the ztrack SDLC
// cites the commit SHA as evidence). Bail when the tree is clean AND no such branch exists.
const dirty = sh('git', ['status', '--porcelain'], { allowFail: true }).length > 0;
const branchExists = ok('git', ['rev-parse', '--verify', branch]);
if (!dirty && !branchExists) {
  process.stdout.write('no changes and no agent branch; nothing to propose\n');
  process.exit(0);
}

sh('git', ['config', 'user.name', env.AGENT_BOT_NAME || 'open-autonomy-agent']);
sh('git', ['config', 'user.email', env.AGENT_BOT_EMAIL || 'open-autonomy-agent@users.noreply.github.com']);
sh('git', ['config', 'core.filemode', 'false']);
ok('git', ['checkout', branch]) || sh('git', ['checkout', '-b', branch]);

// Persist this run's transcript + visual evidence INTO the proposal so they ride into the PR and become
// permanent history only if it merges (each run its own folder; Actions artifacts expire in 30 days).
const refSlug = (ref.replace(/[^0-9A-Za-z._-]/g, '').slice(0, 40)) || (ref ? 'item' : 'autonomous');
const runDir = `.open-autonomy/history/${agentName}/${refSlug}-run-${runId}`;
sh('mkdir', ['-p', runDir]);
sh('bash', ['-c', `cp -f .agent-run/artifacts/transcript.md "${runDir}/transcript.md" 2>/dev/null || true`]);
sh('bash', ['-c', `cp -f .agent-run/artifacts/screenshot-* "${runDir}/" 2>/dev/null || true`]);
sh('git', ['add', '-A']);

// Closing keyword in the COMMIT (squash-merge carries it reliably; a PR-body keyword alone is dropped when
// the repo squashes from the commit message) — only when the subject is an issue number.
const commitArgs = ['commit', '--allow-empty', '-m', `agent: ${rid}`];
if (isNumericRef) commitArgs.push('-m', `Closes #${ref}`);
sh('git', commitArgs);
sh('git', ['push', '--force', 'origin', branch]);

// Resolve the repo through gh's `{owner}/{repo}` placeholders (filled from the remote) — works ambiently on
// GitHub Actions AND a local runner, so this effect needs no injected GITHUB_REPOSITORY.
const base = sh('gh', ['api', 'repos/{owner}/{repo}', '--jq', '.default_branch'], { allowFail: true }) || 'main';
let body = sh('bash', ['-c', 'cat .agent-run/artifacts/pr.md 2>/dev/null || true'], { allowFail: true }) || `Automated agent change (${rid}).`;
if (isNumericRef) body = `Closes #${ref}\n\n${body}`;
if (!ok('gh', ['pr', 'create', '--base', base, '--head', branch, '--title', `Agent: ${rid}`, '--body', body])) {
  ok('gh', ['pr', 'view', branch]); // already exists — fine
}

// Arm native auto-merge via the merge.yml code-host resource (it holds the merge mechanics; the proposer
// only kicks it, exactly as it kicks ci/agent-review). merge.yml's schedule is the backstop.
dispatch('merge', ['merge.yml']);

const headSha = sh('git', ['rev-parse', 'HEAD'], { allowFail: true });
const prNumber = sh('gh', ['pr', 'view', branch, '--json', 'number', '--jq', '.number'], { allowFail: true });
dispatch('ci', ['ci.yml', '--ref', branch, '-f', `sha=${headSha}`, '-f', `pr=${prNumber}`]);
// Trigger the review edge. A bot-opened PR fires no pull_request event, so the proposer KICKS the reviewer
// itself. Either form resolves to "launch the reviewer for this PR" through the Runner seam, the
// substrate-correct realization of develop's `review:` edge: github carries REVIEW_WORKFLOW and dispatches
// it as a workflow; a local runner carries REVIEW_AGENT and launches a termfleet reviewer session via the
// same `runner.ts launch` the PM uses. (`runner.ts launch <reviewer> --ref <pr>` on github would itself
// `gh workflow run reviewer.yml -f issue_number=<pr>`, so the two are equivalent; we keep both env forms so
// the proven github path dispatches exactly as before.)
if (reviewWorkflow) dispatch('review', [reviewWorkflow, '-f', `issue_number=${prNumber}`]);
else if (reviewAgent && prNumber) {
  for (let i = 0; i < 6; i++) {
    if (ok('bun', ['scripts/runner.ts', 'launch', reviewAgent, '--ref', prNumber])) break;
    sleep(4);
  }
}
dispatch('human-approval', ['human-approval.yml', '-f', `pr=${prNumber}`]);
