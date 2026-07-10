// Acceptance proofs — each asserts REAL behavior end-to-end, not a 200.
// "Done" for a feature means its proof here passes. Run: npm run test:acceptance
// (needs Google Chrome installed — exercises the native backend.)
import { Lucarne, LucarneClient, VERSION } from "../dist/index.js";
import { nativeBackend } from "../dist/backends/native.js";
import { pickPublicUrl, tunnelSpawnSpec, ensureTunnelToken, startTunnel } from "../dist/tunnel.js";
import { isWebNavUrl } from "../dist/session-media.js";
import { globalFilesDir } from "../dist/profiles.js";
import net from "node:net";
import { attachPage, attachBrowser } from "../dist/cdp.js";
import { virtualKeyCode } from "../dist/keymap.js";
import { startRecorder } from "../dist/recorder.js";
import { totpCode } from "../dist/credentials.js";
import { chromium } from "playwright";
import WS, { WebSocketServer } from "ws";
import http from "node:http";
import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";

// Durable profiles must be isolated + reclaimable across runs.
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "lucarne-acc-"));
const FILES = fs.mkdtempSync(path.join(os.tmpdir(), "lucarne-files-"));
process.env.LUCARNE_HOME = HOME;
// Run the suite HEADLESS by default — no window, no focus steal (the suite spins
// up ~25 Chromes). Headful is verified by the one gated `headed:` proof
// (LUCARNE_TEST_HEADED=1, set in CI). Set LUCARNE_HEADLESS=0 to force headful.
if (!("LUCARNE_HEADLESS" in process.env)) process.env.LUCARNE_HEADLESS = "1";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// A FRESH Playwright `connectOverCDP()` discovers targets asynchronously, so
// `browser.contexts()[0].pages()[0]` can be momentarily `undefined` right after connect even though
// the session already has a page target (`create()` doesn't resolve until its media plane attached
// one). Poll briefly for the existing page before falling back to opening one, so a bare `pages()[0]`
// grab never `undefined`-crashes under CI load.
const firstPage = async (browser, timeoutMs = 10000) => {
  const ctx = browser.contexts()[0];
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const pg = ctx?.pages()[0];
    if (pg) return pg;
    if (Date.now() >= deadline) return await ctx.newPage();
    await sleep(150);
  }
};

// Wait until the coalesced "alice" type-run has actually been FLUSHED and recorded (unredacted),
// so its flush-time secrecy re-read provably ran while #u was still focused — BEFORE we move focus
// to #pw. Removes the race where a load-delayed async end-read sees the later #pw focus and
// over-redacts "alice". Bounded; throws (setup failure surfaces, never silently proceeds).
const pollActivity = async (eng, profile, pred, timeoutMs = 3000, label = "") => {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const acts = eng.sessionActivity(profile).filter((a) => a.kind === "type");
    if (pred(acts)) return acts;
    if (Date.now() >= deadline) throw new Error(`P0 setup: activity condition never met${label ? " (" + label + ")" : ""}: ${JSON.stringify(eng.sessionActivity(profile))}`);
    await sleep(100);
  }
};

const results = [];
const check = (name, pass, detail = "") => {
  results.push({ name, pass: !!pass });
  console.log(`  ${pass ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
};

const PORT = 7811, TOKEN = "t", ID = "acc";
const WSURL = `ws://127.0.0.1:${PORT}/sessions/${ID}/view/ws?token=${TOKEN}`;
const engine = new Lucarne({ port: PORT, token: TOKEN, record: false });
await engine.listen();
let session;
try {
  session = await engine.create({ backend: "native", profile: ID });

  // 1. DRIVE — vanilla Playwright over the returned cdpUrl
  let b = await chromium.connectOverCDP(session.cdpUrl);
  let p = await firstPage(b);
  await p.goto("https://example.com", { waitUntil: "domcontentloaded" });
  check("drive: connectOverCDP navigates real Chrome", (await p.title()) === "Example Domain");
  await p.goto("about:blank");
  await p.evaluate(() => {
    document.body.innerHTML = '<input id=i><textarea id=t>hello world foo</textarea>';
    document.getElementById("i").focus();
  });
  await b.close();

  // 2. PORTHOLE — a real JPEG frame arrives over the WebSocket
  const frame = await new Promise((res, rej) => {
    const w = new WS(WSURL);
    w.on("message", (d) => { w.close(); res(d); });
    w.on("error", rej);
    setTimeout(() => rej(new Error("no frame in 5s")), 5000);
  }).catch((e) => e);
  check("porthole: receives a JPEG frame over WS", Buffer.isBuffer(frame) && frame.length > 1000 && frame[0] === 0xff && frame[1] === 0xd8,
    Buffer.isBuffer(frame) ? `${frame.length}B, JPEG magic ok` : String(frame.message));

  // 3. INPUT PARITY — caps/shift, and Cmd+A editing command, reach real Chrome
  b = await chromium.connectOverCDP(session.cdpUrl);
  p = await firstPage(b);
  // self-contained: re-create the fields if the about:blank DOM didn't survive the
  // reconnect (keeps the input proofs robust on slower/CI machines)
  await p.evaluate(() => {
    if (!document.getElementById("i")) document.body.innerHTML = '<input id=i><textarea id=t>hello world foo</textarea>';
    document.getElementById("i").focus();
  });
  const iw = new WS(WSURL);
  await new Promise((r, j) => { iw.on("open", r); iw.on("error", j); });
  const key = (k, mod = 0, code = "") => { iw.send(JSON.stringify({ t: "keydown", key: k, code, mod })); iw.send(JSON.stringify({ t: "keyup", key: k, code, mod })); };
  for (const [k, c] of [["H", "KeyH"], ["i", "KeyI"], ["!", "Digit1"]]) key(k, k === "H" || k === "!" ? 8 : 0, c);
  await sleep(300);
  check("input: caps + shifted typing reaches real Chrome", (await p.evaluate(() => document.getElementById("i").value)) === "Hi!");
  await p.evaluate(() => document.getElementById("t").focus());
  key("a", 4, "KeyA"); // Cmd+A
  await sleep(250);
  check("input: Cmd+A select-all (CDP editing command)", (await p.evaluate(() => { const t = document.getElementById("t"); return t.selectionEnd - t.selectionStart; })) === 15);

  // 5. CLIPBOARD PASTE — text pasted in the porthole lands in the focused field
  await p.evaluate(() => { const i = document.getElementById("i"); i.value = ""; i.focus(); });
  iw.send(JSON.stringify({ t: "paste", text: "pw-9f3!" }));
  await sleep(250);
  check("clipboard: paste delivers text into focused input", (await p.evaluate(() => document.getElementById("i").value)) === "pw-9f3!");
  iw.close();

  // 6. FILE UPLOAD — inject a host file into <input type=file>; page sees name + bytes.
  // Uploads are confined to the daemon's files workspace (security), so stage it in
  // the global /files dir first — the documented flow.
  const upBytes = crypto.randomBytes(2048);
  const upSha = crypto.createHash("sha256").update(upBytes).digest("hex");
  const upPath = path.join(globalFilesDir(), "up.bin");
  fs.mkdirSync(globalFilesDir(), { recursive: true });
  fs.writeFileSync(upPath, upBytes);
  await p.evaluate(() => document.body.insertAdjacentHTML("beforeend", "<input id=f type=file>"));
  await engine.uploadFile(session.id, upPath);
  const rep = await p.evaluate(async () => {
    const f = document.getElementById("f").files[0];
    if (!f) return null;
    return { name: f.name, bytes: Array.from(new Uint8Array(await f.arrayBuffer())) };
  });
  const pageSha = rep ? crypto.createHash("sha256").update(Buffer.from(rep.bytes)).digest("hex") : null;
  check("upload: file input reports matching name + sha256", !!rep && rep.name === "up.bin" && pageSha === upSha);
  // security: an out-of-workspace host path is REFUSED (no arbitrary host-file exfil).
  // Stage a REAL file outside the workspace (realpath needs it to exist) and confirm refusal.
  const outsideFile = path.join(os.tmpdir(), `lucarne-outside-${Date.now()}.bin`);
  fs.writeFileSync(outsideFile, "SECRET");
  let upRej = "";
  try { await engine.uploadFile(session.id, outsideFile); } catch (e) { upRej = e.message; }
  fs.rmSync(outsideFile, { force: true });
  check("upload(security): a path outside the files workspace is refused", /inside the session files workspace/.test(upRej));
  await b.close();
} finally {
  if (session) await engine.destroy(session.id).catch(() => {});
  await engine.close().catch(() => {});
}

// ── P0: persistence ────────────────────────────────────────────────────────
// Cookies must survive a profile being destroyed and recreated by the same name,
// and must transfer when a fresh profile is SEEDED from an existing one.
const COOKIE = { name: "lucarne_acc", value: "kept-" + ID, url: "https://example.com", expires: 2000000000 };
const readCookie = async (cdpUrl) => {
  const b = await chromium.connectOverCDP(cdpUrl);
  const got = (await b.contexts()[0].cookies("https://example.com")).find((c) => c.name === COOKIE.name);
  await b.close();
  return got?.value;
};

const pEngine = new Lucarne({ port: 7812, token: TOKEN, record: false });
await pEngine.listen();
try {
  // seed a durable profile with a persistent cookie, then flush it to disk
  let s1 = await pEngine.create({ backend: "native", profile: "persist-A" });
  let b = await chromium.connectOverCDP(s1.cdpUrl);
  await b.contexts()[0].addCookies([COOKIE]);
  await b.close();
  check("persist: cookie set in profile", (await readCookie(s1.cdpUrl)) === COOKIE.value);
  await pEngine.destroy(s1.id); // graceful flush + Chrome exits; profile dir kept

  // recreate the SAME profile — the cookie must still be there
  let s2 = await pEngine.create({ backend: "native", profile: "persist-A" });
  check("persist: cookie survives destroy + recreate (stay logged in)", (await readCookie(s2.cdpUrl)) === COOKIE.value);

  // seed a BRAND-NEW profile from persist-A's user-data-dir — cookie transfers
  const seedSource = path.join(HOME, "profiles", "persist-A");
  let s3 = await pEngine.create({ backend: "native", profile: "seed-B", seedFrom: seedSource });
  check("seed: fresh profile seeded from another carries its cookie", (await readCookie(s3.cdpUrl)) === COOKIE.value);

  // a named profile must NOT re-seed once established: destroy seed-B, then re-create
  // it pointing seedFrom at a DIFFERENT (cookie-less) source — the original cookie
  // must SURVIVE (proving no clobber), not be replaced by the empty source.
  await pEngine.destroy(s3.id);
  const emptySrc = fs.mkdtempSync(path.join(os.tmpdir(), "lucarne-emptyseed-"));
  const s3b = await pEngine.create({ backend: "native", profile: "seed-B", seedFrom: emptySrc });
  check("seed: an established profile is NOT re-seeded (no clobber on reuse)", (await readCookie(s3b.cdpUrl)) === COOKIE.value);
  fs.rmSync(emptySrc, { recursive: true, force: true });
} finally {
  await pEngine.close().catch(() => {});
  fs.rmSync(HOME, { recursive: true, force: true });
  fs.rmSync(FILES, { recursive: true, force: true });
}

// ── P0: download retrieval ──────────────────────────────────────────────────
// The operator triggers a download in the porthole; lucarne captures it to a
// retrievable per-session dir. Driven via raw CDP + the porthole input socket
// (NO Playwright — a Playwright driver manages its own downloads and would
// hijack the capture, which is exactly the path a human operator does NOT take).
const dEngine = new Lucarne({ port: 7813, token: TOKEN, record: false });
await dEngine.listen();
try {
  const dl = await dEngine.create({ backend: "native", profile: "dl" });
  const setup = await attachPage(dl.cdpUrl);
  setup.send("Page.navigate", { url: "https://example.com" });
  await sleep(1200);
  const dlContent = "lucarne-dl-" + ID;
  await setup.call("Runtime.evaluate", {
    expression: `(()=>{const a=document.createElement('a');a.id='dl';a.style='position:fixed;top:8px;left:8px;font-size:50px';a.textContent='DL';`
      + `a.href=URL.createObjectURL(new Blob([${JSON.stringify(dlContent)}],{type:'text/plain'}));a.download='report.txt';document.body.appendChild(a);})()`,
  });
  // click the link through the porthole input socket — the real operator path
  const dw = new WS(`ws://127.0.0.1:7813/sessions/dl/view/ws?token=${TOKEN}`);
  await new Promise((r, j) => { dw.on("open", r); dw.on("error", j); });
  dw.send(JSON.stringify({ t: "down", x: 25, y: 30, button: 0, buttons: 1, clickCount: 1 }));
  dw.send(JSON.stringify({ t: "up", x: 25, y: 30, button: 0, buttons: 0, clickCount: 1 }));
  let dlGot = null;
  for (let i = 0; i < 40 && dlGot === null; i++) {
    await sleep(150);
    const fp = dEngine.downloadPath(dl.id, "report.txt");
    if (fp) dlGot = fs.readFileSync(fp, "utf8");
  }
  dw.close();
  check("download: porthole-triggered download captured + bytes match", dlGot === dlContent && dEngine.downloads(dl.id).includes("report.txt"));

  // ── P1: capture (screenshot + PDF) ────────────────────────────────────────
  const png = await dEngine.screenshot(dl.id);
  const isPng = png.length > 1000 && png[0] === 0x89 && png[1] === 0x50 && png[2] === 0x4e && png[3] === 0x47;
  // PNG IHDR width/height are big-endian u32 at byte offsets 16 and 20
  // height is the content viewport (headful Chrome's tab/toolbar eats some of the window)
  const pngW = png.readUInt32BE(16), pngH = png.readUInt32BE(20);
  check("screenshot: valid PNG at viewport width", isPng && pngW === 1280 && pngH >= 560 && pngH <= 720, `${pngW}x${pngH}, ${png.length}B`);
  const pdf = await dEngine.pdf(dl.id);
  const pdfMagic = pdf.subarray(0, 5).toString("latin1");
  const pages = (pdf.toString("latin1").match(/\/Type\s*\/Page[^s]/g) || []).length;
  check("pdf: valid PDF with >=1 page", pdfMagic === "%PDF-" && pages >= 1, `${pdfMagic} pages=${pages}`);

  // ── P1: health endpoint ───────────────────────────────────────────────────
  const h = dEngine.health();
  check("health: session count == live sessions", h.ok && h.sessions === dEngine.list().length && h.sessions === 1);

  // ── P1: view-only mode (input dropped server-side) ────────────────────────
  await setup.call("Runtime.evaluate", { expression: `(()=>{document.body.innerHTML='<input id=vo>';document.getElementById('vo').focus();})()` });
  const vo = new WS(`ws://127.0.0.1:7813/sessions/dl/view/ws?token=${TOKEN}&interactable=0`);
  await new Promise((r, j) => { vo.on("open", r); vo.on("error", j); });
  for (const k of ["N", "O"]) { vo.send(JSON.stringify({ t: "keydown", key: k, code: "Key" + k, mod: 8 })); vo.send(JSON.stringify({ t: "keyup", key: k, code: "Key" + k, mod: 8 })); }
  await sleep(300);
  const voVal = (await setup.call("Runtime.evaluate", { expression: `document.getElementById('vo').value`, returnByValue: true })).result.value;
  vo.close();
  check("view-only: input is dropped server-side (read-only viewer)", voVal === "");

  // ── P1: touch input (phone gestures) ──────────────────────────────────────
  await setup.call("Runtime.evaluate", { expression: `document.body.innerHTML='<div style="width:100vw;height:100vh"></div>';window.__t=null;document.addEventListener('touchstart',ev=>{const t=ev.changedTouches[0];window.__t={x:t.clientX,y:t.clientY}},{passive:true});'ok'` });
  const tw = new WS(`ws://127.0.0.1:7813/sessions/dl/view/ws?token=${TOKEN}`);
  await new Promise((r, j) => { tw.on("open", r); tw.on("error", j); });
  tw.send(JSON.stringify({ t: "touch", phase: "start", x: 140, y: 160 }));
  tw.send(JSON.stringify({ t: "touch", phase: "end", x: 140, y: 160 }));
  await sleep(300);
  const tr = JSON.parse((await setup.call("Runtime.evaluate", { expression: "JSON.stringify(window.__t)", returnByValue: true })).result.value || "null");
  tw.close();
  check("touch: porthole tap fires page touch handler at mapped coords", !!tr && tr.x === 140 && tr.y === 160);

  setup.close();
} finally {
  await dEngine.close().catch(() => {});
}

// ── P1: session lifecycle (status · inactivity reap · max-duration) ──────────
const lEngine = new Lucarne({ port: 7814, token: TOKEN, record: false, reapIntervalMs: 200 });
await lEngine.listen();
try {
  // rich status
  const ls = await lEngine.create({ backend: "native", profile: "life", inactivityMs: 700 });
  const st = await lEngine.status(ls.id);
  check("status: rich object (uptime + dims)", !!st && st.uptimeMs >= 0 && st.viewport.width === 1280 && st.viewport.height === 720 && typeof st.idleMs === "number");

  // dev/02: status reports the ACTIVE page's url after a real navigation
  const sp = await chromium.connectOverCDP(ls.cdpUrl);
  const spg = sp.contexts()[0].pages()[0] ?? await sp.contexts()[0].newPage();
  await spg.goto("https://example.com/", { waitUntil: "domcontentloaded" });
  await sp.close();
  const st2 = await lEngine.status(ls.id);
  check("status: url + title reflect the active page after navigation", !!st2 && st2.url.includes("example.com") && /example/i.test(st2.title));

  // activity resets the idle clock: touch through the window, stays alive past it
  for (let i = 0; i < 6; i++) { await sleep(200); lEngine.touch(ls.id); }    // ~1.2s of touches, deadline 700ms
  check("inactivity: touch keeps a session alive past its idle window", !!lEngine.get(ls.id));

  // stop touching: reaped after the idle window elapses
  let reaped = false;
  for (let i = 0; i < 20 && !reaped; i++) { await sleep(150); reaped = !lEngine.get(ls.id); }
  check("inactivity: idle session auto-reaped", reaped);

  // max-duration: dies on schedule regardless of activity (touch every tick, still reaped)
  const lt = await lEngine.create({ backend: "native", profile: "life2", maxLifetimeMs: 700 });
  let tReaped = false;
  for (let i = 0; i < 20 && !tReaped; i++) { await sleep(150); lEngine.touch(lt.id); tReaped = !lEngine.get(lt.id); }
  check("timeout: max-duration reaps even an active session", tReaped);

  // act() (agent driving, NO human touch) must reset the idle clock — else an
  // agent-driven inactivity session is reaped mid-work.
  const la = await lEngine.create({ backend: "native", profile: "life3", inactivityMs: 700 });
  for (let i = 0; i < 6; i++) { await sleep(200); await lEngine.act(la.id, { action: "move", x: 5, y: 5 }); }
  check("inactivity: act() (agent driving) keeps the session alive past its idle window", !!lEngine.get(la.id));
  await lEngine.destroy(la.id);

  // double-destroy is idempotent: hammering destroy on one session releases its slot
  // exactly once (a non-idempotent release would corrupt the slot counter).
  const ld = await lEngine.create({ backend: "native", profile: "life4", maxConcurrent: undefined });
  const before = lEngine.list().length;
  await Promise.all(Array.from({ length: 8 }, () => lEngine.destroy(ld.id)));
  const okConc = await lEngine.create({ backend: "native", profile: "life5" });
  check("lifecycle: concurrent double-destroy is idempotent (slot accounting intact)", !lEngine.get(ld.id) && !!lEngine.get(okConc.id) && before >= 1);
  await lEngine.destroy(okConc.id);

  // destroy(id) WITHOUT awaiting, then immediately recreate the same id: the new
  // session's workspace dirs must SURVIVE (the old destroy's rmSync must not clobber
  // the successor — create now awaits the in-flight teardown).
  const rc = await lEngine.create({ backend: "native", profile: "racy" });
  void lEngine.destroy(rc.id);                         // don't await — teardown in flight
  const rc2 = await lEngine.create({ backend: "native", profile: "racy" });  // races the teardown
  // stage a file into the NEW session's per-session workspace, then confirm it persists
  await (await fetch(`http://127.0.0.1:7814/sessions/racy/files/keep.txt`, { method: "PUT", headers: { authorization: `Bearer ${TOKEN}` }, body: "survive" })).text();
  await sleep(1500);                                   // let the old teardown's rmSync run
  const stillThere = await (await fetch(`http://127.0.0.1:7814/sessions/racy/files/keep.txt`, { headers: { authorization: `Bearer ${TOKEN}` } })).text();
  check("lifecycle: destroy-then-recreate-same-id does not clobber the new session's dirs", !!lEngine.get(rc2.id) && stillThere === "survive");
  await lEngine.destroy(rc2.id);
} finally {
  await lEngine.close().catch(() => {});
}

// ── P1: session-context export/import + release-all ──────────────────────────
const cEngine = new Lucarne({ port: 7815, token: TOKEN, record: false });
await cEngine.listen();
try {
  const A = await cEngine.create({ backend: "native", profile: "ctxA" });
  const ca = await attachPage(A.cdpUrl);
  ca.send("Page.navigate", { url: "https://example.com" });
  await sleep(1200);
  await ca.call("Runtime.evaluate", { expression: `document.cookie='ctx_c=val-${ID};path=/';localStorage.setItem('ctx_l','ls-${ID}');sessionStorage.setItem('ctx_s','ss-${ID}');` });
  const exported = await cEngine.exportContext(A.id);
  const hasC = exported.cookies.some((c) => c.name === "ctx_c" && c.value === `val-${ID}`);
  check("context: export captures cookies + local + session storage", hasC && exported.localStorage.ctx_l === `ls-${ID}` && exported.sessionStorage.ctx_s === `ss-${ID}` && exported.origin === "https://example.com");

  // restore into a DIFFERENT session — no profile sharing, pure runtime transfer
  const B = await cEngine.create({ backend: "native", profile: "ctxB" });
  const cb = await attachPage(B.cdpUrl);
  cb.send("Page.navigate", { url: "https://example.com" });
  await sleep(1200);
  await cEngine.importContext(B.id, exported);
  const bCookies = (await cb.call("Network.getAllCookies")).cookies;
  const bLs = (await cb.call("Runtime.evaluate", { expression: "localStorage.getItem('ctx_l')", returnByValue: true })).result.value;
  const bSs = (await cb.call("Runtime.evaluate", { expression: "sessionStorage.getItem('ctx_s')", returnByValue: true })).result.value;
  ca.close(); cb.close();
  check("context: import restores cookies + local + session storage into another session", bCookies.some((c) => c.name === "ctx_c" && c.value === `val-${ID}`) && bLs === `ls-${ID}` && bSs === `ss-${ID}`);

  // release-all
  const released = await cEngine.releaseAll();
  check("release-all: destroys every live session", released === 2 && cEngine.list().length === 0);
} finally {
  await cEngine.close().catch(() => {});
}

// ── P1: extensions (load a custom unpacked extension) ────────────────────────
const extDir = fs.mkdtempSync(path.join(os.tmpdir(), "lucarne-ext-"));
fs.writeFileSync(path.join(extDir, "manifest.json"), JSON.stringify({
  manifest_version: 3, name: "lucarne-ext", version: "1.0",
  content_scripts: [{ matches: ["<all_urls>"], js: ["content.js"], run_at: "document_idle" }],
}));
fs.writeFileSync(path.join(extDir, "content.js"), `document.documentElement.setAttribute('data-lucarne-ext','loaded-${ID}');`);
const xEngine = new Lucarne({ port: 7816, token: TOKEN, record: false });
await xEngine.listen();
try {
  const xs = await xEngine.create({ backend: "native", profile: "ext", extensions: [extDir] });
  const xc = await attachPage(xs.cdpUrl);
  xc.send("Page.navigate", { url: "https://example.com" });
  await sleep(2000);
  const attr = (await xc.call("Runtime.evaluate", { expression: "document.documentElement.getAttribute('data-lucarne-ext')", returnByValue: true })).result.value;
  xc.close();
  check("extensions: custom extension content script runs on the page", attr === `loaded-${ID}`);
} finally {
  await xEngine.close().catch(() => {});
  fs.rmSync(extDir, { recursive: true, force: true });
}

// ── P1: multi-tab (list + switch the porthole's active tab) ──────────────────
const mEngine = new Lucarne({ port: 7817, token: TOKEN, record: false });
await mEngine.listen();
try {
  const ms = await mEngine.create({ backend: "native", profile: "multi" });
  const mc = await attachPage(ms.cdpUrl);
  mc.send("Page.navigate", { url: "https://example.com" });
  await sleep(1500);
  const shotA = await mEngine.screenshot(ms.id);                 // tab1 (active)
  // open a second, visually distinct tab
  const mb = await attachBrowser(ms.cdpUrl);
  const { targetId } = await mb.call("Target.createTarget", { url: "data:text/html,<body style=background:red><h1>TAB2</h1></body>" });
  await sleep(900);
  const before = await mEngine.tabs(ms.id);
  check("multi-tab: lists all open tabs", before.tabs.length === 2 && before.active !== targetId);
  await mEngine.switchTab(ms.id, targetId);
  await sleep(900);
  const after = await mEngine.tabs(ms.id);
  const shotB = await mEngine.screenshot(ms.id);                 // now tab2
  mc.close(); mb.close();
  check("multi-tab: switch changes active tab + frame", after.active === targetId && shotB.length > 1000 && !shotA.equals(shotB));
} finally {
  await mEngine.close().catch(() => {});
}

// ── P1: profile API (list · active-guard · delete) ───────────────────────────
const fEngine = new Lucarne({ port: 7818, token: TOKEN, record: false });
await fEngine.listen();
try {
  const fs1 = await fEngine.create({ backend: "native", profile: "pf-keep" });
  check("profiles: durable profile listed + flagged active while live", fEngine.profiles().some((p) => p.name === "pf-keep" && p.active));
  check("profiles: delete refused while a session is live", fEngine.deleteProfile("pf-keep").ok === false);
  await fEngine.destroy(fs1.id);
  const del = fEngine.deleteProfile("pf-keep");
  check("profiles: delete removes the profile after release", del.ok === true && !fEngine.profiles().some((p) => p.name === "pf-keep"));
} finally {
  await fEngine.close().catch(() => {});
}

// ── P1: per-session stats + showControls nav ─────────────────────────────────
const nEngine = new Lucarne({ port: 7819, token: TOKEN, record: false });
await nEngine.listen();
try {
  const ns = await nEngine.create({ backend: "native", profile: "nav" });
  const nc = await attachPage(ns.cdpUrl);
  const nw = new WS(`ws://127.0.0.1:7819/sessions/nav/view/ws?token=${TOKEN}`);
  await new Promise((r, j) => { nw.on("open", r); nw.on("error", j); });
  await sleep(1100);                                            // let screencast frames flow
  const st = await nEngine.status(ns.id);
  check("stats: status reports frames + streamed bytes", st.frames > 0 && st.streamedBytes > 0);

  const href = async () => (await nc.call("Runtime.evaluate", { expression: "location.href", returnByValue: true })).result.value;
  nw.send(JSON.stringify({ t: "nav", action: "go", url: "https://example.com" }));
  await sleep(1500); const u1 = await href();
  nw.send(JSON.stringify({ t: "nav", action: "go", url: "data:text/html,<title>P2</title>HELLO" }));
  await sleep(1100); const u2 = await href();
  nw.send(JSON.stringify({ t: "nav", action: "back" }));
  await sleep(1300); const u3 = await href();
  nw.close(); nc.close();
  check("nav: go navigates + back returns to the previous page", u1.includes("example.com") && u2.startsWith("data:") && u3.includes("example.com"));
} finally {
  await nEngine.close().catch(() => {});
}

// ── P1: files workspace API (global + per-session) ───────────────────────────
const wEngine = new Lucarne({ port: 7820, token: TOKEN, record: false });
await wEngine.listen();
const F = (p, opts = {}) => fetch(`http://127.0.0.1:7820${p}`, { ...opts, headers: { authorization: `Bearer ${TOKEN}`, ...(opts.headers || {}) } });
const sha = (b) => crypto.createHash("sha256").update(b).digest("hex");
try {
  // global workspace — no session needed
  const gBytes = crypto.randomBytes(1024);
  await F("/files/g.bin", { method: "PUT", body: gBytes });
  const gList = await (await F("/files")).json();
  const gGot = Buffer.from(await (await F("/files/g.bin")).arrayBuffer());
  check("files(global): put → list → get round-trips bytes", gList.includes("g.bin") && sha(gGot) === sha(gBytes));
  const gDel = await (await F("/files/g.bin", { method: "DELETE" })).json();
  const gList2 = await (await F("/files")).json();
  check("files(global): delete removes the file", gDel.ok === true && !gList2.includes("g.bin"));

  // per-session workspace
  const ws = await wEngine.create({ backend: "native", profile: "wsx" });
  const sBytes = crypto.randomBytes(777);
  await F(`/sessions/${ws.id}/files/s.bin`, { method: "PUT", body: sBytes });
  const sList = await (await F(`/sessions/${ws.id}/files`)).json();
  const sGot = Buffer.from(await (await F(`/sessions/${ws.id}/files/s.bin`)).arrayBuffer());
  check("files(session): per-session workspace round-trips bytes", sList.includes("s.bin") && sha(sGot) === sha(sBytes));
} finally {
  await wEngine.close().catch(() => {});
}

// ── P1: mobile viewport emulation ────────────────────────────────────────────
const moEngine = new Lucarne({ port: 7821, token: TOKEN, record: false });
await moEngine.listen();
try {
  const mo = await moEngine.create({ backend: "native", profile: "mob", mobile: true });
  const moc = await attachPage(mo.cdpUrl);
  moc.send("Page.navigate", { url: "https://example.com" });
  await sleep(1800);
  const r = JSON.parse((await moc.call("Runtime.evaluate", { expression: "JSON.stringify({w:innerWidth,tp:navigator.maxTouchPoints,ua:navigator.userAgent.includes('iPhone')})", returnByValue: true })).result.value);
  moc.close();
  check("mobile: device viewport + touch + mobile UA applied", r.w === 390 && r.tp > 0 && r.ua === true);
} finally {
  await moEngine.close().catch(() => {});
}

// ── P1: survive daemon restart (persisted session registry) ──────────────────
const RHOME = fs.mkdtempSync(path.join(os.tmpdir(), "lucarne-restart-"));
process.env.LUCARNE_HOME = RHOME;                                // isolate this block's durable state
const REG = path.join(RHOME, "sessions.json");
const readCookieAt = async (cdpUrl) => {
  const b = await chromium.connectOverCDP(cdpUrl);
  const c = (await b.contexts()[0].cookies("https://example.com")).find((x) => x.name === "rst_c");
  await b.close();
  return c?.value;
};
try {
  // engine1: durable session + a persistent cookie, then the daemon STOPS
  const e1 = new Lucarne({ port: 7822, token: TOKEN, record: false, registryFile: REG });
  await e1.listen();
  const r1 = await e1.create({ backend: "native", profile: "rst" });
  const b = await chromium.connectOverCDP(r1.cdpUrl);
  await b.contexts()[0].addCookies([{ name: "rst_c", value: "kept", url: "https://example.com", expires: 2000000000 }]);
  await b.close();
  await e1.close();                                              // kills Chrome, KEEPS the persisted spec

  // engine2: a fresh daemon restores durable sessions from the registry
  const e2 = new Lucarne({ port: 7823, token: TOKEN, record: false, registryFile: REG });
  await e2.listen();
  const restored = await e2.restore();
  const back = e2.get("rst");
  check("survive-restart: durable session restored by id after restart", restored.includes("rst") && !!back);
  check("survive-restart: restored session keeps its logged-in state", back && (await readCookieAt(back.cdpUrl)) === "kept");

  // an EXPLICIT destroy forgets the spec — a later restart won't resurrect it
  await e2.destroy("rst");
  check("survive-restart: explicit destroy drops the persisted spec", !("rst" in JSON.parse(fs.readFileSync(REG, "utf8"))));
  await e2.close();
} finally {
  fs.rmSync(RHOME, { recursive: true, force: true });
}

// ── P2: log capture (network + console) + SSE stream ─────────────────────────
const lgEngine = new Lucarne({ port: 7824, token: TOKEN, record: false });
await lgEngine.listen();
try {
  const ls = await lgEngine.create({ backend: "native", profile: "logs", metadata: { purpose: "test", tier: "p2", count: 5 } });
  const lc = await attachPage(ls.cdpUrl);
  // SSE: subscribe (raw http for predictable streaming), then generate a console
  // line, and assert it arrives over the stream.
  const sseHit = await new Promise((resolve) => {
    let buf = "", done = false;
    const finish = (v) => { if (!done) { done = true; try { reqq.destroy(); } catch {} resolve(v); } };
    const reqq = http.get(`http://127.0.0.1:7824/sessions/logs/logs?stream=1&token=${TOKEN}`, (res) => {
      res.on("data", (d) => { buf += d.toString(); if (buf.includes("LUCARNE-LOG-MARKER")) finish(true); });
      res.on("end", () => finish(false));
    });
    reqq.on("error", () => finish(false));
    setTimeout(async () => {
      lc.send("Page.navigate", { url: "https://example.com" });
      await sleep(1500);
      await lc.call("Runtime.evaluate", { expression: "console.log('LUCARNE-LOG-MARKER')" });
    }, 200);
    setTimeout(() => finish(false), 7000);
  });
  check("logs(SSE): live console line streams to subscribers", sseHit);

  const snap = lgEngine.sessionLogs(ls.id);
  const hasNet = snap.some((e) => e.kind === "network" && /example\.com/.test(e.url || ""));
  const hasCon = snap.some((e) => e.kind === "console" && (e.text || "").includes("LUCARNE-LOG-MARKER"));
  check("logs(snapshot): network + console captured", hasNet && hasCon);
  const onlyNet = lgEngine.sessionLogs(ls.id, { kind: "network" });
  check("logs(filter): kind filter returns only that kind", onlyNet.length > 0 && onlyNet.every((e) => e.kind === "network"));

  // ── P2: rendered /content HTML ──────────────────────────────────────────────
  const html = await lgEngine.content(ls.id);
  check("content: returns the page's rendered HTML", html.includes("<html") && html.includes("Example Domain"));

  // ── P2: userMetadata tags + list filter ─────────────────────────────────────
  const tagged = lgEngine.list({ purpose: "test" });
  const none = lgEngine.list({ purpose: "nope" });
  check("metadata: list filters by user tags + echoes them", tagged.some((s) => s.id === ls.id && s.metadata?.tier === "p2") && none.length === 0);

  // dev/02: a NUMERIC metadata value matches its stringified query over the real
  // HTTP path (`?meta.count=5`). The stored value is the number 5; the query value
  // is the string "5" — before the fix this never matched and the session was missed.
  const numHit = await (await fetch(`http://127.0.0.1:7824/sessions?meta.count=5`, { headers: { authorization: `Bearer ${TOKEN}` } })).json();
  const numMiss = await (await fetch(`http://127.0.0.1:7824/sessions?meta.count=6`, { headers: { authorization: `Bearer ${TOKEN}` } })).json();
  check("metadata: numeric tag matches stringified query (?meta.count=5); non-matching excluded",
    numHit.some((s) => s.id === ls.id) && numMiss.every((s) => s.id !== ls.id));
  lc.close();
} finally {
  await lgEngine.close().catch(() => {});
}

// ── P2: porthole quality control ─────────────────────────────────────────────
const qEngine = new Lucarne({ port: 7826, token: TOKEN, record: false });
await qEngine.listen();
const grabFrame = (id) => new Promise((resolve, reject) => {
  const w = new WS(`ws://127.0.0.1:7826/sessions/${id}/view/ws?token=${TOKEN}`);
  let got = false;
  const t = setTimeout(() => { if (!got) { w.close(); reject(new Error("no frame")); } }, 5000);
  w.on("message", (d) => { if (!got && Buffer.isBuffer(d) && d.length > 500) { got = true; clearTimeout(t); w.close(); resolve(d.length); } });
  w.on("error", (e) => { clearTimeout(t); reject(e); });
});
try {
  const lo = await qEngine.create({ backend: "native", profile: "qlo", quality: 12 });
  const hi = await qEngine.create({ backend: "native", profile: "qhi", quality: 92 });
  const lc = await attachPage(lo.cdpUrl), hc = await attachPage(hi.cdpUrl);
  // identical high-frequency content on both → quality, not content, drives size
  const paint = `(()=>{const cv=document.createElement('canvas');cv.width=1200;cv.height=600;document.body.appendChild(cv);const c=cv.getContext('2d');for(let y=0;y<600;y+=2)for(let x=0;x<1200;x+=2){c.fillStyle='rgb('+((x*7)%255)+','+((y*5)%255)+','+((x+y)%255)+')';c.fillRect(x,y,2,2);}return true})()`;
  await lc.call("Runtime.evaluate", { expression: paint });
  await hc.call("Runtime.evaluate", { expression: paint });
  await sleep(1000);
  const loSize = await grabFrame("qlo");
  const hiSize = await grabFrame("qhi");
  lc.close(); hc.close();
  check("quality: lower quality yields smaller frames", loSize < hiSize, `lo=${loSize} hi=${hiSize}`);
} finally {
  await qEngine.close().catch(() => {});
}

// ── P2: credentials API + TOTP + encrypted-at-rest + auto-inject login ────────
const CHOME = fs.mkdtempSync(path.join(os.tmpdir(), "lucarne-cred-"));
process.env.LUCARNE_HOME = CHOME;                                // isolate the cred store + key
const crEngine = new Lucarne({ port: 7825, token: TOKEN, record: false });
await crEngine.listen();
const CF = (p, opts = {}) => fetch(`http://127.0.0.1:7825${p}`, { ...opts, headers: { authorization: `Bearer ${TOKEN}`, ...(opts.headers || {}) } });
try {
  // RFC 6238 SHA1 test vector (secret base32 of "12345678901234567890", T=59s)
  check("totp: matches the RFC 6238 test vector", totpCode("GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ", 59000) === "287082");

  const SECRET = "JBSWY3DPEHPK3PXP";
  await CF("/credentials/site", { method: "PUT", body: JSON.stringify({ username: "alice", password: "s3cr3t-pw-xyz", totp: SECRET }) });
  const blurred = await (await CF("/credentials/site")).json();
  check("credentials: HTTP view is blurred (no secret values)",
    blurred.username === "alice" && blurred.hasPassword === true && blurred.hasTotp === true && !("password" in blurred) && !("totp" in blurred));
  const raw = fs.readFileSync(path.join(CHOME, "credentials.json"), "utf8");
  check("credentials: encrypted at rest (plaintext absent on disk)", !raw.includes("s3cr3t-pw-xyz") && !raw.includes(SECRET));
  const code = (await (await CF("/credentials/site/totp")).json()).code;
  const now = Date.now();
  check("credentials: server mints a current TOTP code", /^[0-9]{6}$/.test(code) && [now, now - 30000, now + 30000].some((t) => code === totpCode(SECRET, t)));

  // auto-inject into a real login form — the secret stays server-side
  const cs = await crEngine.create({ backend: "native", profile: "cred" });
  const cc = await attachPage(cs.cdpUrl);
  await cc.call("Runtime.evaluate", { expression: `document.body.innerHTML='<input id=u><input id=p type=password>'` });
  const r = await crEngine.loginWithCredential(cs.id, { credential: "site", userSelector: "#u", passSelector: "#p" });
  const vals = JSON.parse((await cc.call("Runtime.evaluate", { expression: "JSON.stringify({u:document.getElementById('u').value,p:document.getElementById('p').value})", returnByValue: true })).result.value);
  cc.close();
  check("credentials: auto-inject fills the login form from the store",
    r.filled.includes("username") && r.filled.includes("password") && vals.u === "alice" && vals.p === "s3cr3t-pw-xyz");
} finally {
  await crEngine.close().catch(() => {});
  fs.rmSync(CHOME, { recursive: true, force: true });
}

// ── P2: typed SDK + OpenAPI + /docs + IME + theme ────────────────────────────
const sdkEngine = new Lucarne({ port: 7827, token: TOKEN, record: false });
await sdkEngine.listen();
try {
  const client = new LucarneClient({ baseUrl: "http://127.0.0.1:7827", token: TOKEN });
  const h = await client.health();
  check("sdk: health round-trips (authed → includes ids[])", h.ok === true && typeof h.sessions === "number" && Array.isArray(h.ids));
  const sdkS = await client.create({ backend: "native", profile: "sdk", metadata: { via: "sdk" } });
  const listed = await client.list({ via: "sdk" });
  check("sdk: create + filtered list round-trip", listed.some((x) => x.id === sdkS.id));

  // OpenAPI + /docs (token-exempt, like /health)
  const spec = await (await fetch("http://127.0.0.1:7827/openapi.json")).json();
  check("openapi: served spec validates structurally", spec.openapi.startsWith("3.") && !!spec.paths["/sessions"] && !!spec.info.title);
  check("openapi: spec version tracks the package (no hard-coded drift)", spec.info.version === VERSION);
  // the spec must cover the routes that were previously undocumented (drift guard)
  const mustDocument = ["/sessions/{id}/act", "/sessions/{id}/activity", "/sessions/{id}/context", "/sessions/{id}/touch", "/sessions/{id}/recordings", "/sessions/{id}/downloads/{file}", "/sessions/{id}/files/{name}", "/sessions/{id}/view"];
  const missing = mustDocument.filter((p) => !spec.paths[p]);
  check("openapi: documents the full session surface (act/activity/context/…)", missing.length === 0, missing.length ? `missing ${missing.join(", ")}` : "all present");
  const docs = await (await fetch("http://127.0.0.1:7827/docs")).text();
  check("docs: serves a Swagger UI referencing the spec", docs.toLowerCase().includes("swagger") && docs.includes("openapi.json"));

  // SDK methods added to cover the binary + JSON surface beyond create/list
  const nc = await attachPage(sdkS.cdpUrl);
  nc.send("Page.navigate", { url: "https://example.com" });
  await sleep(1500);
  nc.close();
  const shot = await client.screenshot(sdkS.id);
  check("sdk: screenshot() returns PNG bytes", shot instanceof Uint8Array && shot[0] === 0x89 && shot[1] === 0x50 && shot[2] === 0x4e && shot[3] === 0x47, `${shot.length}B`);
  const tch = await client.touch(sdkS.id);
  check("sdk: touch() resets the inactivity clock", tch.ok === true);
  const recs = await client.recordings(sdkS.id);
  check("sdk: recordings() returns the segment list", Array.isArray(recs));
  const xc = await client.exportContext(sdkS.id);
  check("sdk: exportContext() returns cookies + origin", Array.isArray(xc.cookies) && typeof xc.origin === "string");
  const av = await client.activity(sdkS.id);
  check("sdk: activity() returns the {now, recent} shape", "now" in av && Array.isArray(av.recent));
  const lgs = await client.logs(sdkS.id);
  check("sdk: logs() returns a typed LogEntry[]", Array.isArray(lgs) && lgs.every((e) => typeof e.kind === "string"));
  const dp = await client.deleteProfile("definitely-not-a-real-profile-xyz");
  check("sdk: deleteProfile() of a missing profile returns ok:false", dp.ok === false);

  // SDK parity: credentials + global files + extensions over the typed client (no Chrome needed)
  await client.putCredential("sdkcred", { username: "u@x", password: "p", totp: "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ" });
  const creds = await client.credentials();
  const blurred = creds.find((c) => c.name === "sdkcred") || {};
  check("sdk: credentials() lists blurred (no secret leaks)", blurred.hasPassword === true && !("password" in blurred));
  check("sdk: credentialTotp() returns a 6-digit code", /^[0-9]{6}$/.test((await client.credentialTotp("sdkcred")).code));
  check("sdk: deleteCredential() works", (await client.deleteCredential("sdkcred")).ok === true);
  await client.putFile("sdk.txt", "hello-sdk");
  const fbytes = await client.file("sdk.txt");
  check("sdk: files put/list/get round-trips bytes", (await client.files()).includes("sdk.txt") && Buffer.from(fbytes).toString() === "hello-sdk");
  check("sdk: deleteFile() works", (await client.deleteFile("sdk.txt")).ok === true);
  // extensions: real round-trip — upload a file under a managed extension, list it, delete it
  await fetch(`http://127.0.0.1:7827/extensions/sdkext/manifest.json`, { method: "PUT", headers: { authorization: `Bearer ${TOKEN}` }, body: "{}" });
  check("sdk: extensions() lists an uploaded managed extension", (await client.extensions()).includes("sdkext"));
  check("sdk: deleteExtension() removes it", (await client.deleteExtension("sdkext")).ok === true && !(await client.extensions()).includes("sdkext"));

  // theme: the served porthole HTML actually carries the theme-application code path
  const view = await (await fetch(`http://127.0.0.1:7827/sessions/sdk/view/?theme=light&token=${TOKEN}`)).text();
  check("theme: porthole template wires ?theme into a real style switch", /theme/.test(view) && /light/.test(view) && /searchParams|URLSearchParams|location\.search/.test(view));

  // IME: composition commits CJK that plain keydowns cannot produce
  const ic = await attachPage(sdkS.cdpUrl);
  await ic.call("Runtime.evaluate", { expression: `document.body.innerHTML='<input id=i>';document.getElementById('i').focus();` });
  const iw = new WS(`ws://127.0.0.1:7827/sessions/sdk/view/ws?token=${TOKEN}`);
  await new Promise((r, j) => { iw.on("open", r); iw.on("error", j); });
  iw.send(JSON.stringify({ t: "ime", phase: "compose", text: "日本" }));
  await sleep(200);
  iw.send(JSON.stringify({ t: "ime", phase: "commit", text: "日本語" }));
  await sleep(400);
  const iv = (await ic.call("Runtime.evaluate", { expression: "document.getElementById('i').value", returnByValue: true })).result.value;
  iw.close(); ic.close();
  check("ime: composition commits CJK into the focused input", iv === "日本語");

  await client.destroy(sdkS.id);
  check("sdk: destroy removes the session", !(await client.list()).some((x) => x.id === sdkS.id));
} finally {
  await sdkEngine.close().catch(() => {});
}

// ── P2: extension upload/manage API + replay viewer ──────────────────────────
const EHOME = fs.mkdtempSync(path.join(os.tmpdir(), "lucarne-extmgr-"));
process.env.LUCARNE_HOME = EHOME;
const exEngine = new Lucarne({ port: 7828, token: TOKEN, record: false });
await exEngine.listen();
const EF = (p, opts = {}) => fetch(`http://127.0.0.1:7828${p}`, { ...opts, headers: { authorization: `Bearer ${TOKEN}`, ...(opts.headers || {}) } });
try {
  const manifest = JSON.stringify({ manifest_version: 3, name: "up", version: "1.0", content_scripts: [{ matches: ["http://*/*", "https://*/*"], js: ["content.js"], run_at: "document_idle" }] });
  await EF("/extensions/up/manifest.json", { method: "PUT", body: manifest });
  await EF("/extensions/up/content.js", { method: "PUT", body: `document.documentElement.setAttribute('data-up','ok-${ID}');` });
  const list = await (await EF("/extensions")).json();
  check("extensions(manage): uploaded extension is listed", list.includes("up"));

  const es = await exEngine.create({ backend: "native", profile: "upx", extensions: ["up"] });
  const ec = await attachPage(es.cdpUrl);
  ec.send("Page.navigate", { url: "https://example.com" });
  await sleep(2000);
  const attr = (await ec.call("Runtime.evaluate", { expression: "document.documentElement.getAttribute('data-up')", returnByValue: true })).result.value;
  const replay = await (await EF(`/sessions/${es.id}/replay`)).text();
  ec.close();
  check("extensions(manage): managed extension loads by name + content script runs", attr === `ok-${ID}`);
  check("replay: serves an HTML player over the recording segments", replay.includes("<video") && replay.includes("/recordings"));
} finally {
  await exEngine.close().catch(() => {});
  fs.rmSync(EHOME, { recursive: true, force: true });
}

// ── P3: computer-use /act + geolocation override ─────────────────────────────
const agEngine = new Lucarne({ port: 7829, token: TOKEN, record: false });
await agEngine.listen();
const AF = (p, opts = {}) => fetch(`http://127.0.0.1:7829${p}`, { ...opts, headers: { authorization: `Bearer ${TOKEN}`, ...(opts.headers || {}) } });
try {
  const ag = await agEngine.create({ backend: "native", profile: "act", geo: { latitude: 48.8566, longitude: 2.3522 } });
  const acc = await attachPage(ag.cdpUrl);
  acc.send("Page.navigate", { url: "https://example.com" });
  await sleep(1700);
  const geo = (await acc.call("Runtime.evaluate", { expression: `new Promise(res=>navigator.geolocation.getCurrentPosition(p=>res(p.coords.latitude+','+p.coords.longitude),()=>res('ERR')))`, awaitPromise: true, returnByValue: true })).result.value;
  check("geo: override reports the set coordinates", geo === "48.8566,2.3522");

  await acc.call("Runtime.evaluate", { expression: `document.body.innerHTML='<input id=i style="position:fixed;top:8px;left:8px;width:300px;height:40px"><button id=b style="position:fixed;top:60px;left:8px;width:120px;height:40px" onclick="window.__clk=1">go</button>';document.getElementById('i').focus();` });
  await AF("/sessions/act/act", { method: "POST", body: JSON.stringify({ action: "type", text: "hello-act" }) });
  await sleep(150);
  const iv = (await acc.call("Runtime.evaluate", { expression: "document.getElementById('i').value", returnByValue: true })).result.value;
  check("act: type lands in the focused input", iv === "hello-act");
  await AF("/sessions/act/act", { method: "POST", body: JSON.stringify({ action: "click", x: 68, y: 80 }) });
  await sleep(150);
  const clk = (await acc.call("Runtime.evaluate", { expression: "window.__clk||0", returnByValue: true })).result.value;
  check("act: click dispatches at coordinates", clk === 1);
  const shot = await (await AF("/sessions/act/act", { method: "POST", body: JSON.stringify({ action: "screenshot" }) })).json();
  check("act: screenshot returns a PNG (base64)", typeof shot.screenshot === "string" && shot.screenshot.startsWith("iVBORw0KGgo"));
  acc.close();
} finally {
  await agEngine.close().catch(() => {});
}

// ── P3: concurrency cap + queue ──────────────────────────────────────────────
const ccEngine = new Lucarne({ port: 7830, token: TOKEN, record: false, maxConcurrent: 1 });
await ccEngine.listen();
try {
  const a = await ccEngine.create({ backend: "native", profile: "ccA" });
  let bDone = false;
  const bP = ccEngine.create({ backend: "native", profile: "ccB" }).then((r) => { bDone = true; return r; });
  await sleep(1500);
  check("concurrency: create past the cap queues", bDone === false && ccEngine.list().length === 1);
  await ccEngine.destroy(a.id);
  const b = await bP;
  check("concurrency: queued create runs once a slot frees", bDone === true && ccEngine.list().some((s) => s.id === b.id));
} finally {
  await ccEngine.close().catch(() => {});
}

// ── P3: CORS config ──────────────────────────────────────────────────────────
const corsEngine = new Lucarne({ port: 7831, token: TOKEN, record: false, cors: true });
await corsEngine.listen();
try {
  const res = await fetch("http://127.0.0.1:7831/health", { method: "OPTIONS" });
  check("cors: preflight returns permissive CORS headers", res.status === 204 && res.headers.get("access-control-allow-origin") === "*" && (res.headers.get("access-control-allow-methods") || "").includes("POST"));
} finally {
  await corsEngine.close().catch(() => {});
}

// ── Backend registration seam: add a backend WITHOUT editing the engine ──────
// Register a custom kind (delegating to native) and prove a session mints + drives.
const cbEngine = new Lucarne({ port: 7843, token: TOKEN, record: false, backends: [] });
cbEngine.registerBackend({ kind: "custom", start: (id, ports, ctx) => nativeBackend.start(id, ports, ctx) });
await cbEngine.listen();
try {
  const cs = await cbEngine.create({ backend: "custom", profile: "cust" });
  check("backend seam: a registered custom backend reports its kind", cs.backend === "custom");
  const cb = await chromium.connectOverCDP(cs.cdpUrl);
  const cp = cb.contexts()[0].pages()[0] ?? (await cb.contexts()[0].newPage());
  await cp.goto("https://example.com", { waitUntil: "domcontentloaded" });
  const ok = (await cp.title()) === "Example Domain";
  await cb.close();
  check("backend seam: a registered custom backend mints + drives a real session", ok);
} finally {
  await cbEngine.close().catch(() => {});
}

// ── P3: MCP server (stdio JSON-RPC drives real sessions) ─────────────────────
const mcpEngine = new Lucarne({ port: 7832, token: TOKEN, record: false });
await mcpEngine.listen();
let mcp;
try {
  mcp = spawn("node", ["dist/mcp.js"], { env: { ...process.env, LUCARNE_URL: "http://127.0.0.1:7832", LUCARNE_TOKEN: TOKEN } });
  const responses = [];
  let buf = "";
  mcp.stdout.on("data", (d) => { buf += d.toString(); let i; while ((i = buf.indexOf("\n")) >= 0) { const line = buf.slice(0, i); buf = buf.slice(i + 1); if (line.trim()) try { responses.push(JSON.parse(line)); } catch { /* partial */ } } });
  const rpc = (id, method, params) => mcp.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  const waitFor = async (id, ms = 8000) => { const end = Date.now() + ms; while (Date.now() < end) { const r = responses.find((x) => x.id === id); if (r) return r; await sleep(100); } return null; };

  rpc(1, "initialize", {});
  const init = await waitFor(1);
  check("mcp: initialize returns server info", init?.result?.serverInfo?.name === "lucarne");
  check("mcp: serverInfo version tracks the package (no drift)", init?.result?.serverInfo?.version === VERSION);
  rpc(2, "tools/list", {});
  const tl = await waitFor(2);
  check("mcp: tools/list advertises lucarne tools", (tl?.result?.tools || []).some((t) => t.name === "lucarne_create"));
  rpc(3, "tools/call", { name: "lucarne_create", arguments: { backend: "native", profile: "mcp" } });
  const created = await waitFor(3, 30000);
  const sid = created && JSON.parse(created.result.content[0].text).id;
  check("mcp: tools/call creates a real session", sid === "mcp" && mcpEngine.list().some((s) => s.id === "mcp"));
  rpc(4, "tools/call", { name: "lucarne_destroy", arguments: { id: "mcp" } });
  await waitFor(4);
  check("mcp: tools/call destroys the session", !mcpEngine.list().some((s) => s.id === "mcp"));
} finally {
  if (mcp) mcp.kill();
  await mcpEngine.close().catch(() => {});
}

// ── P3: Python SDK (structural — stdlib client loads with all methods) ───────
try {
  const out = execFileSync("python3", ["-c", "import sys; sys.path.insert(0,'clients/python'); import lucarne; c=lucarne.LucarneClient(); print(all(hasattr(c,m) for m in ('health','create','list','get','destroy','act','content')))"], { encoding: "utf8" });
  check("python-sdk: client module loads with all methods", out.trim() === "True");
} catch (e) {
  check("python-sdk: client module loads with all methods", false, String(e.message));
}

// ── Initiative II / A1: activity log (agent-ergonomic) ───────────────────────
const aEngine = new Lucarne({ port: 7836, token: TOKEN, record: false });
await aEngine.listen();
try {
  const as = await aEngine.create({ backend: "native", profile: "act", activity: true });
  const ac = await attachPage(as.cdpUrl);
  await ac.call("Runtime.evaluate", { expression: "document.body.innerHTML='<input id=p type=password name=pw>';document.getElementById('p').focus()" });
  const aw = new WS(`ws://127.0.0.1:7836/sessions/act/view/ws?token=${TOKEN}`);
  await new Promise((r, j) => { aw.on("open", r); aw.on("error", j); });
  // human types a "password" through the porthole
  for (const k of ["s", "e", "c", "r", "e", "t"]) { aw.send(JSON.stringify({ t: "keydown", key: k, code: "Key" + k.toUpperCase() })); aw.send(JSON.stringify({ t: "keyup", key: k, code: "Key" + k.toUpperCase() })); }
  await sleep(1100);                                          // coalesce + flush → redact
  // A2: a click resolves the element under the cursor (selector + text)
  await ac.call("Runtime.evaluate", { expression: "document.body.innerHTML='<button id=login style=\"position:fixed;top:20px;left:20px;width:120px;height:40px\">Log in</button>'" });
  aw.send(JSON.stringify({ t: "down", x: 80, y: 40, button: 0, buttons: 1, clickCount: 1 }));
  aw.send(JSON.stringify({ t: "up", x: 80, y: 40, button: 0, buttons: 0, clickCount: 1 }));
  await sleep(500);
  const clickEv = aEngine.sessionActivity("act").find((a) => a.kind === "click" && a.selector);
  check("activity(A2): a click resolves its element (selector + text)", !!clickEv && (clickEv.selector || "").includes("#login") && (clickEv.text || "").includes("Log in"));

  // A3: presence-to-yield — `now` exposes the focused field + how fresh the human's last action is
  await ac.call("Runtime.evaluate", { expression: "document.body.innerHTML='<input id=q name=query>';document.getElementById('q').focus()" });
  aw.send(JSON.stringify({ t: "keydown", key: "h", code: "KeyH" })); aw.send(JSON.stringify({ t: "keyup", key: "h", code: "KeyH" }));
  await sleep(200);
  const now3 = await aEngine.activityNow("act");
  check("activity(A3): now exposes focused field + fresh human-action time (don't-fight signal)", now3?.focusedField === "query" && now3.lastHumanActionMsAgo !== null && now3.lastHumanActionMsAgo < 3000);

  aw.send(JSON.stringify({ t: "nav", action: "go", url: "https://example.com" }));  // human nav
  await sleep(1800);
  await sleep(1800);                                          // let human-action freshness lapse
  ac.send("Page.navigate", { url: "data:text/html,<title>agentpage</title>AGENT" }); // agent nav (CDP)
  await sleep(1200);
  aw.close(); ac.close();
  const acts = aEngine.sessionActivity("act");
  const typeEv = acts.find((a) => a.kind === "type");
  const humanNav = acts.find((a) => a.kind === "nav" && a.actor === "human");
  const agentNav = acts.find((a) => a.kind === "nav" && a.actor === "agent");
  const now = await aEngine.activityNow("act");
  const pw = await (await fetch(`http://127.0.0.1:7836/sessions/act/activity?format=playwright&token=${TOKEN}`)).text();
  check("activity: human typing into a password field is captured + REDACTED", !!typeEv && typeEv.actor === "human" && typeEv.value === "‹redacted›");
  check("activity: nav attributed human (porthole) vs agent (CDP driver)", !!humanNav && (humanNav.url || "").includes("example.com") && !!agentNav && (agentNav.url || "").startsWith("data:"));
  check("activity: now reports current url + the Playwright-verb view renders", !!now?.url && pw.includes("await page.goto") && pw.includes("# human") && pw.includes("# agent"));
  // A2 also resolves the element's ARIA role
  check("activity(A2): a click also resolves the element role", clickEv?.role === "button");
  // ?format=text renders human-readable timestamped log lines (the redacted type is one of them)
  const txt = await (await fetch(`http://127.0.0.1:7836/sessions/act/activity?format=text&token=${TOKEN}`)).text();
  check("activity: ?format=text renders timestamped log lines", /\d{4}-\d\d-\d\dT/.test(txt) && txt.includes("human") && txt.includes("type") && txt.includes("‹redacted›") && txt.includes("agent"));
  // default GET returns the {now, recent} JSON shape over HTTP (not just the in-process readers)
  const j = await (await fetch(`http://127.0.0.1:7836/sessions/act/activity?token=${TOKEN}`)).json();
  check("activity: default GET returns {now, recent} over HTTP", !!j.now && "lastHumanActionMsAgo" in j.now && Array.isArray(j.recent) && j.recent.length > 0 && typeof j.recent[0].kind === "string");
  // ?stream=1 SSE replays the feed as a live event-stream channel
  const sseEv = await new Promise((resolve, reject) => {
    const r = http.get(`http://127.0.0.1:7836/sessions/act/activity?stream=1&token=${TOKEN}`, (res) => {
      let buf = "";
      res.on("data", (c) => { buf += c.toString(); const m = buf.match(/data: (.+)\n\n/); if (m) { clearTimeout(to); r.destroy(); try { resolve(JSON.parse(m[1])); } catch (e) { reject(e); } } });
      res.on("error", reject);
    });
    r.on("error", reject);
    const to = setTimeout(() => { r.destroy(); reject(new Error("sse timeout")); }, 4000);
  });
  check("activity: ?stream=1 SSE replays the feed (live channel)", !!sseEv && typeof sseEv.kind === "string" && typeof sseEv.actor === "string");
} finally {
  await aEngine.close().catch(() => {});
}

// ── Hardening: clear failures, honest backend contract, version, packaging ───
// None of these launch a real Chrome (the missing-Chrome case uses a bogus path),
// so they're fast and deterministic.
{
  // --version prints the package version (one source of truth, no drift)
  const cliV = execFileSync("node", ["dist/cli.js", "--version"], { encoding: "utf8" }).trim();
  check("cli: --version prints the package version", cliV === VERSION, `${cliV} === ${VERSION}`);

  // CLI surfaces an HTTP error instead of printing the body and exiting 0.
  // Use async spawn (NOT execFileSync) — a synchronous child blocks the event
  // loop, so the in-process engine couldn't answer the CLI's request.
  const hgEngine = new Lucarne({ port: 7837, token: TOKEN, record: false });
  await hgEngine.listen();
  const cli401 = await new Promise((resolve) => {
    const c = spawn("node", ["dist/cli.js", "ls"], { env: { ...process.env, LUCARNE_URL: "http://127.0.0.1:7837", LUCARNE_TOKEN: "WRONG" } });
    let err = "";
    c.stderr.on("data", (d) => { err += d.toString(); });
    c.on("close", (code) => resolve({ code, err }));
  });
  check("cli: a 401 is a non-zero exit with a clear message (not silent success)", cli401.code === 1 && /401/.test(cli401.err));

  // listen() rejects a taken port with a clear message (no raw crash)
  let portErr = "";
  try { const dup = new Lucarne({ port: 7837, token: TOKEN, record: false }); await dup.listen(); } catch (e) { portErr = e.message; }
  check("listen: a taken port rejects with a clear message", /already in use/.test(portErr), portErr);
  await hgEngine.close().catch(() => {});

  // native: a missing Chrome binary fails fast + clearly (no 25s wait)
  const ncEngine = new Lucarne({ port: 7838, token: TOKEN, record: false, chromePath: "/no/such/chrome-binary" });
  await ncEngine.listen();
  const t0 = Date.now();
  let chromeErr = "";
  try { await ncEngine.create({ backend: "native", profile: "nochrome" }); } catch (e) { chromeErr = e.message; }
  const chromeDt = Date.now() - t0;
  await ncEngine.close().catch(() => {});
  check("native: missing Chrome fails fast (<5s) with a clear message", /Chrome not found/.test(chromeErr) && chromeDt < 5000, `${chromeDt}ms`);

  // docker: unsupported options are REJECTED, not silently dropped (throws before docker)
  const dgEngine = new Lucarne({ port: 7839, token: TOKEN, record: false });
  await dgEngine.listen();
  let proxyErr = "", extErr = "";
  try { await dgEngine.create({ backend: "docker", profile: "dgp", proxy: "http://127.0.0.1:8888" }); } catch (e) { proxyErr = e.message; }
  try { await dgEngine.create({ backend: "docker", profile: "dge", extensions: ["/tmp/x"] }); } catch (e) { extErr = e.message; }
  await dgEngine.close().catch(() => {});
  check("docker: unsupported proxy is rejected, not silently dropped", /does not support `proxy`/.test(proxyErr));
  check("docker: unsupported extensions are rejected, not silently dropped", /does not support custom `extensions`/.test(extErr));

  // config validation: a non-positive / NaN numeric option is REJECTED at engine
  // construction with a clear message naming the option (fail-closed), not silently
  // used and surfaced later as a broken capture/recording.
  let fpsErr = "", vpErr = "", retErr = "";
  try { new Lucarne({ port: 7860, record: false, fps: 0 }); } catch (e) { fpsErr = e.message; }
  try { new Lucarne({ port: 7860, record: false, viewport: { width: -1, height: 720 } }); } catch (e) { vpErr = e.message; }
  try { new Lucarne({ port: 7860, record: false, retentionMin: NaN }); } catch (e) { retErr = e.message; }
  // a valid/default construction is unaffected (no false positive)
  let okCtor = true;
  try { (new Lucarne({ port: 7860, record: false, fps: 4, segmentSeconds: 60 })); } catch { okCtor = false; }
  check("config: a non-positive `fps` is rejected at construction with a clear message",
    /fps must be a positive number/.test(fpsErr), fpsErr);
  check("config: a non-positive `viewport.width` is rejected with a clear message",
    /viewport\.width must be a positive number/.test(vpErr), vpErr);
  check("config: a NaN `retentionMin` is rejected with a clear message",
    /retentionMin must be a positive number/.test(retErr), retErr);
  check("config: a valid/default construction is unaffected", okCtor);

  // per-session create() input validation: an out-of-range/NaN `quality` or `geo`
  // is REJECTED before the session is created with a clear message naming the field
  // + its constraint — not forwarded straight to CDP (Page.startScreencast /
  // Emulation.setGeolocationOverride) where Chrome silently clamps/ignores it.
  const vEngine = new Lucarne({ port: 7863, token: TOKEN, record: false });
  let qErr = "", latErr = "", lonErr = "", qNaNErr = "";
  try { await vEngine.create({ backend: "native", profile: "vq", quality: 999 }); } catch (e) { qErr = e.message; }
  try { await vEngine.create({ backend: "native", profile: "vqn", quality: NaN }); } catch (e) { qNaNErr = e.message; }
  try { await vEngine.create({ backend: "native", profile: "vlat", geo: { latitude: 200, longitude: 0 } }); } catch (e) { latErr = e.message; }
  try { await vEngine.create({ backend: "native", profile: "vlon", geo: { latitude: 0, longitude: 999 } }); } catch (e) { lonErr = e.message; }
  await vEngine.close().catch(() => {});
  check("create: an out-of-range `quality` is rejected with a clear message before the session is created",
    /quality must be between 1 and 100/.test(qErr), qErr);
  check("create: a NaN `quality` is rejected with a clear message", /quality must be between 1 and 100/.test(qNaNErr), qNaNErr);
  check("create: an out-of-range `geo.latitude` is rejected with a clear message",
    /geo\.latitude must be between -90 and 90/.test(latErr), latErr);
  check("create: an out-of-range `geo.longitude` is rejected with a clear message",
    /geo\.longitude must be between -180 and 180/.test(lonErr), lonErr);

  // backend-registration seam: with no backends registered, an unknown backend is rejected
  const bareEngine = new Lucarne({ port: 7841, token: TOKEN, record: false, backends: [] });
  await bareEngine.listen();
  let unkBackend = "";
  try { await bareEngine.create({ backend: "native", profile: "x" }); } catch (e) { unkBackend = e.message; }
  await bareEngine.close().catch(() => {});
  check("backend seam: an unregistered backend is rejected", /unknown backend/.test(unkBackend));

  // pluggable credential provider: the engine uses the injected store, not the file default
  const mem = new Map();
  const customStore = {
    put: (n, c) => mem.set(n, c),
    get: (n) => mem.get(n),
    list: () => [...mem.keys()].map((name) => ({ name, hasPassword: !!mem.get(name).password, hasTotp: !!mem.get(name).totp })),
    blur: (n) => (mem.has(n) ? { name: n, hasPassword: !!mem.get(n).password, hasTotp: !!mem.get(n).totp } : undefined),
    delete: (n) => mem.delete(n),
  };
  const credEngine = new Lucarne({ port: 7842, token: TOKEN, record: false, credentials: customStore });
  await credEngine.listen();
  await fetch("http://127.0.0.1:7842/credentials/k", { method: "PUT", headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" }, body: JSON.stringify({ password: "pw" }) });
  await credEngine.close().catch(() => {});
  check("credentials seam: engine routes through the injected provider (BYO store)", mem.has("k") && mem.get("k").password === "pw");

  // packaging: the published tarball actually ships what the README references
  const packed = JSON.parse(execFileSync("npm", ["pack", "--dry-run", "--json"], { encoding: "utf8" }));
  const packedFiles = packed[0].files.map((f) => f.path);
  check("pack: ships the Python client referenced in the README", packedFiles.includes("clients/python/lucarne.py"));
  check("pack: ships the runnable examples", packedFiles.some((f) => f.startsWith("examples/")));
  check("pack: ships the CLI + MCP binaries", packedFiles.includes("dist/cli.js") && packedFiles.includes("dist/mcp.js"));
}

// ── Security hardening (no Chrome) — the adversarial-review fixes ─────────────
{
  // raw http — undici/fetch forbids overriding Host and recomputes content-length,
  // so the malicious-header cases must go through node:http directly.
  const rawReq = (port, pathname, headers = {}, method = "GET") => new Promise((resolve) => {
    const r = http.request({ host: "127.0.0.1", port, path: pathname, method, headers }, (res) => { res.resume(); resolve(res.statusCode); });
    r.on("error", () => resolve(0)); r.end();
  });
  // 1. DNS-rebinding / CSRF guard: a tokenless loopback daemon rejects a foreign Host + cross-origin
  const gEngine = new Lucarne({ port: 7861, record: false }); // NO token = the vulnerable default
  await gEngine.listen();
  const okHost = await rawReq(7861, "/health");
  const badHost = await rawReq(7861, "/health", { host: "evil.example.com" });
  const badOrigin = await rawReq(7861, "/sessions", { origin: "https://evil.example.com" });
  check("security: tokenless daemon serves loopback Host but rejects a rebound foreign Host", okHost === 200 && badHost === 403);
  check("security: tokenless daemon rejects a cross-origin request (CSRF/rebind)", badOrigin === 403);
  // 1b. The `127.x.evil.com` rebinding bypass (a `startsWith("127.")` hole) is closed
  const rebind1 = await rawReq(7861, "/health", { host: "127.0.0.1.evil.com" });
  const rebind2 = await rawReq(7861, "/health", { host: "127.evil.com" });
  check("security: a `127.x.evil.com` Host (DNS-rebind) is refused (strict literal, not startsWith)", rebind1 === 403 && rebind2 === 403);
  // 1c. Absent Host fails CLOSED (raw socket — http.request always adds Host)
  const noHostCode = await new Promise((resolve) => {
    const s = net.connect(7861, "127.0.0.1", () => s.write("GET /sessions HTTP/1.0\r\n\r\n"));
    let buf = ""; s.on("data", (d) => { buf += d; }); const fin = () => { const m = buf.match(/HTTP\/1\.[01] (\d+)/); resolve(m ? +m[1] : 0); };
    s.on("end", fin); s.on("error", () => resolve(0)); setTimeout(() => { s.destroy(); fin(); }, 1500);
  });
  check("security: an absent Host header fails closed (403)", noHostCode === 403);
  // 1d. CRITICAL: the porthole WS upgrade is guarded too (cross-origin WS can't drive a tokenless daemon)
  const wsResult = (headers) => new Promise((resolve) => {
    const ws = new WS("ws://127.0.0.1:7861/sessions/x/view/ws", { headers });
    ws.on("open", () => { ws.close(); resolve("OPEN"); });
    ws.on("error", () => resolve("REJECTED")); ws.on("unexpected-response", () => resolve("REJECTED"));
    setTimeout(() => resolve("TIMEOUT"), 2000);
  });
  check("security: cross-origin WebSocket upgrade is rejected (the WS plane is guarded too)", (await wsResult({ origin: "https://evil.example.com" })) !== "OPEN" && (await wsResult({ host: "evil.example.com" })) !== "OPEN");
  // 2. Body-size cap: declared over-limit content-length is 413'd…
  const big = await rawReq(7861, "/files/x", { "content-length": String(200 * 1024 * 1024) }, "PUT");
  check("security: an over-cap request body is rejected (413)", big === 413);
  // 2b. …AND a CHUNKED body with no content-length is capped DURING read (not bypassable)
  const chunkedCode = await new Promise((resolve) => {
    const r = http.request({ host: "127.0.0.1", port: 7861, path: "/files/x", method: "PUT", headers: { "transfer-encoding": "chunked" } }, (res) => { res.resume(); resolve(res.statusCode); });
    r.on("error", () => resolve(0));
    let sent = 0; const block = Buffer.alloc(1024 * 1024, 0x61);
    const pump = () => { if (sent > 140 * 1024 * 1024) { r.end(); return; } sent += block.length; if (r.write(block)) setImmediate(pump); else r.once("drain", pump); };
    pump();
  });
  // 413, or a server-side connection abort (0) once it stops reading the over-cap stream —
  // either way the oversized body was NOT accepted (never a 200).
  check("security: a chunked (no content-length) over-cap body is not accepted (413 / aborted)", chunkedCode === 413 || chunkedCode === 0);
  await gEngine.close().catch(() => {});

  // file:// nav allowlist (S2) — incl. the leading-control-char bypass
  check("security: nav allowlist permits http(s), refuses file://, \\x00file://, chrome://, filesystem:",
    isWebNavUrl("https://example.com") && !isWebNavUrl("file:///etc/passwd") && !isWebNavUrl("\x00file:///etc/passwd") && !isWebNavUrl("\x01chrome://settings") && !isWebNavUrl("filesystem:http://x/") && isWebNavUrl("/relative/path"));

  // 3. timing-safe token: right token passes, wrong (same-length) token fails — through the real gate
  const tEngine = new Lucarne({ port: 7862, token: "right-token-value", record: false });
  await tEngine.listen();
  const good = await fetch("http://127.0.0.1:7862/sessions", { headers: { authorization: "Bearer right-token-value" } });
  const bad = await fetch("http://127.0.0.1:7862/sessions", { headers: { authorization: "Bearer wrong-token-value" } });
  check("security: token gate accepts the right token, rejects a wrong one (timing-safe compare)", good.status === 200 && bad.status === 401);
  await tEngine.close().catch(() => {});

  // 4. docker CDP is pinned to loopback in the spawn args, regardless of engine --host
  const dockerSrc = fs.readFileSync(new URL("../dist/backends/docker.js", import.meta.url), "utf8");
  check("security: docker backend publishes CDP to 127.0.0.1 only (not the bind host)", dockerSrc.includes("127.0.0.1:${ports.cdp}:9222") && !dockerSrc.includes("${ctx.host}:${ports.cdp}:9222"));

  // 5. CLI auto-provisions a token when binding off-loopback (--host 0.0.0.0), enforcing the guarantee
  const offLoop = await new Promise((resolve) => {
    const c = spawn("node", ["dist/cli.js", "serve", "--host", "0.0.0.0", "--port", "7863"], { env: { ...process.env, LUCARNE_TOKEN: "" } });
    let out = "";
    c.stdout.on("data", (d) => { out += d.toString(); if (/auto-provisioned/.test(out)) { c.kill(); resolve({ out }); } });
    setTimeout(() => { c.kill(); resolve({ out }); }, 6000);
  });
  check("security: serve --host 0.0.0.0 auto-provisions a token (never off-loopback unauthenticated)", /auto-provisioned — required off-loopback/.test(offLoop.out));

  // 6. create rollback: when media bring-up fails (fake backend, no real CDP), the slot is released
  const rEngine = new Lucarne({ port: 7864, record: false, maxConcurrent: 1, backends: [] });
  rEngine.registerBackend({ kind: "fake", start: async () => ({ async stop() {} }) }); // CDP never comes up → startSessionMedia throws
  await rEngine.listen();
  let firstErr = "";
  try { await rEngine.create({ backend: "fake", profile: "rb1" }); } catch (e) { firstErr = e.message; }
  // if the slot leaked, this second create would hang forever; race it against a timeout
  const second = await Promise.race([
    rEngine.create({ backend: "fake", profile: "rb2" }).then(() => "created", (e) => "errored:" + e.message),
    new Promise((res) => setTimeout(() => res("HUNG"), 4000)),
  ]);
  await rEngine.close().catch(() => {});
  check("security/leak: a failed create rolls back its slot (next create isn't deadlocked)", !!firstErr && second !== "HUNG");
}

// ── keymap (round-3): shifted symbols + numpad operators (were resolving to vk 0) ──
// A shifted symbol arrives as code "Semicolon" / key ":" — keying NAMED by the unshifted
// char missed it → vk 0 (the page's keyCode handlers + browser shortcuts never fired).
{
  const vk = (key, code) => virtualKeyCode(key, code);
  check("keymap: shifted symbols resolve to the correct vk, not 0",
    vk(":", "Semicolon") === 186 && vk("?", "Slash") === 191 && vk("{", "BracketLeft") === 219 &&
    vk("+", "Equal") === 187 && vk("~", "Backquote") === 192 && vk("_", "Minus") === 189 && vk('"', "Quote") === 222);
  check("keymap: numpad operators resolve by code (Add/Subtract/Multiply/Divide/Decimal)",
    vk("+", "NumpadAdd") === 107 && vk("-", "NumpadSubtract") === 109 && vk("*", "NumpadMultiply") === 106 &&
    vk("/", "NumpadDivide") === 111 && vk(".", "NumpadDecimal") === 110);
  check("keymap: alphanumerics + named keys + key-only fallback still map (regression guard)",
    vk("a", "KeyA") === 65 && vk("5", "Digit5") === 53 && vk("Enter", "Enter") === 13 &&
    vk("Tab", "Tab") === 9 && vk(";", undefined) === 186 && virtualKeyCode(undefined, "Numpad3") === 99);
}

// ── cdp.ts robustness (round-3): a malformed frame / throwing handler must not crash the
// reader, and close() must DRAIN in-flight calls (reject fast, not hang the 15s timeout) ──
{
  let PORT = 0;
  const wss = new WebSocketServer({ noServer: true });
  const srv = http.createServer((req, res) => {
    if (req.url === "/json") {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify([{ type: "page", id: "pg", url: "about:blank", title: "t",
        webSocketDebuggerUrl: `ws://127.0.0.1:${PORT}/devtools/page/pg` }]));
    } else { res.statusCode = 404; res.end(); }
  });
  srv.on("upgrade", (req, sock, head) => wss.handleUpgrade(req, sock, head, (ws) => wss.emit("connection", ws)));
  wss.on("connection", (ws) => {
    ws.send("this is not valid json {{{");                    // malformed frame on connect (must be ignored)
    ws.on("message", (m) => {
      let d; try { d = JSON.parse(m.toString()); } catch { return; }
      if (d.method === "Never.answer") return;                // ignore → exercises drain-on-close
      if (d.method === "Emit.event") ws.send(JSON.stringify({ method: "Test.event", params: {} })); // → throwing handler
      ws.send(JSON.stringify({ id: d.id, result: { echoed: d.method } }));
    });
  });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  PORT = srv.address().port;
  const conn = await attachPage(`http://127.0.0.1:${PORT}`);
  conn.on("Test.event", () => { throw new Error("boom — a subscriber that throws must not kill the reader"); });
  await conn.call("Emit.event").catch(() => {});              // emits the event (handler throws) then replies
  const okCall = await conn.call("Echo.ping").catch(() => null);
  check("cdp: a malformed frame + a throwing event handler don't kill the reader (a later call still works)",
    !!okCall && okCall.echoed === "Echo.ping");
  const neverP = conn.call("Never.answer").then(() => "resolved", (e) => "rejected:" + e.message);
  conn.close();                                               // must drain the in-flight call immediately
  const drained = await Promise.race([neverP, new Promise((r) => setTimeout(() => r("HUNG"), 2000))]);
  check("cdp: close() drains an in-flight call (rejects fast, no 15s hang)", typeof drained === "string" && drained.startsWith("rejected"));
  srv.close(); wss.close();
}

// ── engine (round-3): CDP ports are RECLAIMED, not monotonically exhausted ──
// `nextCdp++` forever crossed 65535 after ~56k create/destroy cycles → invalid ports.
// A freed port (here via the create-rollback path) must be reused by the next create.
{
  const flEngine = new Lucarne({ port: 7865, record: false, backends: [] });
  const got = [];
  // CDP never comes up (no real backend), so startSessionMedia throws → create rolls back
  // and returns the port to the free-list. The next create must pop that same port.
  flEngine.registerBackend({ kind: "fake", start: async (_id, ports) => { got.push(ports.cdp); return { async stop() {} }; } });
  await flEngine.listen();
  for (const p of ["fl1", "fl2", "fl3"]) { try { await flEngine.create({ backend: "fake", profile: p }); } catch { /* expected */ } }
  await flEngine.close().catch(() => {});
  check("engine: a CDP port freed by a rolled-back create is REUSED (no monotonic exhaustion)",
    got.length === 3 && got[0] === got[1] && got[1] === got[2]);
}

// ── Tunnel seam: expose via a tunnel you already have (no network needed here) ──
// Proven deterministically with a stub --tunnel-cmd (a node one-liner that prints a
// fake public URL), so ngrok/cloudflared aren't required in CI.
{
  check("tunnel: pickPublicUrl extracts the public https URL, skips the loopback inspector",
    pickPublicUrl("addr=http://127.0.0.1:4040 url=https://ab12.ngrok-free.app") === "https://ab12.ngrok-free.app");
  // REGRESSION (caught by a real cloudflared run): its banner prints a cloudflare.com
  // terms link + a developers.cloudflare.com docs link BEFORE the tunnel URL — the preset
  // matcher must pick the trycloudflare URL, not the first https it sees.
  const CF_BANNER = "INF Thank you for trying Cloudflare Tunnel. ... Terms of Use (https://www.cloudflare.com/website-terms/), ... following: https://developers.cloudflare.com/cloudflare-one/connections/connect-apps\nINF |  https://camel-shut-printing-advantages.trycloudflare.com  |";
  check("tunnel: cloudflared preset picks the trycloudflare URL, not the banner/terms links",
    pickPublicUrl(CF_BANNER, "cloudflared") === "https://camel-shut-printing-advantages.trycloudflare.com");
  const NG_LOG = 't=.. lvl=info msg="started tunnel" url=https://8bdfb460c7c9.ngrok.app\nt=.. addr=http://127.0.0.1:4040\nt=.. https://dashboard.ngrok.com/get-started';
  check("tunnel: ngrok preset picks the ngrok URL, not the dashboard/inspector",
    pickPublicUrl(NG_LOG, "ngrok") === "https://8bdfb460c7c9.ngrok.app");
  // multi-label (regional/reserved) ngrok host must still match
  check("tunnel: ngrok preset matches a multi-label regional host",
    pickPublicUrl("url=https://myname.eu.ngrok.io done", "ngrok") === "https://myname.eu.ngrok.io");
  // preset pattern miss → fall through to the generic non-noise heuristic (don't time out a live tunnel)
  check("tunnel: a preset miss falls through to the generic URL (no false timeout)",
    pickPublicUrl("addr=http://127.0.0.1:4040 url=https://custom.example.net/abc", "ngrok") === "https://custom.example.net/abc");
  const ng = tunnelSpawnSpec({ preset: "ngrok", host: "127.0.0.1", port: 7800 });
  check("tunnel: ngrok preset builds the right command", ng.file === "ngrok" && ng.args.join(" ") === "http 127.0.0.1:7800 --log stdout");
  const cf = tunnelSpawnSpec({ preset: "cloudflared", host: "127.0.0.1", port: 7800 });
  check("tunnel: cloudflared preset builds the right command", cf.file === "cloudflared" && cf.args.join(" ") === "tunnel --url http://127.0.0.1:7800");
  const tk = ensureTunnelToken(undefined);
  check("tunnel: forces a token when none is set (never expose unauthenticated)", tk.generated && /^[0-9a-f]{48}$/.test(tk.token));
  check("tunnel: keeps an existing token", ensureTunnelToken("abc").generated === false);
  const h = await startTunnel({ cmd: `node -e "console.log('https://stub.test/xyz'); setInterval(()=>{},1e9)"`, host: "127.0.0.1", port: 7800, timeoutMs: 8000 });
  check("tunnel: startTunnel spawns a --tunnel-cmd and resolves its public URL", h.url === "https://stub.test/xyz");
  h.stop();
  // stop() must tear down the WHOLE process group — a non-exec shell wrapper has a real
  // grandchild that SIGTERM-to-the-shell alone would orphan (leaking the public ingress).
  const MARK = "lucarne_orphan_proof_" + process.pid;
  const hg = await startTunnel({ cmd: `echo https://stub.test/g; sleep 60 # ${MARK}`, host: "127.0.0.1", port: 7800, timeoutMs: 6000 });
  const aliveBefore = execFileSync("pgrep", ["-f", MARK], { encoding: "utf8" }).trim().length > 0;
  hg.stop();
  await sleep(1800);
  let aliveAfter = false;
  try { aliveAfter = execFileSync("pgrep", ["-f", MARK], { encoding: "utf8" }).trim().length > 0; } catch { aliveAfter = false; }
  check("tunnel: stop() kills the whole process group (no orphaned tunnel)", hg.url === "https://stub.test/g" && aliveBefore && !aliveAfter);
  let terr = "";
  try { await startTunnel({ cmd: "definitely-not-a-real-binary-xyz", host: "127.0.0.1", port: 7800, timeoutMs: 5000 }); } catch (e) { terr = e.message; }
  check("tunnel: a bad tunnel command fails with a clear error", /tunnel (binary not found|exited|failed)/.test(terr));
}

// ── Recording: REAL browser frames → ffmpeg → a finalized, playable mp4 ───────
// Grab a real screencast JPEG from a live session, feed it to the recorder, then
// close it gracefully (ffmpeg finalizes the segment on stdin-EOF) and ffprobe the
// result. This proves the record pipeline (frames → encoder → playable mp4)
// deterministically — no dependence on the segment muxer's cut timing.
const recEngine = new Lucarne({ port: 7833, token: TOKEN, record: false });
await recEngine.listen();
try {
  const rs = await recEngine.create({ backend: "native", profile: "rec" });
  const rc = await attachPage(rs.cdpUrl);
  await rc.call("Runtime.evaluate", { expression: "document.body.innerHTML='<h1 style=\"font:80px monospace\">REC</h1>'" });
  const frame = await new Promise((res) => {
    const w = new WS(`ws://127.0.0.1:7833/sessions/rec/view/ws?token=${TOKEN}`);
    const t = setTimeout(() => { try { w.close(); } catch {} res(null); }, 5000);
    w.on("message", (d) => { if (Buffer.isBuffer(d) && d.length > 1000) { clearTimeout(t); w.close(); res(d); } });
    w.on("error", () => res(null));
  });
  rc.close();

  const recDir = fs.mkdtempSync(path.join(os.tmpdir(), "lucarne-rectest-"));
  let dur = 0, segName = null, segBytes = 0;
  if (frame) {
    const rec = startRecorder({ recDir, fps: 6, retentionMin: 60, segmentSeconds: 2, frames: { get: () => frame, subscribe: () => () => {} } });
    if (rec) {
      await sleep(2500);            // ffmpeg encodes ~15 frames of the real JPEG
      rec.close();                  // graceful: ffmpeg flushes + finalizes the segment
      await sleep(3500);            // let it write the moov + exit
    }
    for (const f of fs.readdirSync(recDir)) {
      if (!f.startsWith("seg_") || !f.endsWith(".mp4")) continue;
      const fp = path.join(recDir, f);
      if (fs.statSync(fp).size < 1000) continue;
      try { const d = parseFloat(execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", fp], { encoding: "utf8" }).trim()); if (d > 0) { dur = d; segName = f; segBytes = fs.statSync(fp).size; break; } } catch { /* */ }
    }
  }
  fs.rmSync(recDir, { recursive: true, force: true });
  await recEngine.destroy(rs.id);
  check("recording: real frames produce a finalized, playable mp4", dur > 0 && !!segName, segName ? `${segName} ${segBytes}B ${dur}s` : (frame ? "no playable segment" : "no frame"));
} finally {
  await recEngine.close().catch(() => {});
}

// ── Recording END-TO-END THROUGH THE ENGINE (record:true wires the recorder) ──
// The unit proof above bypasses the engine; this proves create({record}) actually
// records and GET /recordings/:file serves a real mp4 over HTTP.
const e2eRec = new Lucarne({ port: 7834, token: TOKEN, record: true, fps: 6, segmentSeconds: 1 });
await e2eRec.listen();
try {
  const es = await e2eRec.create({ backend: "native", profile: "e2erec" });
  const ec = await attachPage(es.cdpUrl);
  // Drive light visual change (a counter) so the headless screencast emits real frames —
  // proving the engine wires record:true → recorder → /recordings serves REAL mp4 bytes
  // (not the weakened 200/MIME check a 48B stub passed). The frame-watchdog additionally
  // covers fully-static pages best-effort. Scan all segments for a finalized real one.
  let n = 0, segCount = 0, real = false;
  for (let i = 0; i < 24 && !real; i++) {
    await ec.call("Runtime.evaluate", { expression: `document.body.innerHTML='<h1 style="font:120px monospace;color:#0a0">REC ${i} ${Date.now()}</h1>'` });
    await sleep(700);
    const segs = await (await fetch(`http://127.0.0.1:7834/sessions/e2erec/recordings?token=${TOKEN}`)).json();
    segCount = Array.isArray(segs) ? segs.length : 0;
    for (const seg of (Array.isArray(segs) ? segs : []).slice().reverse()) {
      const res = await fetch(`http://127.0.0.1:7834/sessions/e2erec/recordings/${seg}?token=${TOKEN}`);
      const buf = Buffer.from(await res.arrayBuffer());
      if (res.status === 200 && buf.length > 2000 && buf.includes(Buffer.from("ftyp"))) { n = buf.length; real = true; break; }
    }
  }
  ec.close();
  check("recording(e2e): create({record:true}) records an active headless page to a real mp4 (>2KB) via /recordings", real, `${segCount} segs, ${n}B`);
  await e2eRec.destroy(es.id);
} finally {
  await e2eRec.close().catch(() => {});
}

// ── Redaction P0: a password typed before a submit/nav is STILL redacted ──────
// Own session so it can't perturb the activity-attribution timing. Secrecy is
// captured at type-TIME (field focused), so a flush triggered by the navigation
// (field gone) must still redact — the old flush-time read failed open and leaked.
const rdEngine = new Lucarne({ port: 7936, token: TOKEN, record: false, activity: true });
await rdEngine.listen();
try {
  const rd = await rdEngine.create({ backend: "native", profile: "redact" });
  const rdc = await attachPage(rd.cdpUrl);
  await rdc.call("Runtime.evaluate", { expression: "document.body.innerHTML='<input id=pw type=password name=login_pw>';document.getElementById('pw').focus()" });
  const rdw = new WS(`ws://127.0.0.1:${7936}/sessions/redact/view/ws?token=${TOKEN}`);
  await new Promise((r, j) => { rdw.on("open", r); rdw.on("error", j); });
  for (const k of ["h", "u", "n", "t", "e", "r", "2"]) { rdw.send(JSON.stringify({ t: "keydown", key: k, code: "Key" + k.toUpperCase() })); rdw.send(JSON.stringify({ t: "keyup", key: k, code: "Key" + k.toUpperCase() })); }
  await sleep(500);                                            // let keystrokes LAND in the password field
  rdc.send("Page.navigate", { url: "data:text/html,<title>after-submit</title>gone" });  // submit/blur before the 800ms flush
  // Poll-confirm the flush landed (not slept-for): a fixed sleep before reading activity risks
  // reading before the nav-triggered flush lands under CI load, flaking the `types.length>0`
  // conjunct below on an otherwise-passing run. Bounded; throws if the flush never lands.
  const types = await pollActivity(rdEngine, "redact", (acts) => acts.length > 0, 3000, "pre-nav password flush recorded");
  rdw.close(); rdc.close();
  check("activity(P0): a password typed before a submit/nav is STILL redacted (no race leak)",
    types.length > 0 && types.every((e) => e.value === "‹redacted›") && JSON.stringify(types).indexOf("hunter2") === -1);
  await rdEngine.destroy(rd.id);
} finally {
  await rdEngine.close().catch(() => {});
}

// ── Redaction (round-3 regression): a cross-field Tab into a password leaks no plaintext ──
// Type into a NON-secret username field, Tab to the password field, type the password. 1.4.0
// captured secrecy only at type-START and Tab did NOT flush — so "alice<Tab>hunter2" coalesced
// into ONE run classified by the username field and the password leaked UNredacted. Fix: flush
// on Tab/Enter + union (start∪end, fail-closed) flush-time secrecy.
//
// GROUND TRUTH (measured in CI): a synthetic Tab both flushes the "alice" run AND advances DOM
// focus to #pw, so "alice"'s async end-read reads #pw and "alice" is DETERMINISTICALLY redacted;
// hunter2 then lands in #pw as its own redacted run. Whether "alice" survives unredacted depends
// on the synthetic Tab's focus-advance losing a race to the end-read — intrinsically flaky and
// NOT a safety property (over-redacting a username leaks nothing). So we assert the DETERMINISTIC
// invariants:
//   * hunterGone  — the password never appears in plaintext ANYWHERE (SAFETY; catches the full
//                   1.4.0 leak: no-Tab-flush + start-only secrecy → coalesced plaintext run).
//   * pwRedacted  — a run classified to the password field (#pw name="login_pw") exists AND is
//                   "‹redacted›": the password path was actually exercised and redacted (non-
//                   vacuous), and it ALSO catches the no-Tab-flush coalesce (which records ONE run
//                   classified to #u — field "username", no "login_pw" run — so pwRedacted fails),
//                   provided hunter2 is typed within the 800ms coalesce window (we type it promptly
//                   after focus lands; a >800ms focus stall could let a regressed engine idle-flush
//                   "alice" separately and mask THAT non-safety variant on that run — the SAFETY
//                   invariant hunterGone is unaffected and stays deterministic).
// #pw focus is poll-verified before typing the password (a synthetic focus/Tab isn't reliably
// observable by later synthetic input under load); the final read polls until the password run is
// recorded (a redacted login_pw run, or — in a leaking regression — a plaintext hunter2) rather
// than sleeping.
const xfEngine = new Lucarne({ port: 7937, token: TOKEN, record: false, activity: true });
await xfEngine.listen();
try {
  const xf = await xfEngine.create({ backend: "native", profile: "xredact" });
  const xfc = await attachPage(xf.cdpUrl);
  await xfc.call("Runtime.evaluate", { expression: "document.body.innerHTML='<input id=u name=username><input id=pw type=password name=login_pw>';document.getElementById('u').focus()" });
  const xfw = new WS(`ws://127.0.0.1:${7937}/sessions/xredact/view/ws?token=${TOKEN}`);
  await new Promise((r, j) => { xfw.on("open", r); xfw.on("error", j); });
  const tap = (key, code) => { xfw.send(JSON.stringify({ t: "keydown", key, code })); xfw.send(JSON.stringify({ t: "keyup", key, code })); };
  const xfTypes = () => xfEngine.sessionActivity("xredact").filter((a) => a.kind === "type");
  const softPoll = async (pred, timeoutMs) => {   // returns bool; NEVER throws (timeout is a branch, not a failure)
    const deadline = Date.now() + timeoutMs;
    for (;;) { if (await pred()) return true; if (Date.now() >= deadline) return false; await sleep(80); }
  };
  for (const k of ["a", "l", "i", "c", "e"]) tap(k, "Key" + k.toUpperCase());  // username (non-secret)
  tap("Tab", "Tab");                                                            // flush boundary + focus advance
  await xfc.call("Runtime.evaluate", { expression: "document.getElementById('pw').focus()" });  // backstop the focus advance
  const focused = await softPoll(async () => {
    const r = await xfc.call("Runtime.evaluate", { expression: "document.activeElement && document.activeElement.id", returnByValue: true });
    return r.result?.value === "pw";
  }, 3000);
  if (!focused) throw new Error("P0 setup: focus never landed on #pw");
  for (const k of ["h", "u", "n", "t", "e", "r", "2"]) tap(k, "Key" + k.toUpperCase());  // password — #pw is the focused field
  // Wait until the password run has flushed: a login_pw run recorded, OR (leaking regression) a plaintext hunter2 anywhere.
  await softPoll(() => { const t = xfTypes(); return t.some((e) => e.field === "login_pw") || JSON.stringify(t).includes("hunter2"); }, 6000);
  xfw.close(); xfc.close();
  const types = xfTypes();
  const blob = JSON.stringify(types);
  const hasTypes = types.length > 0;
  const hunterGone = blob.indexOf("hunter2") === -1;                                          // SAFETY: no plaintext leak anywhere
  const pwRedacted = types.some((e) => e.field === "login_pw" && e.value === "‹redacted›");   // password run present AND redacted (non-vacuous; catches coalesce)
  check("activity(P0): a password typed AFTER a Tab from a non-secret field is NOT leaked (cross-field)",
    hasTypes && hunterGone && pwRedacted,
    `hasTypes=${hasTypes} hunterGone=${hunterGone} pwRedacted=${pwRedacted} types=${blob}`);
  await xfEngine.destroy(xf.id);
} finally {
  await xfEngine.close().catch(() => {});
}

// ── Headful path (the real default for users) — gated so local runs stay focus-free ──
if (process.env.LUCARNE_TEST_HEADED === "1") {
  const hEngine = new Lucarne({ port: 7835, token: TOKEN, record: false });
  await hEngine.listen();
  try {
    const hs = await hEngine.create({ backend: "native", profile: "headed", headless: false });
    const hb = await chromium.connectOverCDP(hs.cdpUrl);
    const hp = await firstPage(hb);
    await hp.goto("https://example.com", { waitUntil: "domcontentloaded" });
    const ok = (await hp.title()) === "Example Domain";
    await hb.close();
    check("headed: native launches a real headful Chrome + drives", ok);
  } finally {
    await hEngine.close().catch(() => {});
  }
} else {
  console.log("  SKIP  headed: native headful path (set LUCARNE_TEST_HEADED=1 to verify)");
}

// ── STICKY INJECTION (LS-02): a registered script survives (a) a page reload,
// (b) a NEWLY OPENED tab (raw CDP target discovery — the engine has no
// Playwright `BrowserContext.on('page')`), and (c) a full engine daemon restart
// (the durable session's persisted spec carries the injection; `restore()`
// re-applies it). This is the one CHROME-REQUIRED half of LS-02's proof — the
// non-browser half (store/policy/registry-round-trip logic) lives in the
// separate, no-Chrome-needed `test/inject-unit.mjs` (run via `node
// test/inject-unit.mjs`, no build-time Chrome dependency).
{
  const INJHOME = fs.mkdtempSync(path.join(os.tmpdir(), "lucarne-inject-"));
  const injRegistry = path.join(INJHOME, "sessions.json");
  const MARKER = "lucarne-inject-" + ID;
  const markerSource = `document.documentElement.setAttribute('data-lucarne-inject', ${JSON.stringify(MARKER)});`;
  const readMarker = async (cdp) => (await cdp.call("Runtime.evaluate", { expression: "document.documentElement.getAttribute('data-lucarne-inject')", returnByValue: true })).result?.value ?? null;
  try {
    const injEngine = new Lucarne({ port: 7940, token: TOKEN, record: false, registryFile: injRegistry });
    await injEngine.listen();
    try {
      const s = await injEngine.create({ backend: "native", profile: "inj" });
      await injEngine.setInjection(s.id, { id: "marker", source: markerSource });
      check("inject: GET lists the registered id", (await injEngine.injectionIds(s.id)).includes("marker"));

      const c1 = await attachPage(s.cdpUrl);
      c1.send("Page.navigate", { url: "https://example.com" });
      await sleep(1500);
      check("inject: applied into the already-open page (eval, not just future reloads)", (await readMarker(c1)) === MARKER);

      // (a) SURVIVES A RELOAD — the per-page load hook re-runs the source (with the
      // DOM present) on top of the document-start addScriptToEvaluateOnNewDocument hook
      c1.send("Page.reload", {});
      await sleep(1500);
      check("inject(a): survives a page reload", (await readMarker(c1)) === MARKER);
      c1.close();

      // (b) COVERS A NEWLY OPENED TAB — via raw CDP Target.setDiscoverTargets/targetCreated,
      // NOT a Playwright `context.on('page')` (the engine has no Playwright).
      const b = await attachBrowser(s.cdpUrl);
      const { targetId } = await b.call("Target.createTarget", { url: "https://example.com" });
      await sleep(1800); // let target discovery see it, apply the script, and the page load
      const c2 = await attachPage(s.cdpUrl, targetId);
      check("inject(b): covers a NEWLY OPENED tab (raw CDP target discovery)", (await readMarker(c2)) === MARKER);
      c2.close(); b.close();
    } finally {
      await injEngine.close().catch(() => {}); // graceful stop — KEEPS the persisted spec (not destroy)
    }

    // (c) SURVIVES A FULL ENGINE DAEMON RESTART — a fresh Lucarne process, same
    // registryFile, `restore()`s the durable session and re-applies its injection.
    const injEngine2 = new Lucarne({ port: 7941, token: TOKEN, record: false, registryFile: injRegistry });
    await injEngine2.listen();
    try {
      const restored = await injEngine2.restore();
      check("inject(c): durable session restored after daemon restart", restored.includes("inj"));
      const back = injEngine2.get("inj");
      if (back) {
        const c3 = await attachPage(back.cdpUrl);
        // The restored process re-applies immediately (eval into whatever page is open)...
        check("inject(c): marker present immediately on the restored session's page", (await readMarker(c3)) === MARKER);
        // ...AND the restore re-registered the source for FUTURE documents (the
        // document-start hook + the per-page load hook), not just a one-off eval —
        // prove it survives a FRESH navigation too.
        c3.send("Page.navigate", { url: "https://example.com" });
        await sleep(1500);
        check("inject(c): the injected script survives a full engine daemon restart (re-applied on the restored session + re-registered for future nav)", (await readMarker(c3)) === MARKER);
        c3.close();
      } else {
        check("inject(c): marker present immediately on the restored session's page", false);
        check("inject(c): the injected script survives a full engine daemon restart (re-applied on the restored session + re-registered for future nav)", false);
      }
      check("inject: GET still lists the id after restart (persisted + re-applied)", (await injEngine2.injectionIds("inj")).includes("marker"));
    } finally {
      await injEngine2.destroy("inj").catch(() => {});
      await injEngine2.close().catch(() => {});
    }
  } finally {
    fs.rmSync(INJHOME, { recursive: true, force: true });
  }
}

const failed = results.filter((r) => !r.pass).length;
console.log(`\n${results.length - failed}/${results.length} acceptance proofs passed`);
process.exit(failed ? 1 : 0);
