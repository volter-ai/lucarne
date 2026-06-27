// Shared, substrate-neutral transcript domain. Given a Claude Code run's stream-json events, produce a
// readable, redacted, step-by-step Markdown transcript of what the agent actually did. These are PURE
// functions — no GitHub, no model proxy, no filesystem — so any substrate that runs agents via
// `runClaudeAgent` (agent.ts) can render a transcript here and then persist it however its own execution
// layer chooses. WHERE a transcript lands (an Actions artifact, a committed `.open-autonomy/history/`
// record, a local file) is a substrate concern; HOW a run becomes readable is not, and lives here.

export type AgentEvent = Record<string, unknown>;

/** Parse stream-json stdout (newline-delimited JSON) into events; skip any non-JSON noise. */
export function parseEvents(raw: string): AgentEvent[] {
  const out: AgentEvent[] = [];
  for (const line of raw.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    try {
      out.push(JSON.parse(t) as AgentEvent);
    } catch {
      /* not a JSON line — ignore */
    }
  }
  return out;
}

/** The agent's final message: the `result` event's text, else the concatenated assistant text blocks. */
export function extractFinalText(events: AgentEvent[]): string {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (e.type === 'result' && typeof e.result === 'string') return e.result;
  }
  const texts: string[] = [];
  for (const e of events) {
    if (e.type !== 'assistant') continue;
    const content = ((e.message as { content?: Array<{ type?: string; text?: string }> })?.content) ?? [];
    for (const c of content) if (c.type === 'text' && c.text) texts.push(c.text);
  }
  return texts.join('\n\n');
}

/** Redact secret-shaped tokens so a persisted transcript can never carry a credential. */
export function redactSensitive(text: string): string {
  return text
    .replace(/sk_live_[A-Za-z0-9]{12,}/g, '[redacted-secret-like-token]')
    .replace(/rk_live_[A-Za-z0-9]{12,}/g, '[redacted-secret-like-token]')
    .replace(/xox(?:b|p|a|r)-[A-Za-z0-9-]{20,}/g, '[redacted-secret-like-token]')
    .replace(/ghp_[A-Za-z0-9]{30,}/g, '[redacted-secret-like-token]')
    .replace(/github_pat_[A-Za-z0-9_]{30,}/g, '[redacted-secret-like-token]')
    .replace(/sk-or-v1-[A-Za-z0-9]{20,}/g, '[redacted-secret-like-token]')
    .replace(/anthropic_[A-Za-z0-9_-]{20,}/g, '[redacted-secret-like-token]');
}

/** Truncate a blob so the durable transcript stays a reasonable size in history. */
export function brief(value: unknown, max = 1200): string {
  let s: string;
  if (typeof value === 'string') s = value;
  else if (Array.isArray(value)) s = value.map((c) => (c && typeof c === 'object' && 'text' in c ? String((c as { text?: string }).text ?? '') : JSON.stringify(c))).join('\n');
  else s = JSON.stringify(value, null, 2);
  s = s.trim();
  return s.length > max ? `${s.slice(0, max)}\n… [${s.length - max} more chars truncated]` : s;
}

/** Render the event stream into a step-by-step walkthrough: each assistant turn, each tool call (with a
 *  brief of its input), and each tool result — the divable record of what the agent did. */
export function renderSteps(events: AgentEvent[]): string {
  const out: string[] = [];
  let step = 0;
  for (const e of events) {
    if (e.type === 'assistant') {
      const content = ((e.message as { content?: Array<Record<string, unknown>> })?.content) ?? [];
      for (const c of content) {
        if (c.type === 'text' && typeof c.text === 'string' && c.text.trim()) {
          out.push('', redactSensitive(c.text.trim()));
        } else if (c.type === 'tool_use') {
          step++;
          out.push('', `### Step ${step} — \`${String(c.name)}\``, '', '```json', redactSensitive(brief(c.input)), '```');
        }
      }
    } else if (e.type === 'user') {
      const content = ((e.message as { content?: Array<Record<string, unknown>> })?.content) ?? [];
      for (const c of content) {
        if (c.type === 'tool_result') out.push('', '_→ result:_', '```text', redactSensitive(brief(c.content, 800)), '```');
      }
    }
  }
  return out.join('\n');
}

/** Assemble the full transcript document from a run's events + metadata. Substrate-neutral. */
export function renderTranscript(opts: { events: AgentEvent[]; subject?: string; model: string; stdout: string; stderr: string; exitCode: number; settledCostUsd?: number }): string {
  const resultEvent = opts.events.find((e) => e.type === 'result') ?? {};
  // Cost: the PROXY-settled charge is authoritative. The Claude Code CLI's `total_cost_usd` prices tokens with
  // its built-in Anthropic table and has NO idea a proxied model (e.g. deepseek/* via OpenRouter) is cheap — it
  // over-estimates by ~40×, so only show it labelled as an estimate when the real settled cost is unavailable.
  const cost = typeof opts.settledCostUsd === 'number'
    ? `$${opts.settledCostUsd.toFixed(4)} (provider-settled)`
    : typeof resultEvent.total_cost_usd === 'number'
      ? `~$${resultEvent.total_cost_usd.toFixed(4)} (CLI estimate — NOT settled; mis-prices proxied models)`
      : 'n/a';
  const turns = typeof resultEvent.num_turns === 'number' ? resultEvent.num_turns : opts.events.filter((e) => e.type === 'assistant').length;
  const steps = renderSteps(opts.events);
  return [
    '# Agent run transcript',
    '',
    `- **Subject:** ${opts.subject || '—'}`,
    `- **Model:** ${opts.model}`,
    `- **Turns:** ${turns} · **Cost:** ${cost} · **Exit:** ${opts.exitCode}`,
    '',
    '## What the agent did',
    '',
    steps.trim() || '_(no structured event stream captured)_',
    '',
    '## Final message',
    '',
    redactSensitive((opts.stdout ?? '').trim()) || '_(none)_',
    '',
    '## stderr',
    '',
    '```text',
    redactSensitive((opts.stderr ?? '').trim()),
    '```',
    '',
  ].join('\n');
}
