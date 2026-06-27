// The LOCAL substrate's agent-facing Runner seam — the same interface the agents import on github
// (`launch`/`list`), realized through the local loop instead of `gh workflow run`. The agent code is
// identical across substrates; only THIS file differs. Tasks/artifact stay on gh regardless of
// substrate — the runner is the one seam.
//
// Like the github seam it is BOTH a module and a uniform agent-facing CLI, so a prose orchestrator (the
// PM) dispatches a worker the SAME way on every substrate:
//   bun scripts/runner.ts launch <agent> --ref <work-item>   # dispatch a worker on demand
//   bun scripts/runner.ts list   <agent>                     # its in-flight sessions (JSON)
// `--ref` is the work item (the `subject.ref` source); locally it is forwarded under the worker's OWN
// declared param name (e.g. ZTRACK_ISSUE) resolved from the manifest. Extra `--key value` pairs pass through.
//
// Two launch realizations, mirroring github's script-vs-skill split (a deterministic job vs the codex
// wrapper):
//   - a SCRIPT agent (behavior is a .ts/.mjs/.js) → run it via bun, with its declared trigger params
//     resolved from the launch params into env (the local analogue of github's workflow env mapping);
//   - a SKILL agent → a termfleet session via the launch adapter (run-agent.mjs → TermfleetRunner).
//
// Emitted verbatim by compileLocal as scripts/runner.ts so an agent's `import './runner.js'` resolves.
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, writeFileSync, appendFileSync, mkdirSync, symlinkSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

export interface LaunchParams {
  [key: string]: string | number;
}
export interface RunInfo {
  id: string;
  status: string;
  conclusion: string | null;
  title: string;
  ref?: string; // the work-item this session is isolated for (the issue number) — lets a caller dedup per issue
}

const scriptsDir = dirname(fileURLToPath(import.meta.url));
const isScript = (behavior: string): boolean => /\.(ts|mjs|js)$/.test(behavior);

interface ManifestAgent {
  skill?: string;
  params?: Record<string, string>;
  capabilities?: string[];
  review?: string; // the reviewer agent that judges this proposer's PRs (the merge-boundary review edge)
}

// --- post-session effects: the LOCAL mirror of github's post-skill job step --------------------------------
// On github, a proposer's job runs the propose effect (agent-propose) as a STEP after the skill step — same
// job, same checkout. Locally the session runs ASYNCHRONOUSLY in a termfleet window, so the launch process
// cannot run the effect; the loop's reaper observes the session finishing. So launch RECORDS a pending effect
// (keyed by the session's terminalId — the join key the reaper reports back), and the loop runs it once that
// session is gone (scheduler/run.mjs's reconcilePendingEffects). The effect is gated on two EXPLICIT, universal
// signals — never on a capability: (1) the launch was ISOLATED (a `--branch` was named — see below), and (2)
// the install targets a `github` CODE HOST (a declared IR signal; only there does a finished branch become a
// PR — a local-git code host has the PM merge worktrees, no PR). The runner never learns what the effect DOES
// — no issue/tracker/branch methodology re-enters it (architecture invariant `substrate-is-runner-only`).
const EFFECTS_DIR = '.open-autonomy/runner-state/effects';

// autonomy-runner prints the launched session as JSON ({ id: terminalId, agent, ... }) on its last output line.
export function terminalIdFromLaunch(stdout: string): string {
  for (const line of stdout.trim().split('\n').reverse()) {
    try {
      const o = JSON.parse(line) as { id?: unknown };
      if (o && typeof o.id === 'string') return o.id;
    } catch {
      /* not the JSON line */
    }
  }
  return '';
}
interface EffectMarker {
  id: string;
  agent: string;
  ref: string; // the work-item (issue number) this session is isolated for — surfaced in `list` for per-issue dedup
  worktree: string;
  effect: string;
  env: Record<string, string>;
}
function recordPostSessionEffect(marker: EffectMarker): void {
  mkdirSync(EFFECTS_DIR, { recursive: true });
  const file = join(EFFECTS_DIR, `${marker.id.replace(/[^0-9A-Za-z._-]/g, '-')}.json`);
  writeFileSync(file, `${JSON.stringify(marker, null, 2)}\n`);
}

// Pending post-session effects for an agent = work whose session FINISHED but whose effect (the propose) has
// not run yet — the window between a session being reaped and its PR being opened. `list` counts these as
// in-flight so a WIP/dedup check (the PM's) does not relaunch the proposer in that gap and double-propose.
function pendingEffects(agent: string): EffectMarker[] {
  try {
    return readdirSync(EFFECTS_DIR)
      .filter((f) => f.endsWith('.json'))
      .map((f) => {
        try {
          return JSON.parse(readFileSync(join(EFFECTS_DIR, f), 'utf8')) as EffectMarker;
        } catch {
          return null;
        }
      })
      .filter((m): m is EffectMarker => !!m && m.agent === agent);
  } catch {
    return []; // no markers dir yet
  }
}
function manifestAgent(agent: string): ManifestAgent {
  const path = '.open-autonomy/autonomy.yml';
  if (!existsSync(path)) return {};
  const m = Bun.YAML.parse(readFileSync(path, 'utf8')) as { agents?: Record<string, ManifestAgent> };
  return m.agents?.[agent] ?? {};
}

// The code host this install targets (a first-class IR signal, carried in the manifest) — `github` means a
// finished branch becomes a PR, so the runner runs the propose effect on completion; `local-git` means the PM
// merges worktrees, so there is no propose effect. Read once per launch to gate the post-session effect.
function manifestCodeHost(): string {
  const path = '.open-autonomy/autonomy.yml';
  if (!existsSync(path)) return '';
  const m = Bun.YAML.parse(readFileSync(path, 'utf8')) as { codeHost?: string };
  return m.codeHost ?? '';
}

// --- worktree isolation (local analogue of github's per-job fresh checkout) ---
// The PM ASSIGNS a branch and hands the SAME `--branch` to develop and review, so they share one isolated
// worktree; the runner just EXECUTES the branch it's given — it derives nothing and decides nothing. A
// launch with no `--branch` (the cron PM, the drafter) runs on the trunk checkout. The PM names the branch
// with the issue id (e.g. `agent/issue-<id>`) so ztrack check/loop auto-scope off the branch inside it.
const worktreePathFor = (branch: string): string => resolve('.worktrees', branch.replace(/[^0-9A-Za-z._-]/g, '-'));

function git(args: string[], cwd?: string): { status: number | null; stdout: string; stderr: string } {
  const r = spawnSync('git', args, { encoding: 'utf8', ...(cwd ? { cwd } : {}) });
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

// Create (or reuse) the worktree for the PM-assigned branch, from trunk HEAD. Idempotent: develop creates
// it, review (same `--branch`) joins it. node_modules is gitignored (lives only in the main checkout), so a
// fresh worktree has none — symlink it so the repo-pinned ztrack/preset-kit + agent CLIs resolve inside it.
// Ignore the Runner-created paths via the repo's COMMON `.git/info/exclude`, not `.gitignore`. info/exclude
// is shared by every worktree and is never committed, so it reliably covers a worktree's `node_modules`
// symlink regardless of what `.gitignore` that worktree's branch has checked out. (Appending to the main
// checkout's working-copy `.gitignore` does NOT reach a worktree, which sees its branch's committed version.)
// `node_modules` carries no trailing slash on purpose — a `node_modules/` dir pattern does NOT match the
// symlink the Runner creates, which would otherwise be staged by a worker's `git add -A` and merged onto trunk.
function ensureRunnerPathsIgnored(): void {
  const commonDir = git(['rev-parse', '--git-common-dir']).stdout.trim();
  if (!commonDir) return;
  const excludePath = join(resolve(commonDir), 'info', 'exclude');
  let present: string[] = [];
  try {
    present = readFileSync(excludePath, 'utf8').split('\n');
  } catch {
    /* no exclude file yet — created below */
  }
  const missing = ['.worktrees/', 'node_modules', '.open-autonomy/runner-state/'].filter((e) => !present.includes(e));
  if (missing.length) {
    mkdirSync(dirname(excludePath), { recursive: true });
    appendFileSync(excludePath, `${missing.join('\n')}\n`);
  }
}

function ensureWorktree(branch: string, worktree: string): void {
  if (existsSync(worktree)) return;
  ensureRunnerPathsIgnored();
  mkdirSync(dirname(worktree), { recursive: true });
  const branchExists = git(['rev-parse', '--verify', '--quiet', branch]).status === 0;
  const add = branchExists ? ['worktree', 'add', worktree, branch] : ['worktree', 'add', '-b', branch, worktree, 'HEAD'];
  const r = git(add);
  if (r.status !== 0) throw new Error(`git worktree add failed for ${branch}: ${r.stderr || r.stdout}`);
  const mainNodeModules = resolve('node_modules');
  const linkPath = join(worktree, 'node_modules');
  if (existsSync(mainNodeModules) && !existsSync(linkPath)) {
    try {
      symlinkSync(mainNodeModules, linkPath, 'dir');
    } catch {
      /* best-effort: a missing symlink just means the worktree falls back to global tools */
    }
  }
}

/** Launch an agent with forwarded params (agent:launch). */
export async function launch(agent: string, params: LaunchParams = {}): Promise<void> {
  const { skill: behavior = '', params: declared = {}, review = '' } = manifestAgent(agent);

  if (behavior && isScript(behavior)) {
    // Deterministic agent: run its script via bun. Resolve its declared trigger params from the launch
    // params — the launch's `issue_number` is the subject.ref (the work item); other documented sources
    // (subject.text/actor/…) are not available on a programmatic launch, so they resolve empty.
    const env: Record<string, string> = { ...(process.env as Record<string, string>) };
    for (const [name, source] of Object.entries(declared)) {
      env[name] = source === 'subject.ref' ? String(params.issue_number ?? '') : '';
    }
    spawnSync('bun', [behavior], { stdio: 'inherit', env });
    return;
  }

  // Skill agent: a termfleet session via the launch adapter (forwards params verbatim). ISOLATION is requested
  // EXPLICITLY: the caller names a `--branch` and the runner runs the session in that branch's worktree
  // (created/reused here). No `--branch` => run on the trunk checkout. The caller (the PM) decides who is
  // isolated and spells it out; the runner derives nothing and reads no capability. `--branch` is a
  // runner-control param, never forwarded to the agent. (github's runner isolates via the job checkout and
  // ignores `--branch`, so the same PM launch is substrate-agnostic.)
  const branch = typeof params.branch === 'string' && params.branch ? params.branch : '';
  const worktree = branch ? worktreePathFor(branch) : '';
  if (branch) ensureWorktree(branch, worktree);
  const names = Object.keys(params).filter((k) => k !== 'branch');
  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    AUTONOMY_AGENT: agent,
    AUTONOMY_FORWARD: [process.env.AUTONOMY_FORWARD, ...names].filter(Boolean).join(','),
    ...Object.fromEntries(names.map((k) => [k, String(params[k])])),
  };

  // An ISOLATED session on a github CODE HOST gets a post-session effect recorded: when the session finishes,
  // the loop turns that worktree into a PR (agent-propose) — the local mirror of github's post-skill propose
  // step. Gated on two explicit signals, never a capability: a worktree exists (a `--branch` was named) and
  // the install's code host is `github` (where finished branches become PRs). Capture the launch output to
  // learn the session's terminalId (the join key the reaper reports back); every other launch (the PM, the
  // drafter, a local-git worker, the reviewer) stays live (stdio inherit).
  if (worktree && manifestCodeHost() === 'github') {
    const r = spawnSync('node', [join(scriptsDir, 'run-agent.mjs')], { encoding: 'utf8', env, cwd: worktree });
    if (r.stdout) process.stdout.write(r.stdout);
    if (r.stderr) process.stderr.write(r.stderr);
    const id = terminalIdFromLaunch(r.stdout ?? '');
    if (id) {
      recordPostSessionEffect({
        id,
        agent,
        ref: /agent\/issue-(\d+)/.exec(branch)?.[1] ?? '', // the issue this session is isolated for
        worktree,
        effect: 'scripts/agent-propose.ts', // the github code host's publish effect (git + gh; runner-independent)
        env: {
          // ISSUE_REF derives from the worktree's branch so agent-propose checks out the SAME branch the
          // worker committed onto (`agent/issue-<n>`); the rest mirror github's propose-step env.
          ISSUE_REF: /agent\/issue-(\d+)/.exec(branch)?.[1] ?? '',
          AGENT_NAME: agent,
          AGENT_BOT_NAME: process.env.AGENT_BOT_NAME ?? 'open-autonomy-agent',
          AGENT_BOT_EMAIL: process.env.AGENT_BOT_EMAIL ?? 'open-autonomy-agent@users.noreply.github.com',
          // the review edge, realized through the RUNNER seam: agent-propose launches this agent for the PR
          // (local -> a termfleet reviewer session). github instead carries REVIEW_WORKFLOW; both resolve to
          // "launch the reviewer for this PR", the substrate-correct realization of develop's `review:` edge.
          REVIEW_AGENT: review,
          // The runner injects no repo identity: the effect resolves its own repo from the remote
          // (gh `{owner}/{repo}`), keeping the runner code-host-blind.
        },
      });
    } else {
      console.error(`[runner] ${agent}: launched but no terminalId in output; post-session propose not recorded`);
    }
    return;
  }
  spawnSync('node', [join(scriptsDir, 'run-agent.mjs')], { stdio: 'inherit', env, ...(worktree ? { cwd: worktree } : {}) });
}

/** List an agent's in-flight work (agent:list): live termfleet sessions PLUS pending post-session effects
 *  (a finished session whose propose has not run yet). Including the pending effects makes "in-flight" span
 *  the whole launch→propose lifecycle, so a WIP/dedup caller never relaunches the proposer in the reap→propose
 *  gap (which would open a duplicate PR). Deduped by id: while a session is live its marker.id == the session
 *  id, so it counts once; once reaped, only the marker remains; once proposed, the marker is gone (the PR
 *  exists, which the caller dedups on instead). */
export async function list(agent: string, _limit = 50): Promise<RunInfo[]> {
  const r = spawnSync('node', [join(scriptsDir, 'autonomy-runner.mjs'), 'list'], { encoding: 'utf8' });
  let sessions: Array<{ id: string; agent: string; status: string }> = [];
  try {
    sessions = JSON.parse(r.stdout || '[]');
  } catch {
    /* no sessions / backend unavailable */
  }
  return mergeInFlight(sessions, pendingEffects(agent), agent);
}

/** Merge live sessions + pending effects into one in-flight list for `agent`, deduped by id (a live session
 *  and its own pending marker are the same unit of work). Pure — the testable core of the race fix. */
export function mergeInFlight(
  sessions: Array<{ id: string; agent: string; status: string }>,
  pending: EffectMarker[],
  agent: string,
): RunInfo[] {
  const markerById = new Map(pending.filter((m) => m.agent === agent).map((m) => [m.id, m]));
  const live = sessions
    .filter((s) => s.agent === agent)
    .map((s) => ({ id: s.id, status: s.status, conclusion: null, title: s.agent, ...refOf(markerById.get(s.id)) }));
  const liveIds = new Set(live.map((s) => s.id));
  const pend = [...markerById.values()]
    .filter((m) => !liveIds.has(m.id)) // session already counted; don't double-count
    .map((m) => ({ id: m.id, status: 'proposing', conclusion: null, title: agent, ...refOf(m) }));
  return [...live, ...pend];
}
// Surface the isolated session's work-item (issue) so a caller can dedup per issue, not just per agent.
const refOf = (m?: EffectMarker): { ref?: string } => (m?.ref ? { ref: m.ref } : {});

// --- the uniform agent-facing CLI (same surface as the github seam) ---
function parseFlags(args: string[]): LaunchParams {
  const params: LaunchParams = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a?.startsWith('--')) {
      const key = a.slice(2);
      const next = args[i + 1];
      params[key] = next && !next.startsWith('--') ? (i++, next) : 'true';
    }
  }
  return params;
}

export async function runCli(argv: string[]): Promise<number> {
  const [cmd, agent, ...rest] = argv;
  if (!cmd || !agent || agent.startsWith('--')) {
    console.error('usage: runner.ts <launch|list|cancel> <agent|id> [--ref <work-item>] [--key value ...]');
    return 2;
  }
  if (cmd === 'cancel') {
    // `cancel <id>` — the positional is the session id (not an agent). Delegate to the backend's cancel.
    const r = spawnSync('node', [join(scriptsDir, 'autonomy-runner.mjs'), 'cancel', agent], { stdio: 'inherit' });
    return r.status ?? 0;
  }
  if (cmd === 'launch') {
    const flags = parseFlags(rest);
    // `--ref` is the work item (`subject.ref`); locally we forward it under the target's OWN declared
    // param name (the param whose source is `subject.ref`), so the worker reads e.g. $ZTRACK_ISSUE.
    if ('ref' in flags) {
      const { params: declared = {} } = manifestAgent(agent);
      const refParam = Object.entries(declared).find(([, src]) => src === 'subject.ref')?.[0];
      if (refParam) flags[refParam] = flags.ref;
      delete flags.ref;
    }
    await launch(agent, flags);
    return 0;
  }
  if (cmd === 'list') {
    console.log(JSON.stringify(await list(agent)));
    return 0;
  }
  console.error(`runner.ts: unknown command "${cmd}"`);
  return 2;
}

if (import.meta.main) process.exit(await runCli(process.argv.slice(2)));
