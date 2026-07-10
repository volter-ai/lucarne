// LS-22b dev/01 — the Chrome-free proof that `WidgetHost`'s new per-page intent-drain primitive
// (`drainIntentsWithContext`/`activeTabInfo`) is a FIXED, SCOPED read — never a re-opened general "eval"
// surface. The retired engine `/eval` REPL stays retired, not generalized (this package's split task spec
// §1.5) — `push`'s fixed postMessage expression and `onIntent`'s internal fixed read-and-clear expression are
// the existing precedent; this gate proves the new primitive's own internal expression-builder (`probeExpr`,
// private in the TS source but a perfectly ordinary method at runtime — TS `private` is compile-time-only, see
// `dist/host.js`) follows the identical posture: it is built ENTIRELY from `JSON.stringify`-escaped constants
// this package derives itself (`intentQueueGlobal(ns, name)`) plus a fixed handful of standard DOM reads
// (`document.visibilityState`, `document.hasFocus()`, `document.title`, `location.href`/`location.protocol`)
// — NEVER a caller-supplied expression string.
//
// This is a SHAPE test, not a re-implementation: it calls the package's own real `probeExpr` (via a bare
// `WidgetHost` instance — the constructor is `private` only at the TS type layer, so a plain untyped .mjs test
// can still call it, the same way `dist/host.js`'s compiled class has an entirely ordinary JS constructor) and
// inspects the ACTUAL string it produces, rather than asserting against a hand-written duplicate.
//
// Run with `node test/intent-drain-scope-gate.mjs` (after `npm run build`).
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { WidgetHost } from "../dist/host.js";
import { intentQueueGlobal } from "../dist/ns.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

const results = [];
const check = (name, pass, detail = "") => {
  results.push({ name, pass: !!pass });
  console.log(`  ${pass ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
};

// ── a bare instance, never attached to a real engine/session — enough to call the pure expression-builder. ──
const NS = "scopegate";
const NAME = "recall";
const host = new WidgetHost("fake-session-id", "http://127.0.0.1:1/fake-cdp", NS, null, {});

check("drainIntentsWithContext is exported on WidgetHost instances", typeof host.drainIntentsWithContext === "function");
check("activeTabInfo is exported on WidgetHost instances", typeof host.activeTabInfo === "function");
check("onIntent (the existing flatten-all consumer) is still exported", typeof host.onIntent === "function");

// ── the drain form (key present, drain: true) — must read-and-CLEAR exactly the one namespaced global. ──
const key = intentQueueGlobal(NS, NAME);
const drainExpr = host.probeExpr(key, true);
check("probeExpr(key, true) is a string", typeof drainExpr === "string");
check(
  "the drain expression reads the EXACT namespaced intent-queue global this call names",
  drainExpr.includes(`window[${JSON.stringify(key)}]`),
  key,
);
check("the drain expression CLEARS that global (assigns [] back)", drainExpr.includes(`window[${JSON.stringify(key)}] = [];`));
check("the drain expression probes visibility via the standard API", drainExpr.includes("document.visibilityState === 'visible'"));
check("the drain expression probes focus via the standard API", drainExpr.includes("document.hasFocus()"));
check("the drain expression reads the page's own URL/title via the standard APIs", drainExpr.includes("location.href") && drainExpr.includes("document.title"));
check("the drain expression skips non-http(s) pages the same way the retired multi-tab poller's own probe did", drainExpr.includes("/^https?:$/.test(location.protocol)"));

// ── the read-only form (key: null, drain: false) — must touch NO window global at all (activeTabInfo's shape). ──
const readOnlyExpr = host.probeExpr(null, false);
check("probeExpr(null, false) never references any window[...] global (genuinely read-only)", !readOnlyExpr.includes("window["));
check("the read-only expression still carries the same visibility/focus/url/title probe", readOnlyExpr.includes("document.visibilityState === 'visible'") && readOnlyExpr.includes("document.hasFocus()") && readOnlyExpr.includes("location.href"));

// ── the NEGATIVE half of the AC: no general-eval surface was reintroduced. `probeExpr` takes ONLY a namespaced
// key + a boolean — never a free-form expression string — so there is no way for a caller of the public
// `drainIntentsWithContext(name)` / `activeTabInfo()` surface to inject arbitrary JS text. Assert this the same
// way the package's other gates assert a negative: source-grep the public method bodies for the one thing that
// WOULD reopen the hazard (an `expr`/`expression` PARAMETER threaded straight from a public method's own
// caller-supplied argument into `evaluateOnAllPagesCollecting`, bypassing `probeExpr` entirely). ──
const hostSrc = readFileSync(resolve(__dirname, "..", "src", "host.ts"), "utf8");
const publicMethodsAcceptNoRawExpr = !/drainIntentsWithContext\s*\(\s*(expr|expression)/.test(hostSrc) && !/activeTabInfo\s*\(\s*(expr|expression)/.test(hostSrc);
check("drainIntentsWithContext/activeTabInfo take NO caller-supplied expression parameter", publicMethodsAcceptNoRawExpr);
check(
  "WidgetHost's public surface never exports `evaluateOnAllPagesCollecting`/`evaluateOnAllPages` (the raw multi-page eval primitive) as an arbitrary-expression endpoint",
  !/export\s+\{[^}]*evaluateOnAllPagesCollecting/.test(hostSrc) && !/export\s+function\s+evaluate\(/.test(hostSrc),
);
const indexSrc = readFileSync(resolve(__dirname, "..", "src", "index.ts"), "utf8");
check("the package's root export map never re-exports cdp-lite's raw evaluator", !/cdp-lite/.test(indexSrc));

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
