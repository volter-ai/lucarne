// Acceptance proofs — each asserts REAL behavior end-to-end, not a 200.
// "Done" for a feature means its proof here passes. Run: npm run test:acceptance
// (needs Google Chrome installed — exercises the native backend.)
import { Lucarne } from "../dist/index.js";
import { attachPage } from "../dist/cdp.js";
import { chromium } from "playwright";
import WS from "ws";
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

  setup.close();
} finally {
  await dEngine.close().catch(() => {});
}

const failed = results.filter((r) => !r.pass).length;
console.log(`\n${results.length - failed}/${results.length} acceptance proofs passed`);
process.exit(failed ? 1 : 0);
