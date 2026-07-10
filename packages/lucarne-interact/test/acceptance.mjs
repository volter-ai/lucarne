// LS-09 acceptance proof — drives a REAL lucarne session with a REAL Chrome, over InteractSession.
// Needs Google Chrome installed (this sandbox has none — see the "No-usable-sandbox" note in the
// task); run via `npm run test:acceptance` in CI (the repo's acceptance job installs Chrome+xvfb
// and runs `npm run test:acceptance --workspaces --if-present`).
//
// Each check asserts REAL behavior end-to-end, not a 200 — modeled on
// packages/lucarne/test/acceptance.mjs's style. `lucarne` (the engine) is a devDependency of THIS
// package used ONLY to mint the real session this test drives; lucarne-interact's shipped src/
// still never imports it (dev/03's grep gate + the README's dep-graph note cover that).
import { Lucarne } from "lucarne";
import { chromium } from "playwright-core";
import { InteractSession } from "../dist/index.js";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const results = [];
const check = (name, pass, detail = "") => {
  results.push({ name, pass: !!pass });
  console.log(`  ${pass ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
};

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "lucarne-interact-acc-"));
process.env.LUCARNE_HOME = HOME;
if (!("LUCARNE_HEADLESS" in process.env)) process.env.LUCARNE_HEADLESS = "1";

const WORK = fs.mkdtempSync(path.join(os.tmpdir(), "lucarne-interact-acc-work-"));

// ── a tiny self-contained static site: a link to follow (for `back`), a heading (for `snap`), and
// a short local mp4 (for `video.*`) — so this proof needs no internet access. ──
const SAMPLE_MP4 = path.join(WORK, "sample.mp4");
const gen = spawnSync("ffmpeg", ["-y", "-f", "lavfi", "-i", "testsrc=size=64x64:rate=10", "-t", "1", "-pix_fmt", "yuv420p", SAMPLE_MP4], { encoding: "utf8" });
const haveSampleVideo = gen.status === 0 && fs.existsSync(SAMPLE_MP4);

const HOME_HTML = `<!doctype html><html><body>
  <h1 id="hdr">Interact Acceptance Home</h1>
  <a id="next" href="/next">go to next page</a>
  <video id="v" src="/sample.mp4" muted playsinline width="64" height="64"></video>
</body></html>`;
const NEXT_HTML = `<!doctype html><html><body><h1 id="hdr">Next Page</h1></body></html>`;
// A form whose submit is instrumented: if Enter/submit ever fires, window.__submitted flips true
// (preventDefault keeps the page put so the input stays inspectable). The input is autofocused so
// type() lands text without any click/activate (which would press Enter and defeat the "no submit"
// assertion). This is how the acceptance proves `type` STAGES ONLY.
const FORM_HTML = `<!doctype html><html><body>
  <h1 id="hdr">Form Page</h1>
  <form id="f" onsubmit="window.__submitted=true;return false;">
    <input id="inp" name="q" autofocus>
    <button id="go" type="submit">go</button>
  </form>
  <script>window.__submitted=false;</script>
</body></html>`;

const server = http.createServer((req, res) => {
  if (req.url === "/" || req.url === "/index.html") {
    res.writeHead(200, { "content-type": "text/html" });
    res.end(HOME_HTML);
  } else if (req.url === "/next") {
    res.writeHead(200, { "content-type": "text/html" });
    res.end(NEXT_HTML);
  } else if (req.url === "/form") {
    res.writeHead(200, { "content-type": "text/html" });
    res.end(FORM_HTML);
  } else if (req.url === "/sample.mp4" && haveSampleVideo) {
    res.writeHead(200, { "content-type": "video/mp4" });
    res.end(fs.readFileSync(SAMPLE_MP4));
  } else {
    res.writeHead(404);
    res.end("not found");
  }
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const PORT = server.address().port;
const BASE = `http://127.0.0.1:${PORT}`;

const engine = new Lucarne({ port: 7822, token: "t", record: false });
await engine.listen();
let session;
try {
  session = await engine.create({ backend: "native", profile: "interact-acc" });

  // Fast pacing so this proof doesn't take minutes, but the floor is still POSITIVE and still
  // ENFORCED — proving live pacing without disabling it (there's no way to disable it — see pacing.ts).
  const FAST_PACING = {
    nav: { mean: 40, sd: 10, min: 20 },
    scroll: { mean: 30, sd: 10, min: 15 },
    read: { mean: 30, sd: 10, min: 15 },
    act: { mean: 30, sd: 10, min: 15 },
  };
  const events = [];
  // Construct from the SESSION OBJECT (not just session.cdpUrl) — proves the `{cdpUrl}`-shaped
  // constructor overload works against a real lucarne session, not just a bare string.
  const s = new InteractSession(session, { pacing: FAST_PACING, timeoutMs: 15000 });
  s.on("action", (e) => events.push(e));

  // 1. open() — the single sanctioned bootstrap navigation
  const openRes = await s.open(BASE + "/");
  check("open(): navigates real Chrome to the given URL", openRes.url === BASE + "/", openRes.url);

  // 2. snap() — ARIA snapshot reads the real page
  const snap1 = await s.snap("body", 50);
  check("snap(): ARIA snapshot contains the real page heading", /Interact Acceptance Home/.test(snap1), snap1.slice(0, 120));

  // 3. scroll() — real keyboard PageDown, doesn't throw, reports count
  const scrollRes = await s.scroll(2);
  check("scroll(): reports the requested count", scrollRes.scrolled === 2);

  // 4. activate() — keyboard-first activation (focus + Enter) actually navigates
  await s.activate("#next");
  await new Promise((r) => setTimeout(r, 300));
  const snap2 = await s.snap("body", 50);
  check("activate(): keyboard Enter on the link actually navigated the real page", /Next Page/.test(snap2), snap2.slice(0, 120));

  // 5. back() — returns to the prior page (in-app selector absent here -> browser history path).
  //    Regression proof for the real-Chrome CI TimeoutError (`goBack` under the default `'load'`
  //    `waitUntil`, which does not reliably refire on a back navigation): assert the call resolves
  //    FAST (well under the old 8s history timeout) as well as that it actually navigated back.
  const backT0 = Date.now();
  const backRes = await s.back();
  const backMs = Date.now() - backT0;
  await new Promise((r) => setTimeout(r, 300));
  const snap3 = await s.snap("body", 50);
  check("back(): via 'history' (no in-app Back control on this fixture)", backRes.via === "history", backRes.via);
  check("back(): reports navigated:true (a history entry existed)", backRes.navigated === true, JSON.stringify(backRes));
  check("back(): the real page is back on the home fixture", /Interact Acceptance Home/.test(snap3), snap3.slice(0, 120));
  check("back(): completes fast, not by hitting the history timeout (well under 8000ms)", backMs < 4000, `${backMs}ms`);

  // 6. capture() — element screenshot via CDP lands a real, non-trivial PNG on disk (caller-supplied path)
  const capPath = path.join(WORK, "cap.png");
  const capRes = await s.capture("#hdr", capPath);
  const capBytes = fs.existsSync(capPath) ? fs.statSync(capPath).size : 0;
  check("capture(): writes a real PNG to the caller-supplied path", capRes.path === capPath && capBytes > 200, `${capBytes} bytes`);

  // 6b. where() — reports the SAME page's url + title that snap()/capture()/viewportShot() just
  //     read (self-consistent metadata, LS-22b) — a pure read, no navigation.
  const whereRes = await s.where();
  check("where(): reports the live page's url", whereRes.url === BASE + "/", whereRes.url);
  check("where(): reports the live page's title without throwing", typeof whereRes.title === "string");

  // 6c. viewportShot() — a VIEWPORT screenshot (not element-scoped, not full-page), contrasting
  //     with capture()'s element-bounding-box shot: assert a valid PNG whose dimensions are the
  //     bounded VIEWPORT size (same PNG-header check as packages/lucarne/test/acceptance.mjs's
  //     "screenshot: valid PNG at viewport width" proof), not some arbitrary/full-page size.
  const viewportPath = path.join(WORK, "viewport.png");
  const viewportRes = await s.viewportShot(viewportPath);
  const viewportPng = fs.existsSync(viewportPath) ? fs.readFileSync(viewportPath) : Buffer.alloc(0);
  const isPng = viewportPng.length > 1000 && viewportPng[0] === 0x89 && viewportPng[1] === 0x50 && viewportPng[2] === 0x4e && viewportPng[3] === 0x47;
  // PNG IHDR width/height are big-endian u32 at byte offsets 16 and 20.
  const viewportW = isPng ? viewportPng.readUInt32BE(16) : 0;
  const viewportH = isPng ? viewportPng.readUInt32BE(20) : 0;
  check(
    "viewportShot(): writes a valid PNG bounded to the viewport size (not element/full-page)",
    viewportRes.path === viewportPath && isPng && viewportW === 1280 && viewportH >= 560 && viewportH <= 720,
    `${viewportW}x${viewportH}, ${viewportPng.length}B`,
  );

  // 7. video.* — storyboard / clip / captions against the real local <video>
  if (haveSampleVideo) {
    const storyboardDir = path.join(WORK, "storyboard");
    const sb = await s.video.storyboard("#v", { outDir: storyboardDir, frames: 3 });
    const framesOnDisk = sb.frames.filter((f) => fs.existsSync(f.path) && fs.statSync(f.path).size > 0).length;
    check("video.storyboard(): captures the requested keyframe count, all non-empty PNGs on disk", sb.frames.length === 3 && framesOnDisk === 3, `${framesOnDisk}/${sb.frames.length}`);

    const clipPath = path.join(WORK, "clip.mp4");
    const clip = await s.video.clip("#v", clipPath);
    const clipBytes = fs.existsSync(clipPath) ? fs.statSync(clipPath).size : 0;
    check("video.clip(): assembles a real mp4 via the shared assembler, watched to completion", clip.watched_to_completion === true && clipBytes > 500, `${clipBytes} bytes, frames=${clip.frames}`);

    const captions = await s.video.captions("#v");
    check("video.captions(): the no-caption-cues path resolves cleanly against a real page", captions.ok === true && captions.source === "none");
  } else {
    check("video.* proofs skipped: local ffmpeg could not generate the fixture mp4 (environment issue, not a product defect)", false, gen.stderr?.slice(-300));
  }

  // 7b. type() — humanized typing STAGES text into a real input and NEVER presses Enter (LS-10).
  //     An independent read-only playwright connection is the ground-truth observer (input.value +
  //     the form's __submitted flag) — the test harness inspecting reality, not the product's API.
  {
    const insp = await chromium.connectOverCDP(session.cdpUrl);
    const inspCtx = insp.contexts()[0];
    const inspPage = inspCtx.pages()[0];
    try {
      await s.open(BASE + "/form");
      await inspPage.waitForSelector("#inp");
      await inspPage.locator("#inp").focus(); // deterministic focus setup (autofocus backstop)

      // (i) a full type() lands the exact text and fires NO submit.
      const draft = "hello world from the human paced typist";
      const typeRes = await s.type(draft);
      const landed = await inspPage.locator("#inp").inputValue();
      const submittedAfterType = await inspPage.evaluate(() => window.__submitted);
      check("type(): the exact staged text landed in the focused input", landed === draft, JSON.stringify(landed));
      check("type(): typed all chars, did not yield (no human present)", typeRes.yielded === false && typeRes.typed === [...draft].length);
      check("type(): STAGES ONLY — the form was NOT submitted (no Enter pressed)", submittedAfterType === false);

      // (ii) a simulated human mid-type ABORTS with { yielded:true } (PREFERRED activity path). The
      //      InteractSession is given an `activity` accessor that reports a fresh human action once
      //      typing is underway — the real page keystrokes stop partway; the input holds only the
      //      partial text; still no submit.
      await inspPage.locator("#inp").fill("");
      await inspPage.locator("#inp").focus();
      let probeCalls = 0;
      const yielding = new InteractSession(
        { cdpUrl: session.cdpUrl, activity: async () => ({ now: { lastHumanActionMsAgo: ++probeCalls >= 2 ? 120 : 9000 } }) },
        { pacing: FAST_PACING },
      );
      const yieldRes = await yielding.type("this draft should never be fully typed because a human grabs the keyboard", { yieldCheckEvery: 4 });
      const partial = await inspPage.locator("#inp").inputValue();
      const submittedAfterYield = await inspPage.evaluate(() => window.__submitted);
      check("type(): a simulated human mid-type yields ({ yielded:true })", yieldRes.yielded === true, JSON.stringify(yieldRes));
      check("type(): yielded before finishing (input holds only the partial text)", partial.length === yieldRes.typed && yieldRes.typed < yieldRes.chars, `partial=${partial.length} typed=${yieldRes.typed}/${yieldRes.chars}`);
      check("type(): STILL no submit on the yield path", submittedAfterYield === false);
      await yielding.close();
    } finally {
      await insp.close().catch(() => {});
    }
  }

  // 7c. send() — the GATED send (LS-11) against the SAME real form fixture. Stage via type(), then
  //     drive every decideSend branch + the composer-verification check with a REAL Chrome, proving
  //     "zero keypress on refuse" end-to-end (not just the mocked-transport unit proof in
  //     test/send-gate.mjs). An independent read-only playwright connection (the same pattern as
  //     7b) is ground truth for whether the form actually submitted.
  {
    const insp = await chromium.connectOverCDP(session.cdpUrl);
    const inspCtx = insp.contexts()[0];
    const inspPage = inspCtx.pages()[0];
    const okPolicy = async () => ({ blocked: false, mustAsk: false });
    // Fresh navigation reloads the fixture's inline script (`window.__submitted=false;`), so this
    // is also how each sub-test gets a clean slate.
    const resetForm = async () => {
      await s.open(BASE + "/form");
      await inspPage.waitForSelector("#inp");
      await inspPage.locator("#inp").focus();
    };
    try {
      // A. DEFAULT REFUSE — ask mode, no approval: send() must NOT press Enter.
      await resetForm();
      const draftA = "the human has not approved this yet";
      await s.type(draftA);
      const beforeA = await inspPage.locator("#inp").inputValue();
      const resA = await s.send(draftA, { gesture: { key: "Enter" }, policy: okPolicy, approval: { mode: "ask" } });
      const afterA = await inspPage.locator("#inp").inputValue();
      const submittedA = await inspPage.evaluate(() => window.__submitted);
      check("send(): ask mode with no approval REFUSES (sent:false)", resA.sent === false, JSON.stringify(resA));
      check("send(): refusal action is 'needs-approval'", resA.action === "needs-approval", resA.action);
      check("send(): NO keypress fired on refuse — composer still holds the staged draft, untouched", afterA === beforeA && afterA === draftA);
      check("send(): NO keypress fired on refuse — the form was NOT submitted", submittedA === false);

      // B. APPROVED — same staged draft (untouched by A's refusal) now sends for real.
      const resB = await s.send(draftA, { gesture: { key: "Enter" }, policy: okPolicy, approval: { mode: "ask", approved: true } });
      const submittedB = await inspPage.evaluate(() => window.__submitted);
      check("send(): ask mode WITH approval SENDS (sent:true)", resB.sent === true, JSON.stringify(resB));
      check("send(): approved action is 'send-approved'", resB.action === "send-approved", resB.action);
      check("send(): the keypress actually fired — the form WAS submitted", submittedB === true);

      // C. BLOCKED always blocks, even with approved:true (guardrails win over approval).
      await resetForm();
      const draftC = "this draft is blocked by the caller's policy";
      await s.type(draftC);
      const resC = await s.send(draftC, {
        gesture: { key: "Enter" },
        policy: async () => ({ blocked: true }),
        approval: { mode: "ask", approved: true },
      });
      const submittedC = await inspPage.evaluate(() => window.__submitted);
      check("send(): blocked policy REFUSES even when approved (sent:false)", resC.sent === false, JSON.stringify(resC));
      check("send(): blocked action is 'blocked'", resC.action === "blocked", resC.action);
      check("send(): blocked — NO keypress, form NOT submitted", submittedC === false);

      // D. ALWAYS-ASK needs an explicit ack, even when approved — then ack unblocks it.
      await resetForm();
      const draftD = "always-ask topic — needs explicit ack";
      await s.type(draftD);
      const resD1 = await s.send(draftD, {
        gesture: { key: "Enter" },
        policy: async () => ({ blocked: false, mustAsk: true }),
        approval: { mode: "ask", approved: true },
      });
      const submittedD1 = await inspPage.evaluate(() => window.__submitted);
      check("send(): always-ask topic REFUSES without --ack, even when approved (sent:false)", resD1.sent === false, JSON.stringify(resD1));
      check("send(): needs-ack action is 'needs-ack'", resD1.action === "needs-ack", resD1.action);
      check("send(): needs-ack — NO keypress, form NOT submitted", submittedD1 === false);

      const resD2 = await s.send(draftD, {
        gesture: { key: "Enter" },
        policy: async () => ({ blocked: false, mustAsk: true }),
        approval: { mode: "ask", ack: true },
      });
      const submittedD2 = await inspPage.evaluate(() => window.__submitted);
      check("send(): --ack on an always-ask topic SENDS (sent:true)", resD2.sent === true, JSON.stringify(resD2));
      check("send(): ack — the keypress fired, form WAS submitted", submittedD2 === true);

      // E. YOLO mode auto-sends with no per-send approval at all.
      await resetForm();
      const draftE = "yolo auto-send, no per-send approval";
      await s.type(draftE);
      const resE = await s.send(draftE, { gesture: { key: "Enter" }, policy: okPolicy, approval: { mode: "yolo" } });
      const submittedE = await inspPage.evaluate(() => window.__submitted);
      check("send(): yolo mode SENDS with no approval (sent:true)", resE.sent === true, JSON.stringify(resE));
      check("send(): yolo action is 'send-yolo'", resE.action === "send-yolo", resE.action);
      check("send(): yolo — the keypress fired, form WAS submitted", submittedE === true);

      // F. COMPOSER-VERIFICATION — approved, but the focused composer no longer holds the draft
      //    (stale / empty / focus-lost). Each refuses with a DISTINCT reason and zero keypress.
      await resetForm();
      const draftF = "this exact draft should be staged before sending";
      await s.type(draftF);
      await inspPage.locator("#inp").fill("a completely different, stale value");
      const resStale = await s.send(draftF, { gesture: { key: "Enter" }, policy: okPolicy, approval: { mode: "ask", approved: true } });
      check("send(): STALE composer refuses (sent:false)", resStale.sent === false, JSON.stringify(resStale));
      check("send(): stale composer action is 'composer-mismatch'", resStale.action === "composer-mismatch", resStale.action);
      check("send(): stale composer reports reason 'stale'", resStale.composerCheck?.reason === "stale", JSON.stringify(resStale.composerCheck));
      check("send(): stale composer — NO keypress fired", (await inspPage.evaluate(() => window.__submitted)) === false);

      await inspPage.locator("#inp").fill("");
      const resEmpty = await s.send(draftF, { gesture: { key: "Enter" }, policy: okPolicy, approval: { mode: "ask", approved: true } });
      check("send(): EMPTY composer refuses with reason 'empty'", resEmpty.sent === false && resEmpty.composerCheck?.reason === "empty", JSON.stringify(resEmpty));
      check("send(): empty composer — NO keypress fired", (await inspPage.evaluate(() => window.__submitted)) === false);

      await inspPage.locator("#inp").evaluate((el) => el.blur());
      const resFocusLost = await s.send(draftF, { gesture: { key: "Enter" }, policy: okPolicy, approval: { mode: "ask", approved: true } });
      check(
        "send(): FOCUS-LOST composer refuses with reason 'focus-lost'",
        resFocusLost.sent === false && resFocusLost.composerCheck?.reason === "focus-lost",
        JSON.stringify(resFocusLost),
      );
      check("send(): focus-lost composer — NO keypress fired", (await inspPage.evaluate(() => window.__submitted)) === false);

      // G. `{ submit }` gesture SKIPS the composer check entirely (browser.ts:516) — it still
      //    sends via the submit control even though the composer holds nothing that matches.
      await resetForm();
      await inspPage.locator("#inp").fill("");
      const resSubmit = await s.send("irrelevant to a submit-selector gesture", {
        gesture: { submit: "#go" },
        policy: okPolicy,
        approval: { mode: "ask", approved: true },
      });
      const submittedG = await inspPage.evaluate(() => window.__submitted);
      check("send(): { submit } gesture SENDS via the submit control, skipping the composer check (sent:true)", resSubmit.sent === true, JSON.stringify(resSubmit));
      check("send(): { submit } gesture — the submit control WAS activated", submittedG === true);
    } finally {
      await insp.close().catch(() => {});
    }
  }

  // 8. the tier property holds on a REAL, connected instance too (not just the offline unit proof)
  check("a live InteractSession still has no click/goto/eval members", s.click === undefined && s.goto === undefined && s.eval === undefined && s.video.click === undefined);
  check("a live InteractSession has a 'send' member (LS-11 landed)", typeof s.send === "function");

  // 9. pacing was actually ENFORCED live: every verb paid >= its configured floor, and events fired for each
  const kindByVerb = { open: "nav", snap: "read", scroll: "scroll", activate: "nav", back: "nav", capture: "read", where: "read", viewportShot: "read", "video.storyboard": "read", "video.clip": "read", "video.captions": "read" };
  const expectedVerbs = haveSampleVideo
    ? ["open", "snap", "scroll", "activate", "back", "capture", "where", "viewportShot", "video.storyboard", "video.clip", "video.captions"]
    : ["open", "snap", "scroll", "activate", "back", "capture", "where", "viewportShot"];
  for (const verb of expectedVerbs) {
    const e = events.find((ev) => ev.verb === verb);
    check(`on('action'): '${verb}' fired an event`, !!e);
    if (e) {
      const floor = FAST_PACING[kindByVerb[verb]].min;
      check(`on('action'): '${verb}' paced dwell (${e.pacedMs}ms) >= its configured floor (${floor}ms)`, e.pacedMs >= floor);
      check(`on('action'): '${verb}' event reports ok:true`, e.ok === true);
    }
  }

  await s.close();
} finally {
  if (session) await engine.destroy(session.id).catch(() => {});
  await engine.close().catch(() => {});
  server.close();
  fs.rmSync(WORK, { recursive: true, force: true });
  fs.rmSync(HOME, { recursive: true, force: true });
}

const failed = results.filter((r) => !r.pass).length;
console.log(`\n${results.length - failed}/${results.length} acceptance proofs passed`);
process.exit(failed ? 1 : 0);
