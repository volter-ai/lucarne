// LS-11 dev/02 — `decideSend` PROVENANCE (Chrome-free): proves the ported function is
// CHARACTER-IDENTICAL to the original at cadence/src/guardrails/enforce.ts:124-132.
//
// This is the load-bearing safety claim for "never send without approval": the mechanism isn't
// just semantically equivalent (test/send-gate.mjs's exhaustive matrix pins the BEHAVIOR
// independently), it is the literal same source text, so a reviewer can `diff` the two spans and
// see zero drift.
//
// FROZEN_ORIGINAL below is a byte-for-byte copy of enforce.ts:124-132, taken directly from that
// file at the time this test was authored (verified with `diff` against the live source in the
// cadence checkout during authoring — see the LS-11 task report). It is embedded as a literal
// (rather than read from `../../../cadence` at test time) on purpose: this test must stay
// runnable wherever this package's Chrome-free suite runs, including CI/other checkouts that
// don't have a sibling `cadence` repo on disk. If cadence's `enforce.ts:124-132` is ever
// hand-edited, re-copy verbatim into src/send-gate.ts's marked span AND into FROZEN_ORIGINAL below
// together — never one without the other.
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const results = [];
const check = (name, pass, detail = "") => {
  results.push({ name, pass: !!pass });
  console.log(`  ${pass ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
};

const FROZEN_ORIGINAL = `export function decideSend(e: { blocked?: boolean; mustAsk?: boolean } = {}, { mode = 'ask', approved = false, ack = false }: { mode?: string; approved?: boolean; ack?: boolean } = {}) {
  const isApproved = approved || ack;   // acknowledging an always-ask topic (--ack) is itself an approval
  if (e.blocked) return { send: false, action: 'blocked', reason: 'guardrails block this draft' };
  if (e.mustAsk && !ack) return { send: false, action: 'needs-ack', reason: 'always-ask topic — needs explicit --ack' };
  if (mode !== 'yolo' && !isApproved) return { send: false, action: 'needs-approval', reason: 'ask mode — the human must approve each send (--approved)' };
  return mode === 'yolo'
    ? { send: true, action: 'send-yolo', reason: 'yolo auto-send (no per-send approval)' }
    : { send: true, action: 'send-approved', reason: 'human-approved' };
}`;

const PKG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sendGateSrc = readFileSync(path.join(PKG_ROOT, "src", "send-gate.ts"), "utf8");

const BEGIN_MARKER = "// ---8<--- BEGIN VERBATIM PORT: guardrails/enforce.ts:124-132 (decideSend) ---8<---";
const END_MARKER = "// ---8<--- END VERBATIM PORT ---8<---";

const beginIdx = sendGateSrc.indexOf(BEGIN_MARKER);
const endIdx = sendGateSrc.indexOf(END_MARKER);
check("send-gate.ts has both BEGIN/END verbatim-port markers", beginIdx !== -1 && endIdx !== -1 && endIdx > beginIdx);

const ported = sendGateSrc.slice(beginIdx + BEGIN_MARKER.length, endIdx).replace(/^\n+/, "").replace(/\n+$/, "");

check("the ported span is non-empty", ported.length > 0, `${ported.length} chars`);
check(
  "src/send-gate.ts's decideSend span is CHARACTER-IDENTICAL to the frozen copy of enforce.ts:124-132",
  ported === FROZEN_ORIGINAL,
  ported === FROZEN_ORIGINAL ? "identical" : `first diff at index ${firstDiffIndex(ported, FROZEN_ORIGINAL)}`,
);

// Belt-and-suspenders: also prove the exported RUNTIME function's behavior matches what this exact
// source text implies (import-and-run, not just a string compare) — a change that kept the string
// but broke the build, or vice versa, would show up here too.
const { decideSend } = await import("../dist/send-gate.js");
check("decideSend is actually exported as a function from the built package", typeof decideSend === "function");
check(
  "decideSend's default-refuse behavior matches the frozen source's documented default (ask mode, no approval -> refuse)",
  decideSend({}, {}).send === false && decideSend({}, {}).action === "needs-approval",
);

function firstDiffIndex(a, b) {
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) {
    if (a[i] !== b[i]) return i;
  }
  return a.length === b.length ? -1 : len;
}

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
