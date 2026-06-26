// Acceptance proofs — each asserts REAL behavior end-to-end, not a 200.
// "Done" for a feature means its proof here passes. Run: npm run test:acceptance
// (needs Google Chrome installed — exercises the native backend.)
import { Lucarne } from "../dist/index.js";
import { attachPage, attachBrowser } from "../dist/cdp.js";
import { chromium } from "playwright";
import WS from "ws";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";

// Durable profiles must be isolated + reclaimable across runs.
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "lucarne-acc-"));
const FILES = fs.mkdtempSync(path.join(os.tmpdir(), "lucarne-files-"));
process.env.LUCARNE_HOME = HOME;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
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
  let p = b.contexts()[0].pages()[0];
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
  p = b.contexts()[0].pages()[0];
  await p.evaluate(() => document.getElementById("i").focus());
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

  // 6. FILE UPLOAD — inject a host file into <input type=file>; page sees name + bytes
  const upBytes = crypto.randomBytes(2048);
  const upSha = crypto.createHash("sha256").update(upBytes).digest("hex");
  const upPath = path.join(FILES, "up.bin");
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

  // a named profile must NOT re-seed once established (no clobber on reuse)
  const s3dir = path.join(HOME, "profiles", "seed-B");
  check("seed: only seeds on first creation (profile dir exists)", fs.existsSync(path.join(s3dir, "Default")));
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
  const st = lEngine.status(ls.id);
  check("status: rich object (uptime + dims)", !!st && st.uptimeMs >= 0 && st.viewport.width === 1280 && st.viewport.height === 720 && typeof st.idleMs === "number");

  // activity resets the idle clock: touch through the window, stays alive past it
  for (let i = 0; i < 6; i++) { await sleep(200); lEngine.touch(ls.id); }    // ~1.2s of touches, deadline 700ms
  check("inactivity: touch keeps a session alive past its idle window", !!lEngine.get(ls.id));

  // stop touching: reaped after the idle window elapses
  let reaped = false;
  for (let i = 0; i < 20 && !reaped; i++) { await sleep(150); reaped = !lEngine.get(ls.id); }
  check("inactivity: idle session auto-reaped", reaped);

  // max-duration: dies on schedule regardless of activity (touch every tick, still reaped)
  const lt = await lEngine.create({ backend: "native", profile: "life2", timeoutMs: 700 });
  let tReaped = false;
  for (let i = 0; i < 20 && !tReaped; i++) { await sleep(150); lEngine.touch(lt.id); tReaped = !lEngine.get(lt.id); }
  check("timeout: max-duration reaps even an active session", tReaped);
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
  await ca.call("Runtime.evaluate", { expression: `document.cookie='ctx_c=val-${ID};path=/';localStorage.setItem('ctx_l','ls-${ID}');` });
  const exported = await cEngine.exportContext(A.id);
  const hasC = exported.cookies.some((c) => c.name === "ctx_c" && c.value === `val-${ID}`);
  check("context: export captures cookies + localStorage", hasC && exported.localStorage.ctx_l === `ls-${ID}` && exported.origin === "https://example.com");

  // restore into a DIFFERENT session — no profile sharing, pure runtime transfer
  const B = await cEngine.create({ backend: "native", profile: "ctxB" });
  const cb = await attachPage(B.cdpUrl);
  cb.send("Page.navigate", { url: "https://example.com" });
  await sleep(1200);
  await cEngine.importContext(B.id, exported);
  const bCookies = (await cb.call("Network.getAllCookies")).cookies;
  const bLs = (await cb.call("Runtime.evaluate", { expression: "localStorage.getItem('ctx_l')", returnByValue: true })).result.value;
  ca.close(); cb.close();
  check("context: import restores cookies + localStorage into another session", bCookies.some((c) => c.name === "ctx_c" && c.value === `val-${ID}`) && bLs === `ls-${ID}`);

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
  const st = nEngine.status(ns.id);
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
  const ls = await lgEngine.create({ backend: "native", profile: "logs", metadata: { purpose: "test", tier: "p2" } });
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
  lc.close();
} finally {
  await lgEngine.close().catch(() => {});
}

const failed = results.filter((r) => !r.pass).length;
console.log(`\n${results.length - failed}/${results.length} acceptance proofs passed`);
process.exit(failed ? 1 : 0);
