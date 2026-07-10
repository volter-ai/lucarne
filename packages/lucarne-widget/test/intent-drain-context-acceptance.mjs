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
const server = http.createServer((_req, res) => {
  res.writeHead(200, { "content-type": "text/html" });
  res.end("<!doctype html><html><head><title>lucarne-widget intent-drain fixture</title></head><body>fixture page</body></html>");
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
  const pageA = await ctx.newPage();
  await pageA.goto(PAGE_URL, { waitUntil: "domcontentloaded" });
  const pageB = await ctx.newPage();
  await pageB.goto(PAGE_URL, { waitUntil: "domcontentloaded" });

  // Seed each tab's OWN namespaced intent-queue global directly — this is exactly the wire format a mounted
  // widget's own `sendIntent(name, payload)` queues onto (`runtime.ts`), and is what `drainIntentsWithContext`
  // contracts to read-and-clear; seeding it directly isolates THIS primitive from the injector/runtime pipeline,
  // which is covered by this package's other acceptance scripts.
  await pageA.evaluate((k) => { window[k] = [{ id: "a1", payload: { action: "pick", from: "A" } }]; }, KEY);
  await pageB.evaluate((k) => { window[k] = [{ id: "b1", payload: { action: "pick", from: "B" } }]; }, KEY);

  // Bring page B to the front — playwright's `bringToFront` activates that target via CDP, so it (and only it)
  // should report both visible AND focused on the next probe.
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

  // Distinguish the front tab via document.visibilityState, NOT document.hasFocus(): in headless CI
  // (xvfb, the CI acceptance job) there is no real OS window focus, so `document.hasFocus()` returns
  // true for EVERY page and "exactly one focused" is not a reliable discriminator. The signal CDP's
  // `bringToFront` DOES produce headless is visibilityState — the activated target goes 'visible' and
  // the others go 'hidden' — which is exactly what the product's own tab-scoring weights most heavily
  // (`visible ? 2 : 0` dominates `focused ? 1 : 0` in host.ts's `activeTabInfo`). So assert the real
  // property (the brought-to-front tab is the single distinguished/best-scored one) through visibility.
  const visibleEntries = first.filter((p) => p.visible === true);
  check("EXACTLY ONE page reports visible: true (the brought-to-front tab — robust headless, unlike hasFocus)", visibleEntries.length === 1, JSON.stringify(first.map((p) => ({ url: p.url, focused: p.focused, visible: p.visible }))));
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
  // Assert it resolved to the FRONT tab via visibility (the best-scored page) — robust headless, where
  // every page reports focused:true. `visible` is the discriminator CDP bringToFront actually moves.
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
