// LS-27 acceptance proof — per-tab targeting with a REAL lucarne session + REAL Chrome, over
// InteractSession. Needs Google Chrome installed; run via `npm run test:acceptance` in CI (the
// repo's acceptance job installs Chrome+xvfb and runs `npm run test:acceptance --workspaces
// --if-present`). This sandbox HAS a Chrome binary (playwright's bundled Chromium-for-Testing) but
// cannot actually launch it — the native backend needs Chrome's own sandbox init, which requires
// unprivileged user namespaces this container blocks (no CAP_SYS_ADMIN); see PROOF-LS-01.md for
// the prior, identically-rooted finding on the unmoved base commit. So this file is WRITTEN and
// reviewed here, CI-gated, same as test/acceptance.mjs already is — not a new limitation.
//
// Modeled on test/acceptance.mjs's style (a real embedded `Lucarne` engine + a tiny self-contained
// local site — no internet needed). Proves:
//   1. `useTarget(targetId)` redirects `snap()` to the bound tab, not `pages()[0]`.
//   2. The constructor's `{ targetId }` option does the same at construction time.
//   3. `useTarget(null)` un-binds back to today's original `pages()[0]` default.
//   4. `type()` + the SEND path (`send()`) both land on the bound tab — a send must never fire on
//      the wrong tab (LS-27's proof requirement) — proven by an instrumented submit that flips a
//      marker ONLY on the bound page's own `window`, while the OTHER open tab's marker stays false.
//   5. `open(url, { newTab: true })` opens a genuinely NEW tab (does not clobber/navigate a tab
//      that was already open) and rebinds this session to it.
import { Lucarne } from "lucarne";
import { chromium } from "playwright-core";
import { InteractSession } from "../dist/index.js";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const results = [];
const check = (name, pass, detail = "") => {
  results.push({ name, pass: !!pass });
  console.log(`  ${pass ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
};

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "lucarne-interact-multitab-"));
process.env.LUCARNE_HOME = HOME;
if (!("LUCARNE_HEADLESS" in process.env)) process.env.LUCARNE_HEADLESS = "1";

// Two distinguishable pages + an instrumented submit-marker form on EACH, so a check can tell
// WHICH tab a verb actually acted on (not just "some tab changed").
const PAGE_A_HTML = `<!doctype html><html><body>
  <h1 id="hdr">Tab A</h1>
  <form id="f" onsubmit="window.__submitted='A';return false;">
    <input id="inp" name="q" autofocus>
    <button id="go" type="submit">go</button>
  </form>
  <script>window.__submitted=false;</script>
</body></html>`;
const PAGE_B_HTML = `<!doctype html><html><body>
  <h1 id="hdr">Tab B</h1>
  <form id="f" onsubmit="window.__submitted='B';return false;">
    <input id="inp" name="q" autofocus>
    <button id="go" type="submit">go</button>
  </form>
  <script>window.__submitted=false;</script>
</body></html>`;
const PAGE_C_HTML = `<!doctype html><html><body><h1 id="hdr">Tab C (freshly opened)</h1></body></html>`;

const server = http.createServer((req, res) => {
  if (req.url === "/a") { res.writeHead(200, { "content-type": "text/html" }); res.end(PAGE_A_HTML); }
  else if (req.url === "/b") { res.writeHead(200, { "content-type": "text/html" }); res.end(PAGE_B_HTML); }
  else if (req.url === "/c") { res.writeHead(200, { "content-type": "text/html" }); res.end(PAGE_C_HTML); }
  else { res.writeHead(404); res.end("not found"); }
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const PORT = server.address().port;
const BASE = `http://127.0.0.1:${PORT}`;

const engine = new Lucarne({ port: 7823, token: "t", record: false });
await engine.listen();
let session;
try {
  session = await engine.create({ backend: "native", profile: "multitab-acc" });

  const FAST_PACING = {
    nav: { mean: 20, sd: 5, min: 10 },
    scroll: { mean: 20, sd: 5, min: 10 },
    read: { mean: 20, sd: 5, min: 10 },
    act: { mean: 20, sd: 5, min: 10 },
  };

  // ── open tab A (this session's original tab), then a SECOND real tab (B) via a raw playwright
  // connection — exactly how a real second browser tab comes to exist; InteractSession never
  // opens it. ──
  const seed = new InteractSession(session, { pacing: FAST_PACING, timeoutMs: 15000 });
  await seed.open(`${BASE}/a`);

  const { chromium: pwChromium } = { chromium };
  const b = await pwChromium.connectOverCDP(session.cdpUrl);
  const ctx = b.contexts()[0];
  const pageB = await ctx.newPage();
  await pageB.goto(`${BASE}/b`, { waitUntil: "domcontentloaded" });

  const listed = await engine.tabs(session.id);
  check("engine now reports 2 open tabs (A opened by InteractSession, B opened directly)", listed.tabs.length === 2, JSON.stringify(listed));
  const tabA = listed.tabs.find((t) => t.url.endsWith("/a"));
  const tabB = listed.tabs.find((t) => t.url.endsWith("/b"));
  check("both tabs resolvable by url", !!tabA && !!tabB);

  // ── 1. useTarget(tabB.id) redirects a READ to tab B, not pages()[0] (tab A) ──
  const s1 = new InteractSession(session, { pacing: FAST_PACING, timeoutMs: 15000 });
  s1.useTarget(tabB.id);
  const snapB = await s1.snap("h1");
  check("useTarget(tabB) → snap() reads TAB B (not pages()[0]/tab A)", /Tab B/.test(snapB), snapB);

  // ── 2. the constructor's { targetId } option does the same, at construction time ──
  const s2 = new InteractSession(session, { pacing: FAST_PACING, timeoutMs: 15000, targetId: tabA.id });
  const snapA = await s2.snap("h1");
  check("constructor { targetId: tabA } → snap() reads TAB A", /Tab A/.test(snapA), snapA);

  // ── 3. useTarget(null) un-binds — falls back to today's original pages()[0] ──
  s2.useTarget(null);
  const snapUnbound = await s2.snap("h1");
  check("useTarget(null) un-binds → falls back to pages()[0] (today's original default)", /Tab A/.test(snapUnbound), snapUnbound);

  // ── 4. type() + send() land on the BOUND tab (B), never on the other open tab (A) — the
  // core anti-footgun this ticket exists for: a send must never fire on the wrong tab. ──
  const s3 = new InteractSession(session, { pacing: FAST_PACING, timeoutMs: 15000, targetId: tabB.id });
  await s3.type("hello from tab B");
  const typedInto = await pageB.locator("#inp").inputValue();
  check("type() staged text into the BOUND tab (B)'s composer", typedInto === "hello from tab B", typedInto);
  const otherUnaffected = await b.contexts()[0].pages().find((p) => p.url().endsWith("/a"))?.locator("#inp").inputValue();
  check("the OTHER open tab (A)'s composer is untouched", otherUnaffected === "", otherUnaffected);

  const sendPolicy = async () => ({ ok: true, blocked: false, mustAsk: false, violations: [] });
  const sendResult = await s3.send("hello from tab B", { gesture: { key: "Enter" }, policy: sendPolicy, approval: { mode: "yolo", approved: false, ack: false } });
  check("send() actually sent (staged text matched, composer check passed)", sendResult.sent === true, JSON.stringify(sendResult));
  const submittedB = await pageB.evaluate(() => window.__submitted);
  const submittedA = await b.contexts()[0].pages().find((p) => p.url().endsWith("/a"))?.evaluate(() => window.__submitted);
  check("send() fired on TAB B (its onsubmit marker flipped to 'B')", submittedB === "B", submittedB);
  check("send() did NOT fire on tab A (a send must never fire on the wrong tab)", submittedA === false, submittedA);

  // ── 5. open(url, { newTab: true }) opens a genuinely NEW tab (feed's origin-app semantic) —
  // does not clobber tab A or tab B in place — and rebinds this session to it. ──
  const s4 = new InteractSession(session, { pacing: FAST_PACING, timeoutMs: 15000, targetId: tabA.id });
  const openRes = await s4.open(`${BASE}/c`, { newTab: true });
  const afterOpen = await engine.tabs(session.id);
  check("open({newTab:true}) results in a THIRD tab existing (A and B both still open)", afterOpen.tabs.length === 3, JSON.stringify(afterOpen));
  check("open({newTab:true}) returns the new tab's targetId", typeof openRes.targetId === "string" && openRes.targetId.length > 0, openRes.targetId);
  const stillA = await engine.tabs(session.id).then((t) => t.tabs.find((x) => x.url.endsWith("/a")));
  check("tab A was NOT navigated/clobbered by the newTab open", !!stillA, JSON.stringify(stillA));
  const snapC = await s4.snap("h1");
  check("this session is now bound to the NEW tab (rebound by open({newTab:true}))", /Tab C/.test(snapC), snapC);

  await b.close();
} finally {
  if (session) await engine.destroy(session.id).catch(() => {});
  await engine.close?.();
  server.close();
}

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
if (failed.length) {
  console.error(`FAILED: ${failed.map((f) => f.name).join(", ")}`);
  process.exit(1);
}
