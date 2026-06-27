#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { RUNNER_DEFAULTS } from './runner-defaults.mjs';
const agent = process.env.AUTONOMY_AGENT;
if (!agent) throw new Error('AUTONOMY_AGENT required');
const here = dirname(fileURLToPath(import.meta.url));
const runner = join(here, 'autonomy-runner.mjs');
const harness = process.env.TERMFLEET_AGENT || RUNNER_DEFAULTS.harness;
const env = { ...process.env, AUTONOMY_PROMPT_DIR: process.env.AUTONOMY_PROMPT_DIR || join(here, 'prompts', harness) };
const forward = (process.env.AUTONOMY_FORWARD || '').split(',').map((s) => s.trim()).filter(Boolean);
const params = forward.flatMap((k) => (process.env[k] ? ['--' + k, process.env[k]] : []));
// A cron agent (AUTONOMY_SINGLETON) is single-instance: skip this tick if one is already ACTIVELY in flight
// (running or awaiting-human), so fresh ticks don't pile up sessions while the prior one is still working —
// the local analogue of github's job concurrency. A finished/idle session does not block (it is reaped, and
// a fresh tick re-reads state), so the loop keeps ticking.
if (process.env.AUTONOMY_SINGLETON) {
  try {
    const all = JSON.parse(spawnSync('node', [runner, 'list'], { encoding: 'utf8' }).stdout || '[]');
    const busy = all.filter((s) => s.agent === agent && (s.status === 'running' || s.status === 'paused'));
    if (busy.length) { console.log(`[run-agent] ${agent} already in flight (${busy.length}); skipping this tick`); process.exit(0); }
  } catch { /* backend unavailable -> fall through and try the launch */ }
}
const timeout = Number(process.env.TERMFLEET_LAUNCH_TIMEOUT_MS || RUNNER_DEFAULTS.launchTimeoutMs);
const r = spawnSync('node', [runner, 'launch', agent, ...params], { stdio: 'inherit', timeout, env });
process.exit(r.error?.code === 'ETIMEDOUT' ? 0 : (r.status ?? 1));
