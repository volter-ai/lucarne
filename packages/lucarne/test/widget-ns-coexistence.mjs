// LS-17 dev/02 — the two-`ns` COEXISTENCE test (Chrome-free): two independent widget instances with DIFFERENT
// `ns` values operating on the SAME page must not cross-talk. LS-15's `envelope-roundtrip.mjs` already proves a
// single reducer drops a foreign `ns` (one reducer, one wrong-ns message); this is the DEDICATED coexistence
// proof the LS-17 AC calls for: TWO live-ish reducer instances sharing one mock page channel, asserting FULL
// bidirectional isolation, plus every `ns`-derived name `src/ns.ts` mints being pairwise disjoint between the
// two namespaces.
//
// Run with `node test/ns-coexistence.mjs` (after `npm run build`).
import { widgetMessage } from "../dist/widget/envelope.js";
import { createEnvelopeReducer } from "../dist/widget/reducer.js";
import {
  chromeKey,
  dragGlobal,
  glassIds,
  guardGlobal,
  hostElementId,
  iframeGlobal,
  intentQueueGlobal,
  peekElementId,
  posGlobal,
  scrimGlobal,
  shellStickyId,
  themeGlobal,
} from "../dist/widget/ns.js";

const results = [];
const check = (name, pass, detail = "") => {
  results.push({ name, pass: !!pass });
  console.log(`  ${pass ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
};

// ── Part (a): a SHARED mock `window` postMessage channel — the same "one page, several listeners" shape two
// independently-mounted widget instances would actually share (mirrors `envelope-roundtrip.mjs`'s mock, extended
// to fan the same posted message out to BOTH instances' listeners at once, exactly as a real `message` event on
// one shared `window` would). ────────────────────────────────────────────────────────────────────────────────
function createSharedPageChannel() {
  const listeners = [];
  return {
    addEventListener(type, cb) {
      if (type === "message") listeners.push(cb);
    },
    /** Stands in for one `postMessage` landing on the shared page — every listener on the page sees it, exactly
     * like a real same-window `message` event would broadcast to every registered handler. */
    post(data) {
      for (const cb of listeners) cb({ data });
    },
  };
}

const NS_A = "tenant-a";
const NS_B = "tenant-b";

const receivedA = [];
const receivedB = [];

const page = createSharedPageChannel();

const reducerA = createEnvelopeReducer({ ns: NS_A, onPatch: (patch, envelope) => receivedA.push({ patch, envelope }) });
const reducerB = createEnvelopeReducer({ ns: NS_B, onPatch: (patch, envelope) => receivedB.push({ patch, envelope }) });

// Both instances' iframe runtimes register their listener on the SAME shared page channel — this is the
// cross-talk-prone shape the AC is about.
page.addEventListener("message", (e) => reducerA.handleMessage(e.data));
page.addEventListener("message", (e) => reducerB.handleMessage(e.data));

const identityA = { profile: "alice", workspace: "ws-a" };
const identityB = { profile: "bob", workspace: "ws-b" };

// ── 1. a push tagged ns A lands ONLY in reducer A's onPatch — reducer B (also listening on the same channel)
// ignores it entirely. ──────────────────────────────────────────────────────────────────────────────────────
page.post(widgetMessage(NS_A, identityA, { hello: "from A" }));
check("an ns=A envelope is delivered to instance A", receivedA.length === 1 && receivedA[0].patch.hello === "from A");
check("an ns=A envelope is NOT delivered to instance B (foreign ns dropped)", receivedB.length === 0, `receivedB.length=${receivedB.length}`);

// ── 2. and vice versa — a push tagged ns B lands ONLY in reducer B; A is untouched. ────────────────────────────
page.post(widgetMessage(NS_B, identityB, { hello: "from B" }));
check("an ns=B envelope is delivered to instance B", receivedB.length === 1 && receivedB[0].patch.hello === "from B");
check("an ns=B envelope is NOT delivered to instance A (foreign ns dropped)", receivedA.length === 1, `receivedA.length=${receivedA.length}`);

// ── 3. continued alternating traffic on the shared channel stays fully partitioned — not just a first-message
// fluke. ─────────────────────────────────────────────────────────────────────────────────────────────────────
page.post(widgetMessage(NS_A, identityA, { hello: "from A again", n: 2 }));
page.post(widgetMessage(NS_B, identityB, { hello: "from B again", n: 2 }));
check(
  "repeated interleaved traffic stays partitioned: A received exactly its own 2 pushes",
  receivedA.length === 2 && receivedA.every((r) => r.envelope.ns === NS_A),
  JSON.stringify(receivedA.map((r) => r.envelope.ns)),
);
check(
  "repeated interleaved traffic stays partitioned: B received exactly its own 2 pushes",
  receivedB.length === 2 && receivedB.every((r) => r.envelope.ns === NS_B),
  JSON.stringify(receivedB.map((r) => r.envelope.ns)),
);

// ── 4. identity pinning is scoped PER-INSTANCE, not just per-ns: even if two tenants happened to use the SAME
// identity shape, each reducer only ever pins from envelopes carrying its OWN ns — proves isolation doesn't rely
// on identity ever differing between tenants. ───────────────────────────────────────────────────────────────
const sameIdentityShape = { profile: "shared-name", workspace: "shared-ws" };
const receivedC = [];
const receivedD = [];
const reducerC = createEnvelopeReducer({ ns: "tenant-c", onPatch: (p, e) => receivedC.push({ p, e }) });
const reducerD = createEnvelopeReducer({ ns: "tenant-d", onPatch: (p, e) => receivedD.push({ p, e }) });
page.addEventListener("message", (e) => reducerC.handleMessage(e.data));
page.addEventListener("message", (e) => reducerD.handleMessage(e.data));
page.post(widgetMessage("tenant-c", sameIdentityShape, { v: 1 }));
page.post(widgetMessage("tenant-d", sameIdentityShape, { v: 2 }));
check(
  "two instances with an IDENTICAL identity shape but different ns still stay isolated (ns gates before identity pinning)",
  receivedC.length === 1 && receivedC[0].p.v === 1 && receivedD.length === 1 && receivedD[0].p.v === 2,
  JSON.stringify({ receivedC, receivedD }),
);

// ── Part (b): every `ns`-derived name `src/ns.ts` mints is pairwise DISJOINT between two namespaces — the
// static half of the isolation guarantee (page globals / host ids / sticky ids never collide even before any
// message is ever posted). ──────────────────────────────────────────────────────────────────────────────────
check("iframeGlobal(nsA) !== iframeGlobal(nsB)", iframeGlobal(NS_A) !== iframeGlobal(NS_B), `${iframeGlobal(NS_A)} vs ${iframeGlobal(NS_B)}`);
check("shellStickyId(nsA) !== shellStickyId(nsB)", shellStickyId(NS_A) !== shellStickyId(NS_B), `${shellStickyId(NS_A)} vs ${shellStickyId(NS_B)}`);
check("hostElementId(nsA) !== hostElementId(nsB)", hostElementId(NS_A) !== hostElementId(NS_B), `${hostElementId(NS_A)} vs ${hostElementId(NS_B)}`);
check("chromeKey(nsA) !== chromeKey(nsB)", chromeKey(NS_A) !== chromeKey(NS_B), `${chromeKey(NS_A)} vs ${chromeKey(NS_B)}`);
check("themeGlobal(nsA) !== themeGlobal(nsB)", themeGlobal(NS_A) !== themeGlobal(NS_B));
check("posGlobal(nsA) !== posGlobal(nsB)", posGlobal(NS_A) !== posGlobal(NS_B));
check("guardGlobal(nsA) !== guardGlobal(nsB)", guardGlobal(NS_A) !== guardGlobal(NS_B));
check("dragGlobal(nsA) !== dragGlobal(nsB)", dragGlobal(NS_A) !== dragGlobal(NS_B));
check("scrimGlobal(nsA) !== scrimGlobal(nsB)", scrimGlobal(NS_A) !== scrimGlobal(NS_B));
check("peekElementId(nsA) !== peekElementId(nsB)", peekElementId(NS_A) !== peekElementId(NS_B));
check("intentQueueGlobal(nsA, 'ctl') !== intentQueueGlobal(nsB, 'ctl')", intentQueueGlobal(NS_A, "ctl") !== intentQueueGlobal(NS_B, "ctl"));

const glassA = glassIds(NS_A);
const glassB = glassIds(NS_B);
const glassKeys = ["svg", "filter", "img", "displacementMap"];
check(
  "glassIds(nsA) and glassIds(nsB) share no id across all four glass-filter ids",
  glassKeys.every((k) => glassA[k] !== glassB[k]) && new Set([...Object.values(glassA), ...Object.values(glassB)]).size === 8,
  JSON.stringify({ glassA, glassB }),
);

// One more static sanity check: NOTHING minted for ns A contains ns B's prefix or vice versa (a stronger form of
// "disjoint" than mere `!==` — rules out one being an accidental substring/prefix collision of the other).
const allA = [iframeGlobal(NS_A), shellStickyId(NS_A), hostElementId(NS_A), chromeKey(NS_A), themeGlobal(NS_A), posGlobal(NS_A), guardGlobal(NS_A), dragGlobal(NS_A), scrimGlobal(NS_A), peekElementId(NS_A), intentQueueGlobal(NS_A, "ctl"), ...Object.values(glassA)];
const allB = [iframeGlobal(NS_B), shellStickyId(NS_B), hostElementId(NS_B), chromeKey(NS_B), themeGlobal(NS_B), posGlobal(NS_B), guardGlobal(NS_B), dragGlobal(NS_B), scrimGlobal(NS_B), peekElementId(NS_B), intentQueueGlobal(NS_B, "ctl"), ...Object.values(glassB)];
const overlap = allA.filter((n) => allB.includes(n));
check("the full set of ns A's minted names and ns B's minted names is disjoint (no accidental overlap)", overlap.length === 0, overlap.length ? JSON.stringify(overlap) : "");

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
