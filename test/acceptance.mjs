// Acceptance proofs — each asserts REAL behavior end-to-end, not a 200.
// "Done" for a feature means its proof here passes. Run: npm run test:acceptance
// (needs Google Chrome installed — exercises the native backend.)
import { Lucarne } from "../dist/index.js";
import { chromium } from "playwright";
import WS from "ws";

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
  iw.close();
  await b.close();
} finally {
  if (session) await engine.destroy(session.id).catch(() => {});
  await engine.close().catch(() => {});
}

const failed = results.filter((r) => !r.pass).length;
console.log(`\n${results.length - failed}/${results.length} acceptance proofs passed`);
process.exit(failed ? 1 : 0);
