// LS-11 dev/01 + dev/02 — the gated `send()` decision table (Chrome-free).
//
// Two things are proven here:
//  1. dev/01 — a decision-table test against an INJECTED MOCK policy + a MOCK transport: blocked /
//     needs-ack / needs-approval / send / send-yolo are all asserted, and — the load-bearing
//     safety property — NO keypress fires on ANY refusing branch (the mock transport's dispatch
//     counters stay at zero).
//  2. dev/02 — an EXHAUSTIVE input-matrix test over `decideSend` itself (every combination of
//     blocked/mustAsk × mode × approved × ack), pinning the semantics independently of the
//     byte-identical diff proof (test/decide-send-provenance.mjs proves PROVENANCE; this proves
//     BEHAVIOR — both must hold).
//
// Run with `node test/send-gate.mjs` (after `npm run build`).
import assert from "node:assert/strict";
import { decideSend } from "../dist/send-gate.js";
import { runSendFlow } from "../dist/send-flow.js";

const results = [];
const check = (name, pass, detail = "") => {
  results.push({ name, pass: !!pass });
  console.log(`  ${pass ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
};

// ── a MOCK transport that records every dispatch — the proof instrument for "zero keypress" ──
function mockTransport(composerValue = "") {
  const calls = { pressKey: [], pressSubmit: [], readComposerProbe: 0 };
  return {
    calls,
    deps: {
      pressKey: async (key) => {
        calls.pressKey.push(key);
      },
      pressSubmit: async (selector) => {
        calls.pressSubmit.push(selector);
      },
      readComposerProbe: async () => {
        calls.readComposerProbe++;
        return { focused: true, value: composerValue };
      },
    },
  };
}

const TEXT = "shipping the docs today";
const okPolicy = async () => ({ blocked: false, mustAsk: false });
const blockedPolicy = async () => ({ blocked: true, mustAsk: false, violations: [{ rule: "banned_word", severity: "block", detail: 'contains banned word "guarantee"' }] });
const askPolicy = async () => ({ blocked: false, mustAsk: true, violations: [{ rule: "always_ask", severity: "ask", detail: 'touches an "always ask" topic: refund' }] });

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// dev/01 — decision-table proof, run through the REAL send-flow driver (runSendFlow) with a mock
// transport. Every refusing branch must dispatch NOTHING.
// ═══════════════════════════════════════════════════════════════════════════════════════════════

async function assertRefused(name, opts, expectedAction) {
  const { calls, deps } = mockTransport(TEXT);
  const res = await runSendFlow(TEXT, opts, deps);
  check(`${name}: sent:false`, res.sent === false, JSON.stringify(res));
  check(`${name}: action is '${expectedAction}'`, res.action === expectedAction, res.action);
  check(`${name}: ZERO keypress dispatched (pressKey)`, calls.pressKey.length === 0, JSON.stringify(calls));
  check(`${name}: ZERO submit dispatched (pressSubmit)`, calls.pressSubmit.length === 0, JSON.stringify(calls));
  check(`${name}: composer probe was NEVER read (refuse happens before any transport touch)`, calls.readComposerProbe === 0);
  return res;
}

async function assertSent(name, opts, expectedAction) {
  const { calls, deps } = mockTransport(TEXT);
  const res = await runSendFlow(TEXT, opts, deps);
  check(`${name}: sent:true`, res.sent === true, JSON.stringify(res));
  check(`${name}: action is '${expectedAction}'`, res.action === expectedAction, res.action);
  check(`${name}: the key gesture WAS dispatched exactly once`, calls.pressKey.length === 1 && calls.pressKey[0] === "Meta+Enter", JSON.stringify(calls));
  check(`${name}: no submit-selector dispatch on a { key } gesture`, calls.pressSubmit.length === 0);
  return res;
}

await assertRefused(
  "blocked",
  { gesture: { key: "Meta+Enter" }, policy: blockedPolicy, approval: { mode: "ask", approved: true, ack: true } },
  "blocked",
);

await assertRefused(
  "needs-ack (always-ask topic, no --ack, even though approved)",
  { gesture: { key: "Meta+Enter" }, policy: askPolicy, approval: { mode: "ask", approved: true } },
  "needs-ack",
);

await assertRefused(
  "needs-ack even in YOLO mode (always-ask overrides yolo)",
  { gesture: { key: "Meta+Enter" }, policy: askPolicy, approval: { mode: "yolo" } },
  "needs-ack",
);

await assertRefused(
  "needs-approval (ask mode, default — no approval signal at all)",
  { gesture: { key: "Meta+Enter" }, policy: okPolicy, approval: { mode: "ask" } },
  "needs-approval",
);

await assertSent(
  "send-approved (ask mode, explicit --approved)",
  { gesture: { key: "Meta+Enter" }, policy: okPolicy, approval: { mode: "ask", approved: true } },
  "send-approved",
);

await assertSent(
  "send-approved via --ack alone (an ack IS an approval, even off an always-ask policy)",
  { gesture: { key: "Meta+Enter" }, policy: askPolicy, approval: { mode: "ask", ack: true } },
  "send-approved",
);

await assertSent(
  "send-yolo (yolo mode, no per-send approval needed)",
  { gesture: { key: "Meta+Enter" }, policy: okPolicy, approval: { mode: "yolo" } },
  "send-yolo",
);

// { submit } gesture — dispatches pressSubmit, not pressKey, and SKIPS the composer probe.
{
  const { calls, deps } = mockTransport(""); // composer deliberately empty/unstaged
  const res = await runSendFlow(TEXT, { gesture: { submit: "button[type=submit]" }, policy: okPolicy, approval: { mode: "ask", approved: true } }, deps);
  check("{ submit } gesture: sent:true even with an empty composer (composer check skipped)", res.sent === true, JSON.stringify(res));
  check("{ submit } gesture: dispatches pressSubmit with the selector", calls.pressSubmit.length === 1 && calls.pressSubmit[0] === "button[type=submit]", JSON.stringify(calls));
  check("{ submit } gesture: never dispatches pressKey", calls.pressKey.length === 0);
  check("{ submit } gesture: never reads the composer probe (skipped per browser.ts:516)", calls.readComposerProbe === 0);
}

// composer-mismatch — approved, but the (mock) composer holds something else. Still zero keypress.
{
  const { calls, deps } = mockTransport("a totally different staged value");
  const res = await runSendFlow(TEXT, { gesture: { key: "Meta+Enter" }, policy: okPolicy, approval: { mode: "ask", approved: true } }, deps);
  check("composer-mismatch: sent:false", res.sent === false, JSON.stringify(res));
  check("composer-mismatch: action is 'composer-mismatch'", res.action === "composer-mismatch", res.action);
  check("composer-mismatch: ZERO keypress dispatched", calls.pressKey.length === 0 && calls.pressSubmit.length === 0);
  check("composer-mismatch: the composer WAS probed (this is a post-GO, pre-keypress check)", calls.readComposerProbe === 1);
}

// ctx is passed through to policy() untouched, and the caller's ok/violations pass through in the result.
{
  let seenCtx;
  const { deps } = mockTransport(TEXT);
  const res = await runSendFlow(
    TEXT,
    {
      gesture: { key: "Meta+Enter" },
      policy: async (text, ctx) => {
        seenCtx = ctx;
        return { ok: true, blocked: false, mustAsk: false, violations: [] };
      },
      approval: { mode: "ask", approved: true },
      ctx: { platform: "x.com", kind: "reply" },
    },
    deps,
  );
  check("send-sourcing shape: ctx passed through to policy() untouched", JSON.stringify(seenCtx) === JSON.stringify({ platform: "x.com", kind: "reply" }), JSON.stringify(seenCtx));
  check("send-sourcing shape: the caller's full policy result (ok/violations) is carried through in the result", res.policyResult.ok === true && Array.isArray(res.policyResult.violations), JSON.stringify(res.policyResult));
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// dev/02 — exhaustive input matrix directly against `decideSend`, pinning semantics independently
// of the byte-identical diff (test/decide-send-provenance.mjs proves the source text matches; this
// proves the BEHAVIOR matches — every combination of the four inputs the function reads).
// ═══════════════════════════════════════════════════════════════════════════════════════════════

const BOOL = [false, true];
const MODES = ["ask", "yolo"];
let matrixCases = 0;
for (const blocked of BOOL) {
  for (const mustAsk of BOOL) {
    for (const mode of MODES) {
      for (const approved of BOOL) {
        for (const ack of BOOL) {
          matrixCases++;
          const d = decideSend({ blocked, mustAsk }, { mode, approved, ack });
          const isApproved = approved || ack;
          // The exact priority order the ported function encodes (enforce.ts:114-118):
          //   1. blocked always refuses.
          //   2. mustAsk refuses unless ack (regardless of mode/approved).
          //   3. ask mode refuses unless approved or ack.
          //   4. otherwise send (send-yolo in yolo mode, send-approved otherwise).
          let expectSend, expectAction;
          if (blocked) {
            expectSend = false;
            expectAction = "blocked";
          } else if (mustAsk && !ack) {
            expectSend = false;
            expectAction = "needs-ack";
          } else if (mode !== "yolo" && !isApproved) {
            expectSend = false;
            expectAction = "needs-approval";
          } else {
            expectSend = true;
            expectAction = mode === "yolo" ? "send-yolo" : "send-approved";
          }
          const label = `matrix(blocked=${blocked},mustAsk=${mustAsk},mode=${mode},approved=${approved},ack=${ack})`;
          assert.equal(d.send, expectSend, `${label}: expected send=${expectSend}, got ${d.send}`);
          assert.equal(d.action, expectAction, `${label}: expected action=${expectAction}, got ${d.action}`);
          assert.equal(typeof d.reason, "string", `${label}: reason must be a string`);
        }
      }
    }
  }
}
check(`decideSend exhaustive matrix: all ${matrixCases} (blocked×mustAsk×mode×approved×ack) combinations match the priority order`, true, `${matrixCases} cases`);

// Explicit named pins for the priority-order commentary (enforce.ts:114-118), in addition to the matrix.
check("PRIORITY 1: blocked wins even with full approval AND yolo", decideSend({ blocked: true }, { mode: "yolo", approved: true, ack: true }).send === false);
check("PRIORITY 2: mustAsk wins over approved, even in yolo, unless ack", decideSend({ mustAsk: true }, { mode: "yolo", approved: true }).send === false);
check("PRIORITY 2 cleared: mustAsk + ack sends even in ask mode with no separate --approved", decideSend({ mustAsk: true }, { mode: "ask", ack: true }).send === true);
check("PRIORITY 3: ask mode with neither approved nor ack refuses", decideSend({}, { mode: "ask" }).send === false);
check("PRIORITY 4: yolo with nothing set still sends", decideSend({}, { mode: "yolo" }).send === true);
check("default args: decideSend() with no arguments at all refuses (ask mode is the default)", decideSend().send === false);

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
