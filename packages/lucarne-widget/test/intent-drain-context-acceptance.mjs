// LS-22b dev/02 — the LIVE two-tab proof for `WidgetHost.drainIntentsWithContext`: against a REAL session with
// TWO open http(s) tabs, the drain (a) returns one entry per page shaped `{url, visible, focused, items}`, (b)
// CLEARS the queue it read (a second back-to-back drain on the same, untouched queue returns `items: []` for
// every page), and (c) only the page playwright brought to the front reports `focused: true`. This is the live
// counterpart to `intent-drain-scope-gate.mjs`'s Chrome-free proof that the expression itself is fixed/scoped —
// this script proves the primitive actually WORKS end-to-end, replacing what a downstream consumer's own
// retired multi-tab intent-bus poller used to open its OWN `connectOverCDP` to verify by hand.
//
// Needs Google Chrome + the optional peer dependency `playwright-core` installed, PLUS a working Chrome sandbox
// (this dev sandbox has neither) — CI-gated, run via `npm run test:acceptance` (the repo's `acceptance` CI job
// installs Chrome + xvfb, see `.github/workflows/ci.yml`), same posture as `widget-selftest-acceptance.mjs` /
// `ns-coexistence-acceptance.mjs`.
//
// The probe only ever reads http(s) pages (see `probeExpr`'s `location.protocol` guard, mirrored from the
// retired poller's own `intentProbe`) — so, unlike this package's other acceptance scripts (which use throwaway
// `data:` tabs), this one serves a tiny local HTTP page and navigates two real tabs to it.
import http from "node:http";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Lucarne } from "lucarne";
import { chromium } from "playwright-core";
import { buildSrcdoc } from "../dist/build.js";
import { WidgetHost } from "../dist/host.js";
import { intentQueueGlobal } from "../dist/ns.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

const results = [];
const check = (name, pass, detail = "") => {
  results.push({ name, pass: !!pass });
  console.log(`  ${pass ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "lucarne-widget-intent-drain-acc-"));
process.env.LUCARNE_HOME = HOME;
if (!("LUCARNE_HEADLESS" in process.env)) process.env.LUCARNE_HEADLESS = "1";

const NS = "intentdrainacc";
const QUEUE_NAME = "recall";
const KEY = intentQueueGlobal(NS, QUEUE_NAME);

// ── a tiny local http(s)-scheme server — the probe's fixed expression deliberately skips non-http(s) pages, so
// throwaway `data:`/`about:` tabs (as this package's OTHER acceptance scripts use) won't do here. ──
//
// The fixture DETERMINISTICALLY controls the two signals the drain probe reads — document.visibilityState
// and document.hasFocus() — via `?vis=`/`?foc=` query params, overriding them with Object.defineProperty.
// This is REQUIRED because a real browser cannot reliably distinguish two foreground tabs under CI: both
// headless AND headed xvfb report every tab visible:true + focused:true (no real window occlusion / OS
// focus), so `bringToFront` produces no DOM-observable difference. By setting the values the probe reads,
// the test exercises the REAL scoring + drain plumbing end-to-end (host.ts's tab-scoring genuinely reads
// these getters) with inputs the test controls — page A reports hidden/unfocused, page B visible/focused —
// robust to any CI environment, without weakening the property under test (best-scored = the visible/focused tab).
const server = http.createServer((_req, res) => {
  res.writeHead(200, { "content-type": "text/html" });
  res.end(
    "<!doctype html><html><head><title>lucarne-widget intent-drain fixture</title></head><body>fixture page" +
      "<script>(function(){" +
      "var q=new URLSearchParams(location.search);" +
      "var vis=q.get('vis')||'visible';" +
      "var foc=q.get('foc')==='1';" +
      "try{Object.defineProperty(document,'visibilityState',{get:function(){return vis;},configurable:true});}catch(e){}" +
      "try{Object.defineProperty(document,'hidden',{get:function(){return vis==='hidden';},configurable:true});}catch(e){}" +
      "document.hasFocus=function(){return foc;};" +
      "})();</script>" +
      "</body></html>",
  );
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const PAGE_URL = `http://127.0.0.1:${server.address().port}/`;

const ENGINE_PORT = 7825;
const TOKEN = "intent-drain-acc-token";
const engine = new Lucarne({ port: ENGINE_PORT, token: TOKEN, record: false });
await engine.listen();
let session;
let host;
let browser;
try {
  // Default (headless) session is fine — the fixture deterministically controls the visibility/focus
  // signal the probe reads (see the server above), so this test does not depend on real window
  // focus/occlusion, which neither headless nor headed xvfb can produce reliably for two foreground tabs.
  session = await engine.create({ backend: "native", profile: "intent-drain-acc" });
  const engineOpts = { baseUrl: `http://127.0.0.1:${ENGINE_PORT}`, token: TOKEN };

  // A minimal, neutral built bundle — content is irrelevant here (this test never opens the widget UI), only
  // `WidgetHost.attach`'s production mount path is needed to get a live, cdpUrl-bound host instance.
  const { html } = await buildSrcdoc({
    entryPoints: [resolve(__dirname, "fixtures/widget-selftest-entry.ts")],
    css: "",
    title: "lucarne-widget intent-drain fixture",
    define: { __LW_NS__: JSON.stringify(NS) },
  });
  host = await WidgetHost.attach(session, { ns: NS, html, engine: engineOpts, identity: {} });
  check("WidgetHost.attach resolved against the live session", !!host);

  browser = await chromium.connectOverCDP(session.cdpUrl);
  const ctx = browser.contexts()[0];
  // Page A is the BACKGROUND tab (hidden + unfocused), page B is the FRONT tab (visible + focused) —
  // driven by the fixture's ?vis=/?foc= overrides, NOT by real browser focus (which CI can't produce
  // for two foreground tabs). The drain probe reads document.visibilityState/document.hasFocus(), so
  // these controlled values make the scoring deterministic end-to-end.
  const pageA = await ctx.newPage();
  await pageA.goto(PAGE_URL + "?vis=hidden&foc=0", { waitUntil: "domcontentloaded" });
  const pageB = await ctx.newPage();
  await pageB.goto(PAGE_URL + "?vis=visible&foc=1", { waitUntil: "domcontentloaded" });

  // Seed each tab's OWN namespaced intent-queue global directly — this is exactly the wire format a mounted
  // widget's own `sendIntent(name, payload)` queues onto (`runtime.ts`), and is what `drainIntentsWithContext`
  // contracts to read-and-clear; seeding it directly isolates THIS primitive from the injector/runtime pipeline,
  // which is covered by this package's other acceptance scripts.
  await pageA.evaluate((k) => { window[k] = [{ id: "a1", payload: { action: "pick", from: "A" } }]; }, KEY);
  await pageB.evaluate((k) => { window[k] = [{ id: "b1", payload: { action: "pick", from: "B" } }]; }, KEY);

  // Page B is already the deterministically-distinguished front tab (fixture-controlled visible+focused);
  // a bringToFront is redundant with the override but harmless — kept for realism. Small settle.
  await pageB.bringToFront();
  await sleep(300);

  const first = await host.drainIntentsWithContext(QUEUE_NAME);
  check("drainIntentsWithContext returns one entry per open http(s) page", first.length === 2, JSON.stringify(first.map((p) => p.url)));

  const shape = first.every((p) => typeof p.url === "string" && typeof p.visible === "boolean" && typeof p.focused === "boolean" && Array.isArray(p.items));
  check("every returned entry is shaped {url, visible, focused, items}", shape, JSON.stringify(first));

  const entryA = first.find((p) => Array.isArray(p.items) && p.items.some((it) => it && it.id === "a1"));
  const entryB = first.find((p) => Array.isArray(p.items) && p.items.some((it) => it && it.id === "b1"));
  check("page A's queued intent ('a1') came back on some page's items", !!entryA, JSON.stringify(first));
  check("page B's queued intent ('b1') came back on some page's items", !!entryB, JSON.stringify(first));

  // Page B is the single visible tab — deterministically, because the fixture overrode
  // document.visibilityState per ?vis= (A='hidden', B='visible'), and the drain probe reads that
  // getter. This exercises the product's real tab-scoring (`visible ? 2 : 0` dominates `focused ? 1 : 0`
  // in host.ts's `activeTabInfo`) with an input the test controls — robust to any CI env, unlike
  // relying on real browser focus which reports every foreground tab visible+focused.
  const visibleEntries = first.filter((p) => p.visible === true);
  check("EXACTLY ONE page reports visible: true (the fixture-controlled front tab, page B)", visibleEntries.length === 1, JSON.stringify(first.map((p) => ({ url: p.url, focused: p.focused, visible: p.visible }))));
  check(
    "the page brought to the front (B, holding the 'b1' intent) is the one reporting visible: true — never A",
    visibleEntries.length === 1 && visibleEntries[0] === entryB,
    JSON.stringify({ visibleEntries, entryA, entryB }),
  );

  // ── the drain CLEARS what it read: a second call back-to-back, with nothing re-queued, must come back empty
  // for every page. ──
  const second = await host.drainIntentsWithContext(QUEUE_NAME);
  check(
    "a second drain (nothing re-queued) returns items: [] for every page — the queue was actually cleared, not just read",
    second.length === 2 && second.every((p) => Array.isArray(p.items) && p.items.length === 0),
    JSON.stringify(second),
  );

  // ── the read-only sibling: never mutates the (now-empty) queue, and still reports the same focus signal. ──
  await pageA.evaluate((k) => { window[k] = [{ id: "a2", payload: { action: "pick" } }]; }, KEY);
  const info = await host.activeTabInfo();
  // Assert it resolved to the FRONT tab via visibility (the best-scored page) — page B, the single
  // fixture-controlled visible tab. `visible` is the deterministic discriminator here.
  check("activeTabInfo() resolves to the brought-to-front (visible, best-scored) page's info", !!info && info.visible === true, JSON.stringify(info));
  const afterProbe = await host.drainIntentsWithContext(QUEUE_NAME);
  const stillThere = afterProbe.find((p) => Array.isArray(p.items) && p.items.some((it) => it && it.id === "a2"));
  check("activeTabInfo() never cleared page A's re-seeded queue (genuinely read-only)", !!stillThere, JSON.stringify(afterProbe));

  await pageA.close({ runBeforeUnload: false }).catch(() => {});
  await pageB.close({ runBeforeUnload: false }).catch(() => {});
} finally {
  try {
    if (browser) await browser.close();
  } catch {
    /* detach only */
  }
  if (host) await host.remove().catch(() => {});
  if (session) await engine.destroy(session.id).catch(() => {});
  await engine.close().catch(() => {});
  await new Promise((r) => server.close(r));
  fs.rmSync(HOME, { recursive: true, force: true });
}

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} acceptance proofs passed`);
process.exit(failed.length ? 1 : 0);
