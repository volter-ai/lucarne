// LS-15 dev/02 — the envelope round-trip acceptance proof (Chrome-free): `host.push` → the iframe's `onPatch`
// delivers versioned patches; identity pinning drops a SECOND, foreign identity (ported semantics from
// `main.tsx:678-688`: "We pin to the FIRST identity we see and DROP anything foreign/stale").
//
// Driven Chrome-free with a MOCK postMessage channel (no `window`/`document` needed — this is exactly what
// `createEnvelopeReducer` (`src/reducer.ts`) is for: it's the pure half of `runtime.ts`'s inbound handling) and
// `widgetMessage` (`src/envelope.ts`) standing in for `WidgetHost.push`'s wire format (`host.ts` calls the exact
// same function before handing the JSON to the page).
//
// Run with `node test/envelope-roundtrip.mjs` (after `npm run build`).
import { widgetMessage } from "../dist/widget/envelope.js";
import { createEnvelopeReducer } from "../dist/widget/reducer.js";

const results = [];
const check = (name, pass, detail = "") => {
  results.push({ name, pass: !!pass });
  console.log(`  ${pass ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
};

/** A minimal mock of the `window` `postMessage`/`message`-event channel — no DOM required. */
function createMockChannel() {
  const listeners = [];
  return {
    addEventListener(type, cb) {
      if (type === "message") listeners.push(cb);
    },
    /** Stands in for `f.contentWindow.postMessage(msg, '*')` landing as a `message` event in the iframe. */
    post(data) {
      for (const cb of listeners) cb({ data });
    },
  };
}

const NS = "acceptance-ns";
const received = [];
const chan = createMockChannel();
const reducer = createEnvelopeReducer({
  ns: NS,
  onPatch: (patch, envelope) => received.push({ patch, envelope }),
});
chan.addEventListener("message", (e) => reducer.handleMessage(e.data));

// ── 1. host.push → iframe onPatch delivers the FIRST envelope's patch ──────────────────────────
const identityA = { profile: "alice", workspace: "ws-1" };
chan.post(widgetMessage(NS, identityA, { hello: "world" }));
check("first envelope is accepted and delivered to onPatch", received.length === 1);
check("delivered patch matches what was pushed", received[0] && received[0].patch.hello === "world");
check("pins to the first identity seen", reducer.pinnedIdentity === "alice");

// ── 2. a SECOND push, SAME identity → still delivered (continuous re-push, not a one-shot) ─────
chan.post(widgetMessage(NS, identityA, { hello: "world 2", count: 2 }));
check("a second push from the SAME identity is delivered", received.length === 2 && received[1].patch.count === 2);

// ── 3. a foreign identity → DROPPED (the core AC: pinning must reject a second, different identity) ─
const identityForeign = { profile: "mallory", workspace: "ws-evil" };
chan.post(widgetMessage(NS, identityForeign, { hello: "should not land" }));
check("a foreign identity's envelope is NOT delivered to onPatch", received.length === 2, `received.length=${received.length}`);
check("the pinned identity is unchanged after the foreign push", reducer.pinnedIdentity === "alice");

// ── 4. a legitimate push from the pinned identity STILL lands after a foreign one was dropped ──
chan.post(widgetMessage(NS, identityA, { hello: "world 3" }));
check("the pinned identity's traffic keeps flowing after a foreign push was dropped", received.length === 3 && received[2].patch.hello === "world 3");

// ── 5. bonus hardening beyond the AC minimum: wrong `ns` and wrong wire version are also dropped ──
chan.post(widgetMessage("some-other-ns", identityA, { hello: "wrong ns" }));
check("an envelope tagged with a DIFFERENT ns is dropped (two widget instances on one page never cross-talk)", received.length === 3);

const wrongVersion = widgetMessage(NS, identityA, { hello: "wrong version" });
wrongVersion.lwState.v = 999;
chan.post(wrongVersion);
check("an envelope with a mismatched wire version is dropped, not thrown on", received.length === 3);

// ── 6. a non-envelope message on the same channel is ignored, not thrown on ─────────────────────
chan.post({ theme: "dark" }); // the host→iframe theme message uses a different top-level key entirely
check("a non-envelope message (e.g. the theme control message) is ignored without throwing", received.length === 3);

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
