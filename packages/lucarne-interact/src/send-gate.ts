// send-gate.ts — the FINAL send decision: default-refuse, only an explicit approval or yolo sends.
//
// `decideSend` is ported BYTE-IDENTICAL (function signature through closing brace, verbatim) from
// the origin app's `src/guardrails/enforce.ts:124-132` — the load-bearing safety-law-2 mechanism ("never
// send without approval", the origin app's CLAUDE.md). `test/decide-send-provenance.mjs` proves the span
// between the BEGIN/END markers below is character-for-character identical to a frozen copy of the
// original (so this file's own drift would fail that test, not just a human's eyeball diff).
//
// Everything ELSE here — the `GuardrailResult` shape, `DecideSendApproval` — is NEW glue this
// package needs to expose `decideSend` as a typed export; it carries no origin-app POLICY. All content
// rules (banned words, link allow-list, rate limits, sourcing/assess, the approvals ledger) are the
// CALLER's `policy(text, ctx)` function (see send-flow.ts) — this module only knows the two fields
// `decideSend` actually reads off the policy result: `blocked` and `mustAsk`.

/**
 * The minimal shape `decideSend` reads off a computed guardrail/policy result. Mirrors the real
 * shape the origin app's `enforce()` returns (`{ ok, blocked, mustAsk, violations }`,
 * `guardrails/enforce.ts:104-107`) — but `decideSend` itself only ever consumes
 * `blocked`/`mustAsk` (see the verbatim function below); `ok`/`violations` are accepted here too
 * (structurally, so a caller's richer result — e.g. the origin app's `enforce()` return plus its own
 * sourcing/assess additions — passes straight through) but are NOT read by this module. Content
 * rules, rate limits, sourcing, and the approvals ledger that PRODUCE this result are all
 * caller-supplied policy, not this package's concern.
 */
export interface GuardrailResult {
  /** Hard guardrail failure (banned word, bad link, rate limit, burst guard, …) — refuses even in yolo. */
  blocked?: boolean;
  /** Touches an "always ask" topic (money, legal, …) — needs an explicit `ack`, even in yolo. */
  mustAsk?: boolean;
  /** Caller's own overall-ok flag, if it has one. Not read by `decideSend`; carried through untouched. */
  ok?: boolean;
  /** Caller's own violation list, if it has one. Not read by `decideSend`; carried through untouched. */
  violations?: unknown[];
}

// ---8<--- BEGIN VERBATIM PORT: guardrails/enforce.ts:124-132 (decideSend) ---8<---
export function decideSend(e: { blocked?: boolean; mustAsk?: boolean } = {}, { mode = 'ask', approved = false, ack = false }: { mode?: string; approved?: boolean; ack?: boolean } = {}) {
  const isApproved = approved || ack;   // acknowledging an always-ask topic (--ack) is itself an approval
  if (e.blocked) return { send: false, action: 'blocked', reason: 'guardrails block this draft' };
  if (e.mustAsk && !ack) return { send: false, action: 'needs-ack', reason: 'always-ask topic — needs explicit --ack' };
  if (mode !== 'yolo' && !isApproved) return { send: false, action: 'needs-approval', reason: 'ask mode — the human must approve each send (--approved)' };
  return mode === 'yolo'
    ? { send: true, action: 'send-yolo', reason: 'yolo auto-send (no per-send approval)' }
    : { send: true, action: 'send-approved', reason: 'human-approved' };
}
// ---8<--- END VERBATIM PORT ---8<---

/** The result shape `decideSend` returns — kept as a named type for callers/tests. */
export type DecideSendResult = ReturnType<typeof decideSend>;

/**
 * The approval signal `decideSend` reads (the second parameter's shape, kept distinct from the
 * verbatim function's own inline literal type so this name is exported/reusable). `mode` is
 * loosely `string` here — matching the ORIGINAL signature exactly (verbatim above) — but every
 * caller in this package's public API (`send()`, see send-flow.ts) narrows it to `'ask' | 'yolo'`.
 */
export interface DecideSendApproval {
  mode?: string;
  approved?: boolean;
  ack?: boolean;
}
