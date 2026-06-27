#!/usr/bin/env node
import { readFileSync, readdirSync, unlinkSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const SCHEDULE = process.env.AUTONOMY_SCHEDULE || 'scheduler/schedule.json';
const args = process.argv.slice(2);
const schedule = JSON.parse(readFileSync(SCHEDULE, 'utf8'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fireTick = () => {
  for (const command of schedule.scripts) {
    spawnSync(command, { shell: true, stdio: 'inherit', env: Object.assign({}, schedule.env, process.env) });
  }
};

if (args.includes('--once')) {
  fireTick();
  process.exit(0);
}

// Continuous mode: a fast heartbeat that fires ticks on the schedule interval and reaps idle sessions in
// between. The runner (termfleet SDK) does the reaping; we keep the persistent idle-since map here.
const here = dirname(fileURLToPath(import.meta.url));
const IDLE_REAP_MS = Number(process.env.AUTONOMY_IDLE_REAP_MS ?? 60000);
const POLL_MS = Math.max(1000, Number(process.env.AUTONOMY_REAP_POLL_MS ?? 20000));
const intervalMs = Number(schedule.intervalSeconds) * 1000;
// This install's OWN agents = the per-harness launch prompts (one .txt per skill agent). Reaping is
// scoped to these window names so a human's own terminal / another loop is never touched.
const harness = process.env.TERMFLEET_AGENT || 'claude';
let agents = new Set();
try {
  agents = new Set(
    readdirSync(join(here, '..', 'scripts', 'prompts', harness)).filter((f) => f.endsWith('.txt')).map((f) => f.slice(0, -4)),
  );
} catch {}
let runner = null;
try {
  ({ runner } = await import(join(here, '..', 'scripts', 'autonomy-runner.mjs')).then((m) => ({ runner: new m.TermfleetRunner() })));
} catch (e) {
  console.error('[loop] reaping disabled (runner unavailable):', e?.message ?? e);
}

// Post-session effects: the local mirror of github's post-skill job step. The runner's launch seam
// (scripts/runner.ts) records a pending effect per code:propose session — keyed by terminalId — under
// runner-state/effects. When that session is GONE from the runner's live list (finished + reaped), run its
// recorded effect in its worktree and retire the marker. Domain-free: the loop runs "<effect> in <worktree>",
// never any issue/tracker logic (it replaces the old propose-sweep, which scanned worktrees + reconstructed
// SDLC state — a methodology leak). Crash-safe: a marker outlives a missed reap and is reconciled on a later
// tick, and agent-propose is idempotent (it updates the same branch/PR); the marker is deleted once it runs.
const EFFECTS_DIR = join(here, '..', '.open-autonomy', 'runner-state', 'effects');
async function reconcilePendingEffects(runner) {
  let files = [];
  try { files = readdirSync(EFFECTS_DIR).filter((f) => f.endsWith('.json')); } catch { return; } // no markers dir yet
  if (!files.length) return;
  let live;
  try { live = new Set((await runner.list()).map((s) => s.id)); } catch { return; } // liveness unknown -> wait a tick
  for (const file of files) {
    const path = join(EFFECTS_DIR, file);
    let marker;
    try { marker = JSON.parse(readFileSync(path, 'utf8')); } catch { try { unlinkSync(path); } catch {} continue; }
    if (live.has(marker.id)) continue; // session still running -> its effect runs after it finishes
    console.log(`[loop] post-session effect: ${marker.agent} (${marker.id}) -> ${marker.effect} in ${marker.worktree}`);
    spawnSync('bun', [marker.effect], { cwd: marker.worktree, stdio: 'inherit', env: Object.assign({}, process.env, marker.env) });
    try { unlinkSync(path); } catch {}
  }
}
const idleSince = new Map();
let lastTick = 0;
while (true) {
  const now = Date.now();
  if (now - lastTick >= intervalMs) {
    fireTick();
    lastTick = Date.now();
  }
  if (runner) {
    try {
      const reaped = await runner.reapIdle({ idleMs: IDLE_REAP_MS, agents, since: idleSince });
      for (const r of reaped) console.log(`[loop] reaped idle ${r.agent} (${r.id})`);
      await reconcilePendingEffects(runner); // run finished proposers' effects (the post-skill step's local twin)
    } catch (e) {
      console.error('[loop] reap error:', e?.message ?? e);
    }
  }
  await sleep(POLL_MS);
}
