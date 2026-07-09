// LS-13 dev/03 — the watched-video stop-rule test (Chrome-free, fixture-driven): ended / looped
// (currentTime jumps back) / looked-away / the 5-min cap each stop the recording with the right
// `stop_reason`, producing ONE mp4. Ported from cadence's `recordWatchedVideo` (`recall.ts:196-244`).
//
// Two layers: (A) the pure `decideStop` state machine (instant, no timers, no ffmpeg) and (B) the
// full `recordWatchedVideo` orchestration against a FAKE CDP screencast source (emits real tiny JPEG
// frames on a real interval) assembled by the REAL shared ffmpeg assembler — so each scenario
// really produces a real mp4 file on disk, without ever touching a browser.
//
// Run with `node test/recall-video-watch.mjs` (after `npm run build`; needs `ffmpeg` on PATH for
// section B — skipped, not failed, if ffmpeg is unavailable in this environment).
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { decideStop, recordWatchedVideo, runVideoWatchLoop } from "../dist/recall/video-watch.js";

const results = [];
const check = (name, pass, detail = "") => {
  results.push({ name, pass: !!pass });
  console.log(`  ${pass ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
};

// ── A1. decideStop — the pure per-sample decision, in cadence's priority order ──
check("decideStop: gone -> stop 'gone'", decideStop(1, { ct: 0, dur: null, paused: true, focus: false, gone: true }).reason === "gone");
check("decideStop: not focused -> stop 'looked-away'", decideStop(1, { ct: 1.2, dur: 10, paused: false, focus: false }).reason === "looked-away");
check("decideStop: paused -> stop 'paused'", decideStop(1, { ct: 1.2, dur: 10, paused: true, focus: true }).reason === "paused");
check("decideStop: ct within 0.3s of dur -> stop 'ended'", decideStop(4.8, { ct: 4.95, dur: 5, paused: false, focus: true }).reason === "ended");
check("decideStop: ct jumped backward > 0.5s -> stop 'looped'", decideStop(4.0, { ct: 0.1, dur: null, paused: false, focus: true }).reason === "looped");
check("decideStop: a small forward-only progress -> continue (no stop)", decideStop(1.0, { ct: 1.4, dur: 10, paused: false, focus: true }).stop === false);
check(
  "decideStop: priority — gone wins even when also 'ended'-shaped",
  decideStop(4.8, { ct: 4.95, dur: 5, paused: false, focus: true, gone: true }).reason === "gone",
);

// ── A2. runVideoWatchLoop — the pure driver with an injected clock/sleep/pollOnce ──
{
  let now = 0;
  const clock = () => now;
  const sleep = async (ms) => {
    now += ms;
  };
  const progressCalls = [];
  const onProgress = (p) => progressCalls.push(p);

  // ended
  {
    let call = 0;
    const samples = [
      { ct: 1, dur: 5, paused: false, focus: true },
      { ct: 3, dur: 5, paused: false, focus: true },
      { ct: 5, dur: 5, paused: false, focus: true }, // triggers 'ended'
    ];
    now = 0;
    const result = await runVideoWatchLoop(0, 5 * 60 * 1000, 100, { pollOnce: async () => samples[call++], sleep, now: clock, onProgress });
    check("runVideoWatchLoop: 'ended' stops with maxCt == dur", result.stopReason === "ended" && result.maxCt === 5, JSON.stringify(result));
  }

  // looped
  {
    let call = 0;
    const samples = [
      { ct: 2, dur: null, paused: false, focus: true },
      { ct: 4, dur: null, paused: false, focus: true },
      { ct: 0.2, dur: null, paused: false, focus: true }, // jumped back -> 'looped'
    ];
    now = 0;
    const result = await runVideoWatchLoop(0, 5 * 60 * 1000, 100, { pollOnce: async () => samples[call++], sleep, now: clock });
    check("runVideoWatchLoop: 'looped' stops the instant currentTime jumps backward", result.stopReason === "looped", JSON.stringify(result));
  }

  // looked-away
  {
    const result = await runVideoWatchLoop(0, 5 * 60 * 1000, 100, { pollOnce: async () => ({ ct: 1, dur: null, paused: false, focus: false }), sleep, now: clock });
    check("runVideoWatchLoop: 'looked-away' stops on the very first unfocused poll", result.stopReason === "looked-away", JSON.stringify(result));
  }

  // cap — never stops on its own; the OUTER time budget elapses.
  {
    let ct = 0;
    now = 0;
    const cap = 1000;
    const result = await runVideoWatchLoop(0, cap, 100, { pollOnce: async () => ({ ct: (ct += 0.05), dur: null, paused: false, focus: true }), sleep, now: clock });
    check("runVideoWatchLoop: never-stopping playback hits the hard cap -> stop_reason 'cap'", result.stopReason === "cap", JSON.stringify(result));
  }

  // onProgress fires immediately (before the first poll) and again each poll (heartbeat-freshness law).
  {
    progressCalls.length = 0;
    now = 0;
    await runVideoWatchLoop(2.5, 5 * 60 * 1000, 100, {
      pollOnce: async () => ({ ct: 3, dur: 10, paused: false, focus: false }), // stops immediately (looked-away)
      sleep,
      now: clock,
      onProgress,
    });
    check("onProgress fires once immediately with the START ct (before any poll)", progressCalls[0]?.ct === 2.5, JSON.stringify(progressCalls));
  }

  // a `pollOnce` that THROWS is treated as 'gone' (network/page death mid-recording), never crashes the loop.
  {
    const result = await runVideoWatchLoop(0, 5 * 60 * 1000, 100, { pollOnce: async () => { throw new Error("page crashed"); }, sleep, now: clock });
    check("runVideoWatchLoop: a throwing pollOnce is treated as stop_reason 'gone'", result.stopReason === "gone", JSON.stringify(result));
  }
}

// ── B. recordWatchedVideo end-to-end — a FAKE CDP screencast source, assembled by the REAL shared
//    ffmpeg assembler. Each scenario produces exactly ONE real mp4 on disk. ──
const WORK = mkdtempSync(path.join(tmpdir(), "lucarne-recall-video-watch-"));
const fixtureJpeg = path.join(WORK, "frame.jpg");
const gen = spawnSync("ffmpeg", ["-y", "-f", "lavfi", "-i", "testsrc=size=64x64:rate=1", "-frames:v", "1", fixtureJpeg], { encoding: "utf8" });
const haveFfmpeg = gen.status === 0 && existsSync(fixtureJpeg);

function makeFakeCdp(frameBase64, frameIntervalMs = 10) {
  const listeners = new Map();
  let timer = null;
  return {
    async send(method) {
      if (method === "Page.startScreencast") {
        timer = setInterval(() => {
          const cb = listeners.get("Page.screencastFrame");
          if (cb) cb({ data: frameBase64, sessionId: 1 });
        }, frameIntervalMs);
        return {};
      }
      if (method === "Page.stopScreencast") {
        if (timer) clearInterval(timer);
        timer = null;
        return {};
      }
      return {}; // Page.screencastFrameAck, etc — no-op
    },
    on(event, cb) {
      listeners.set(event, cb);
    },
    off(event, cb) {
      if (listeners.get(event) === cb) listeners.delete(event);
    },
  };
}

if (haveFfmpeg) {
  const frameBase64 = readFileSync(fixtureJpeg).toString("base64");

  async function scenario(name, capMs, pollOnce, expectedReason) {
    const framesDir = path.join(WORK, `frames-${name}`);
    const outPath = path.join(WORK, `${name}.mp4`);
    const cdp = makeFakeCdp(frameBase64);
    const result = await recordWatchedVideo({ cdp, pollOnce }, { framesDir, outPath, startCt: 0, capMs, pollIntervalMs: 60 });
    check(`recordWatchedVideo[${name}]: stop_reason is '${expectedReason}'`, result.stopReason === expectedReason, JSON.stringify(result));
    check(`recordWatchedVideo[${name}]: ok:true, a real mp4 lands on disk`, result.ok === true && existsSync(outPath) && statSync(outPath).size > 200, result.ok ? `${statSync(outPath).size} bytes` : JSON.stringify(result));
    check(`recordWatchedVideo[${name}]: the scratch frames dir is cleaned up (ONE artifact — the mp4 — survives)`, !existsSync(framesDir));
    return result;
  }

  let n;
  n = 0;
  await scenario(
    "ended",
    5 * 60 * 1000,
    async () => (n++ < 4 ? { ct: n, dur: 5, paused: false, focus: true } : { ct: 5, dur: 5, paused: false, focus: true }),
    "ended",
  );

  n = 0;
  await scenario(
    "looped",
    5 * 60 * 1000,
    async () => (n++ === 0 ? { ct: 3, dur: null, paused: false, focus: true } : { ct: 0.1, dur: null, paused: false, focus: true }),
    "looped",
  );

  await scenario("looked-away", 5 * 60 * 1000, async () => ({ ct: 1, dur: null, paused: false, focus: false }), "looked-away");

  let ct = 0;
  await scenario("cap", 250, async () => ({ ct: (ct += 0.05), dur: null, paused: false, focus: true }), "cap");
} else {
  check("recordWatchedVideo end-to-end section skipped: ffmpeg unavailable in this environment (not a product defect)", true, gen.stderr?.slice(-200));
}

rmSync(WORK, { recursive: true, force: true });

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
