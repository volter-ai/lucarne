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

  // 8. the tier property holds on a REAL, connected instance too (not just the offline unit proof)
  check("a live InteractSession still has no click/goto/eval members", s.click === undefined && s.goto === undefined && s.eval === undefined && s.video.click === undefined);
  check("a live InteractSession has NO 'send' member yet (LS-11)", s.send === undefined);

  // 9. pacing was actually ENFORCED live: every verb paid >= its configured floor, and events fired for each
  const kindByVerb = { open: "nav", snap: "read", scroll: "scroll", activate: "nav", back: "nav", capture: "read", "video.storyboard": "read", "video.clip": "read", "video.captions": "read" };
  const expectedVerbs = haveSampleVideo
    ? ["open", "snap", "scroll", "activate", "back", "capture", "video.storyboard", "video.clip", "video.captions"]
    : ["open", "snap", "scroll", "activate", "back", "capture"];
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
