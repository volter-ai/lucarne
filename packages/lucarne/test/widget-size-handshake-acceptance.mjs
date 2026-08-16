// The LIVE proof for the size handshake (`src/widget/size-handshake.ts`), on a real page in a real session —
// the Chrome-bound sibling of `test/widget-size-handshake.mjs` (which proves the state machine itself, offline).
//
// THE DEFECT IT REPRODUCES: the host page's `message` listener is armed inside `injector.ts`'s one-time guard
// block, and the iframe used to post its measured size exactly ONCE. Any ordering where that first post lands
// before the listener is armed dropped it forever (the anti-jitter rule suppresses a re-post of an unchanged
// size, and a collapsed pill never changes size again) — the host stayed at its boot size with a small pill
// stranded inside an oversized glass card. Live, that race was roughly a coin flip; you cannot prove a fix by
// re-running it and getting lucky.
//
// So this FORCES the losing side of the race: a second sticky injection, registered BEFORE the widget's, patches
// the top frame's `window.addEventListener` so every `message` listener registration is deferred by
// `DELAY_MS` — i.e. the injector's own listener provably does not exist when the iframe's first size post
// arrives. Convergence anyway is the whole claim. Run 2 is the same page with the shim gone (the control).
//
// The measurement each run reports is the one the user actually sees: the HOST element's size versus the size of
// the `.pill` drawn inside its iframe. They must agree — a stranded pill is exactly the two disagreeing.
//
// Needs Google Chrome (like every other acceptance proof here); run via `npm run test:acceptance`.
import { createServer } from "node:http";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Lucarne, LucarneClient } from "lucarne";
import { buildSrcdoc } from "../dist/widget/build.js";
import { SHELL_CSS } from "../dist/widget/index.js";
import { WidgetHost } from "../dist/widget/host.js";
import { attachPage, listPages } from "../dist/widget/cdp-lite.js";
import { hostElementId } from "../dist/widget/ns.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

const results = [];
const check = (name, pass, detail = "") => {
  results.push({ name, pass: !!pass });
  console.log(`  ${pass ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "lucarne-size-acc-"));
process.env.LUCARNE_HOME = HOME;
if (!("LUCARNE_HEADLESS" in process.env)) process.env.LUCARNE_HEADLESS = "1";

const NS = "wsizetest";
const HOST_ID = hostElementId(NS);
const DELAY_MS = 2500; // comfortably longer than the handshake's 400ms retry interval — several posts are provably lost
const BOOT = { w: 220, h: 44 }; // injector.ts's boot size, before any size lands

// The shim: defer every `message` listener the TOP frame registers. Top-frame-only, so the widget's own iframe
// runtime (a subframe) keeps its listener immediately — the ONLY thing under test here is the host page's
// arming order, exactly the race measured in the wild.
const DELAY_SHIM = `(function(){
  try { if (window.top !== window.self) return; } catch(e) { return; }
  var orig = window.addEventListener;
  window.addEventListener = function(type, cb, opts){
    if (type === 'message') { setTimeout(function(){ try{ orig.call(window, type, cb, opts); }catch(_){} }, ${DELAY_MS}); return; }
    return orig.call(window, type, cb, opts);
  };
})();`;

// A plain local page to mount on — a REAL http document (not a data: tab), which is what the live measurement was.
const PAGE_HTML = `<!doctype html><html><head><meta charset=utf-8><title>size handshake proof</title></head>
<body style="margin:0;background:#0b0d12;height:1600px"></body></html>`;

const MARKER = `size handshake ${Date.now()}`;
const CSS = `${SHELL_CSS}\n.marker { color: #5fd99a; font-weight: 600 }`;
const { html } = await buildSrcdoc({
  entryPoints: [resolve(__dirname, "widget-fixtures/widget-selftest-entry.ts")],
  css: CSS,
  title: "lucarne widget size-handshake fixture",
  define: { __LW_NS__: JSON.stringify(NS) },
});
check("built the neutral fixture srcdoc bundle", html.trim().toLowerCase().startsWith("<!doctype html>"), `${html.length} bytes`);

// The one expression this proof evaluates in the page: the HOST element's rendered size next to the size of the
// `.wrap` the iframe actually draws (the element `runtime.ts` measures and posts). Those two agreeing IS the
// contract; a stranded pill/panel is exactly the two disagreeing. Read through the shadow root + the
// (same-origin) iframe document — nothing private, only what a user could see.
const SIZE_EXPR = `(function(){
  var h = document.getElementById(${JSON.stringify(HOST_ID)});
  if (!h) return null;
  var hr = h.getBoundingClientRect();
  var ifr = h.shadowRoot && h.shadowRoot.querySelector('iframe');
  var doc = ifr && ifr.contentWindow && ifr.contentWindow.document;
  var wrap = doc && doc.querySelector('.wrap');
  var wr = wrap && wrap.getBoundingClientRect();
  return {
    host: [Math.round(hr.width), Math.round(hr.height)],
    wrap: wr ? [Math.round(wr.width), Math.round(wr.height)] : null,
    open: !!(doc && doc.querySelector('.panel')),
  };
})()`;

/** Open the shell's panel through its own generic `.pill` control (the same door `selftest.ts` uses) — the panel is MUCH larger than the boot size, which is what makes a lost size post unmistakable rather than a 2px difference. */
const CLICK_PILL_EXPR = `(function(){
  var h = document.getElementById(${JSON.stringify(HOST_ID)});
  var ifr = h && h.shadowRoot && h.shadowRoot.querySelector('iframe');
  var doc = ifr && ifr.contentWindow && ifr.contentWindow.document;
  var btn = doc && doc.querySelector('.pill');
  if (btn) btn.click();
  return !!btn;
})()`;

const server = createServer((_req, res) => {
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  res.end(PAGE_HTML);
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const PAGE_URL = `http://127.0.0.1:${server.address().port}/`;

const ENGINE_PORT = 7824;
const TOKEN = "widget-size-handshake-acc-token";
const engine = new Lucarne({ port: ENGINE_PORT, token: TOKEN, record: false });
await engine.listen();
const client = new LucarneClient({ baseUrl: `http://127.0.0.1:${ENGINE_PORT}`, token: TOKEN });

let session;
let host;
try {
  session = await engine.create({ backend: "native", profile: "widget-size-handshake-acc" });

  /** Attach to the session's first real page and return a handle that survives navigation. */
  async function openPage() {
    const targets = await listPages(session.cdpUrl);
    const target = targets.find((t) => !(t.url || "").startsWith("devtools:")) ?? targets[0];
    return attachPage(session.cdpUrl, target);
  }
  const page = await openPage();

  /**
   * Load the proof page fresh, OPEN THE PANEL as fast as the shell allows (so the size that must land is far
   * from the boot size, not a couple of px from it), then sample host-vs-wrap until they agree.
   */
  async function run(label, budgetMs) {
    await page.evaluate(`location.href = ${JSON.stringify(PAGE_URL)}; 'nav'`);
    const t0 = Date.now();
    let last = null;
    let settledAt = null;
    let opened = false;
    while (Date.now() - t0 < budgetMs) {
      await sleep(150);
      let s;
      try {
        if (!opened) opened = (await page.evaluate(CLICK_PILL_EXPR)) === true; // fires well inside the delay window
        s = await page.evaluate(SIZE_EXPR);
      } catch {
        continue; // mid-navigation eval — try the next sample
      }
      if (!s) continue;
      last = s;
      if (s.open && s.wrap && Math.abs(s.host[0] - s.wrap[0]) <= 4 && Math.abs(s.host[1] - s.wrap[1]) <= 4) {
        settledAt = Date.now() - t0;
        break;
      }
    }
    // hold it for a moment and re-read: a size that lands must also STAY (no re-post storm walking it around)
    await sleep(1200);
    const after = await page.evaluate(SIZE_EXPR).catch(() => null);
    console.log(`    [${label}] settledAt=${settledAt === null ? "NEVER" : settledAt + "ms"} last=${JSON.stringify(last)} after=${JSON.stringify(after)}`);
    return { settledAt, last, after };
  }

  // ── RUN 1: the FORCED RACE — the host page's message listener does not exist for the first DELAY_MS. ──
  await client.setInjection(session.id, { id: "size-handshake-delay-shim", source: DELAY_SHIM, bypassCSP: true });
  host = await WidgetHost.attach({ id: session.id, cdpUrl: session.cdpUrl }, { ns: NS, html, engine: { baseUrl: `http://127.0.0.1:${ENGINE_PORT}`, token: TOKEN }, identity: { profile: "size-acc" } });
  await host.push({ marker: MARKER, items: ["first neutral item"] });

  const raced = await run(`listener delayed ${DELAY_MS}ms`, 15000);
  check(
    `RACE: with the host's message listener armed ${DELAY_MS}ms LATE, the size still lands (host size === the size the iframe draws)`,
    raced.settledAt !== null,
    JSON.stringify(raced.last),
  );
  check(
    "RACE: the host is NOT left at its boot size (the stranded-panel symptom this fix exists for)",
    !!raced.last && (Math.abs(raced.last.host[0] - BOOT.w) > 20 || Math.abs(raced.last.host[1] - BOOT.h) > 20),
    `boot=${BOOT.w}x${BOOT.h} host=${raced.last ? raced.last.host.join("x") : "none"}`,
  );
  check(
    "RACE: the settled size then STAYS settled (the retry loop stopped on the ack — no size walk)",
    !!raced.after && !!raced.last && raced.after.host[0] === raced.last.host[0] && raced.after.host[1] === raced.last.host[1],
    JSON.stringify({ atSettle: raced.last?.host, aSecondLater: raced.after?.host }),
  );
  check(
    "RACE: convergence had to WAIT for the delayed listener (proving the first post really was lost, not a lucky ordering)",
    raced.settledAt !== null && raced.settledAt >= DELAY_MS,
    `settledAt=${raced.settledAt}ms delay=${DELAY_MS}ms`,
  );

  // ── RUN 2: the CONTROL — same page, shim removed: the first post is heard and the size lands immediately. ──
  await client.removeInjection(session.id, "size-handshake-delay-shim");
  const control = await run("no delay (control)", 15000);
  check("CONTROL: with no artificial delay the size lands too (host size === the size the iframe draws)", control.settledAt !== null, JSON.stringify(control.last));
  check(
    "CONTROL: and it lands FAST — well before the raced run could (the ack path costs nothing on the normal ordering)",
    control.settledAt !== null && control.settledAt < DELAY_MS,
    `control=${control.settledAt}ms raced=${raced.settledAt}ms`,
  );

  page.close();
} finally {
  if (host) await host.remove().catch(() => {});
  if (session) await engine.destroy(session.id).catch(() => {});
  await engine.close().catch(() => {});
  await new Promise((r) => server.close(r));
  fs.rmSync(HOME, { recursive: true, force: true });
}

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} acceptance proofs passed`);
process.exit(failed.length ? 1 : 0);
