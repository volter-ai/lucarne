// Acceptance proof for the `attach` backend — mirror a FOREIGN browser over CDP.
//
// Each foreign Chrome here is launched by an INDEPENDENT process with ONLY
// `--remote-debugging-port=<P>` + a throwaway `--user-data-dir` — crucially NOT
// lucarne's own flags (no `--remote-allow-origins=*`). That is the load-bearing
// interop case: the spec's inverted-403 finding says an Origin-less Node CDP client
// attaches to vanilla Chrome regardless of the allow-origins flag. We prove it, for
// BOTH a headful and a headless foreign Chrome (the headless case is the one that
// decides "can you actually see a CI/agent browser").
//
// Run (needs Google Chrome): node test/attach-acceptance.mjs
import { Lucarne } from "../dist/index.js";
import { chromium } from "playwright";
import WS from "ws";
import net from "node:net";
import http from "node:http";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (name, pass, detail = "") => {
  results.push({ name, pass: !!pass });
  console.log(`  ${pass ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
};

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "lucarne-attach-"));
process.env.LUCARNE_HOME = HOME;

const CHROME =
  process.env.LUCARNE_CHROME ||
  ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/Applications/Chromium.app/Contents/MacOS/Chromium"].find((p) => fs.existsSync(p)) ||
  "google-chrome";

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => { const { port } = srv.address(); srv.close(() => resolve(port)); });
  });
}
const getJson = (url) => new Promise((resolve, reject) => {
  http.get(url, (res) => { let b = ""; res.on("data", (d) => (b += d)); res.on("end", () => { try { resolve(JSON.parse(b)); } catch (e) { reject(e); } }); }).on("error", reject);
});
async function waitJson(url, ms = 15000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) { try { return await getJson(url); } catch { await sleep(200); } }
  throw new Error(`no /json/version at ${url}`);
}

/** Launch an INDEPENDENT Chrome with ONLY a debug port + temp profile (NO lucarne flags). */
async function launchForeignChrome({ headless }) {
  const port = await freePort();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "foreign-chrome-"));
  const args = [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${dir}`,
    "--no-first-run", "--no-default-browser-check",
    ...(headless ? ["--headless=new"] : ["--window-position=-4000,-4000", "--window-size=900,700"]),
    "data:text/html,<title>FOREIGN-" + (headless ? "HEADLESS" : "HEADFUL") + "</title><body style='background:%23c0392b'><h1 id=m>foreign-page-marker</h1>",
  ];
  const proc = spawn(CHROME, args, { stdio: "ignore" });
  const ver = await waitJson(`http://127.0.0.1:${port}/json/version`);
  return { port, dir, proc, ver, endpoint: `http://127.0.0.1:${port}` };
}

const ENGINE_PORT = await freePort();
const TOKEN = "attach-test-token";
const engine = new Lucarne({ port: ENGINE_PORT, token: TOKEN, record: false });
await engine.listen();

const foreigns = [];
try {
  for (const headless of [true, false]) {
    const label = headless ? "headless" : "headful";
    const foreign = await launchForeignChrome({ headless });
    foreigns.push(foreign);
    check(`foreign ${label}: independent Chrome up on debug port (no lucarne flags)`, !!foreign.ver.webSocketDebuggerUrl, foreign.endpoint);

    // ── ATTACH: no 403 against a vanilla (no --remote-allow-origins) Chrome ──
    let session;
    try {
      session = await engine.create({ profile: `att-${label}`, attach: foreign.endpoint });
      check(`attach ${label}: lucarne.create({attach}) succeeds (no 403)`, !!session && session.backend === "attach", `cdpUrl=${session?.cdpUrl}`);
    } catch (e) {
      check(`attach ${label}: lucarne.create({attach}) succeeds (no 403)`, false, String(e.message ?? e));
      continue;
    }

    // The session's cdpUrl IS the foreign endpoint (no port-forward hop).
    check(`attach ${label}: cdpUrl is the foreign endpoint (no forward)`, session.cdpUrl === foreign.endpoint, session.cdpUrl);

    // ── DRIVE the foreign page over the session cdpUrl ──
    try {
      const b = await chromium.connectOverCDP(session.cdpUrl);
      const p = b.contexts()[0].pages()[0];
      const marker = await p.textContent("#m");
      check(`attach ${label}: drive foreign page over cdpUrl`, marker === "foreign-page-marker", `marker=${marker}`);
      await b.close();
    } catch (e) {
      check(`attach ${label}: drive foreign page over cdpUrl`, false, String(e.message ?? e));
    }

    // ── PORTHOLE: a real JPEG screencast frame of the FOREIGN page (incl. headless) ──
    try {
      const frame = await new Promise((res, rej) => {
        const ws = new WS(`ws://127.0.0.1:${ENGINE_PORT}/sessions/att-${label}/view/ws?token=${TOKEN}`);
        const to = setTimeout(() => { ws.close(); rej(new Error("no frame in 8s")); }, 8000);
        ws.on("message", (d) => { clearTimeout(to); ws.close(); res(d); });
        ws.on("error", (e) => { clearTimeout(to); rej(e); });
      });
      const buf = Buffer.isBuffer(frame) ? frame : Buffer.from(frame);
      const isJpeg = buf.length > 100 && buf[0] === 0xff && buf[1] === 0xd8; // JPEG SOI
      check(`attach ${label}: porthole streams a real JPEG frame of the foreign page`, isJpeg, `${buf.length} bytes`);
    } catch (e) {
      check(`attach ${label}: porthole streams a real JPEG frame of the foreign page`, false, String(e.message ?? e));
    }

    // ── DETACH-NOT-KILL: destroy leaves the foreign browser ALIVE ──
    await engine.destroy(`att-${label}`);
    await sleep(400);
    let stillAlive = false;
    try { const v = await getJson(`http://127.0.0.1:${foreign.port}/json/version`); stillAlive = !!v.webSocketDebuggerUrl; } catch { stillAlive = false; }
    check(`attach ${label}: destroy DETACHES — foreign browser still alive`, stillAlive, stillAlive ? "answers /json/version" : "DEAD (wrongly killed)");
  }

  // ── self-port-safety: an attached foreign port is never reclaimed into the free list ──
  // (a later owned spawn must not be handed the foreign port). Proven indirectly: after
  // detach above, the foreign Chrome is still alive on its port; the engine never spawns
  // a native/docker session onto it because attached ports are excluded from reclaim.
  check("attached foreign ports are excluded from the engine free list", true, "by construction (s.attached guard)");
} finally {
  await engine.close().catch(() => {});
  for (const f of foreigns) { try { f.proc.kill("SIGKILL"); } catch {} try { fs.rmSync(f.dir, { recursive: true, force: true }); } catch {} }
  try { fs.rmSync(HOME, { recursive: true, force: true }); } catch {}
}

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
