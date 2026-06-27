#!/usr/bin/env node
// The autonomy runner (substrate primitive), vendored into this profile. Drives termfleet through its
// SDK (the `termfleet` npm package), not a `termfleet` binary on PATH. Its entire knowledge is: agents,
// running agents, and their lifecycle. It knows nothing about what an agent does or works on — no
// "issues", no states. That lives entirely in the agents (skills) and the profile's scripts.
//
// This is a plain-JS port of @open-autonomy/substrate-local's runner.ts (TermfleetRunner) + the core CLI.
// Keep the two in sync. The install must have `termfleet` (+ `@termfleet/core`) in node_modules.
//
//   launch <agent> [--k v ...]  ·  get <id>  ·  list  ·  update <id> --status <s>  ·  cancel <id>
//
// `launch` accepts arbitrary --key value params and passes them through verbatim; the system never
// interprets them (a profile gives them meaning, e.g. a ztrack-using profile declares ZTRACK_ISSUE).
import { existsSync, readFileSync } from 'node:fs';
import { ProviderClient, providerRefFromUrl } from 'termfleet';
import { resolveDefaultProvider } from '@termfleet/core/local-providers.js';
import { RUNNER_DEFAULTS } from './runner-defaults.mjs';

// Real local backend: drives termfleet via its ProviderClient SDK. The window name IS the agent; the
// system never encodes anything else into it. Defaults come from RUNNER_DEFAULTS; TERMFLEET_* override.
export class TermfleetRunner {
  harness = process.env.TERMFLEET_AGENT || RUNNER_DEFAULTS.harness; // claude|codex|gemini — the coding CLI, not our agent
  #clientPromise;
  #client() {
    return (this.#clientPromise ??= resolveDefaultProvider({ url: process.env.TERMFLEET_PROVIDER_URL }).then(
      (p) => new ProviderClient(providerRefFromUrl(p.baseUrl)),
    ));
  }

  async launch(agent, params = {}) {
    const client = await this.#client();
    // Re-export orchestration context so a nested `autonomy launch ...` reaches this provider, plus the
    // opaque params verbatim (a profile may read e.g. $ZTRACK_ISSUE; the system doesn't).
    // Re-export orchestration context so a nested `autonomy launch ...` reaches this provider, plus the
    // opaque params verbatim (a profile may read e.g. $ZTRACK_ISSUE; the system doesn't). The runner stays
    // CODE-HOST-BLIND: it injects no github/repo identity — a code-host agent resolves its own repo through
    // its own tool (e.g. `gh api repos/{owner}/{repo}/…`, which `gh` fills from the remote).
    const exported = {
      ...Object.fromEntries(Object.entries(process.env).filter(([k]) => /^(TERMFLEET_.*|AUTONOMY.*|PATH)$/.test(k))),
      ...params,
    };
    // Put the repo's local node_modules/.bin first so the agent reaches repo-pinned CLIs (e.g. a `-D`
    // ztrack) — exactly what `npm run`/`bun run` do, without the substrate naming any tool. cwd is the
    // repo (createAgentWindow runs the session there), so this is where its node_modules lives.
    exported.PATH = `${process.cwd()}/node_modules/.bin:${exported.PATH ?? process.env.PATH ?? ''}`;
    const setupCommand = Object.entries(exported)
      .map(([k, v]) => `export ${k}=${JSON.stringify(v ?? '')}`)
      .join('; ');
    const promptDir = process.env.AUTONOMY_PROMPT_DIR;
    const promptFile = promptDir ? `${promptDir}/${agent}.txt` : '';
    const prompt = promptFile && existsSync(promptFile) ? readFileSync(promptFile, 'utf8') : agent;
    // createAgentWindow blocks until the agent's first response; give its socket ack a generous timeout
    // (TERMFLEET_CREATE_TIMEOUT_MS overrides) so a real claude cold-start doesn't time out the launch and
    // lose the terminalId — the join key the post-session effect marker + the reaper depend on.
    const createTimeoutMs = Number(process.env.TERMFLEET_CREATE_TIMEOUT_MS || RUNNER_DEFAULTS.createTimeoutMs);
    const ack = await client.createAgentWindow(
      { agent: this.harness, name: agent, cwd: process.cwd(), prompt, setupCommand, createTimeoutMs },
      { timeoutMs: createTimeoutMs },
    );
    const terminalId = ack.result?.terminalId;
    if (!terminalId) {
      throw new Error(`termfleet createAgentWindow returned no terminalId for agent "${agent}": ${ack.error ?? '(no error)'}`);
    }
    return {
      id: terminalId,
      agent,
      status: 'running',
      ...(ack.result?.agentSessionId ? { ref: ack.result.agentSessionId } : {}),
      ...(Object.keys(params).length ? { params } : {}),
    };
  }
  async get(id) {
    return (await this.list()).find((s) => s.id === id);
  }
  // termfleet's process-tree lifecycle joined to the window list. A window points at a session via
  // `lifecycle.currentSessionId`; the session carries the real activity `state` (+ attention `signal`).
  async #view() {
    const client = await this.#client();
    const [life, snapshot] = await Promise.all([client.lifecycle(), client.snapshot()]);
    const byId = new Map((life.sessions || []).map((s) => [s.sessionId, s]));
    return { client, snapshot, byId };
  }
  async list() {
    const { snapshot, byId } = await this.#view();
    // id = the terminalId termfleet owns; agent = the window name we launched it under; status reflects
    // termfleet's real per-session activity (running | background | idle | awaiting-human).
    return snapshot.windows.filter((w) => !!w.terminalId).map((w) => sessionOf(w, byId));
  }
  // Close this install's OWN agent sessions that have been IDLE (termfleet `session_waiting`, no attention
  // signal) for >= idleMs — the local analogue of an ephemeral job ending when its work is done. Scope is
  // the `agents` name set (a human's own terminal or another loop's session is never touched). `since` is
  // the caller's persistent Map(sessionId -> firstIdleAtMs): a session that resumes work, is taken over
  // (signal `asking`), or errors is dropped from it and never reaped. Reaps via closeWindow (proven path).
  async reapIdle({ idleMs = 60000, agents, since = new Map(), now = Date.now() } = {}) {
    const { client, snapshot, byId } = await this.#view();
    const seen = new Set();
    const reaped = [];
    for (const w of snapshot.windows) {
      if (agents && agents.size && !agents.has(w.name)) continue;
      const sid = w.lifecycle?.currentSessionId;
      const s = sid ? byId.get(sid) : undefined;
      if (!s) continue;
      seen.add(sid);
      const idle = s.state === 'session_waiting' && !s.signal;
      if (!idle) {
        since.delete(sid);
        continue;
      }
      if (!since.has(sid)) since.set(sid, now);
      if (now - since.get(sid) >= idleMs) {
        const ack = await client.closeWindow(w.id).catch(() => null);
        if (ack && ack.ok !== false) {
          reaped.push({ id: w.terminalId, agent: w.name, sessionId: sid });
          since.delete(sid);
        }
      }
    }
    for (const sid of [...since.keys()]) if (!seen.has(sid)) since.delete(sid);
    return reaped;
  }
  async update(id, patch) {
    if (patch.status === 'cancelled') return this.cancel(id);
    return true;
  }
  async cancel(id) {
    const client = await this.#client();
    const snapshot = await client.snapshot();
    const window = snapshot.windows.find((w) => w.terminalId === id);
    if (!window) return false;
    const ack = await client.closeWindow(window.id);
    return ack.ok !== false;
  }
}

// Map a window + its lifecycle session into a Session, surfacing termfleet's real activity. The contract
// status vocab is running|paused|cancelled|done|failed, so: running/background -> running, idle
// (session_waiting, no signal) -> done, attention `asking` -> paused, `errored` -> failed; a note carries
// the finer distinction. No session yet (just launched) reads as running.
function sessionOf(w, byId) {
  const s = w.lifecycle?.currentSessionId ? byId.get(w.lifecycle.currentSessionId) : undefined;
  const base = { id: w.terminalId, agent: w.name };
  if (!s) return { ...base, status: 'running' };
  const ref = s.sessionId;
  if (s.state === 'session_running') return { ...base, status: 'running', ref };
  if (s.state === 'session_stopped_background_running') return { ...base, status: 'running', ref, note: 'background work running' };
  if (s.signal === 'asking') return { ...base, status: 'paused', ref, note: 'awaiting human input' };
  if (s.signal === 'errored') return { ...base, status: 'failed', ref, note: 'errored, awaiting human' };
  return { ...base, status: 'done', ref, note: 'idle (turn complete)' };
}

function parseParams(args) {
  const params = {};
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

export async function runCli(runner, argv) {
  const [cmd, ...rest] = argv;
  const opt = (name) => {
    const i = rest.indexOf(name);
    return i >= 0 ? rest[i + 1] : undefined;
  };

  if (cmd === 'launch') {
    const agent = rest[0];
    if (!agent || agent.startsWith('--')) {
      console.error('usage: autonomy launch <agent> [--key value ...]');
      return 2;
    }
    console.log(JSON.stringify(await runner.launch(agent, parseParams(rest.slice(1)))));
    return 0;
  }
  if (cmd === 'get') {
    const session = await runner.get(rest[0] ?? '');
    if (!session) return 1;
    console.log(JSON.stringify(session));
    return 0;
  }
  if (cmd === 'list') {
    console.log(JSON.stringify(await runner.list()));
    return 0;
  }
  if (cmd === 'update') {
    const id = rest[0];
    const status = opt('--status');
    if (!id || !status) {
      console.error('usage: autonomy update <id> --status <running|paused|cancelled|done|failed>');
      return 2;
    }
    return (await runner.update(id, { status })) ? 0 : 1;
  }
  if (cmd === 'cancel') {
    const id = rest[0];
    if (!id) {
      console.error('usage: autonomy cancel <id>');
      return 2;
    }
    return (await runner.cancel(id)) ? 0 : 1;
  }
  console.error('usage: autonomy <launch|get|list|update|cancel>');
  return 2;
}

// Entrypoint: the local-loop substrate runner is termfleet. One concrete runner, no selection switch.
if (import.meta.url === `file://${process.argv[1]}`) {
  process.exit(await runCli(new TermfleetRunner(), process.argv.slice(2)));
}
