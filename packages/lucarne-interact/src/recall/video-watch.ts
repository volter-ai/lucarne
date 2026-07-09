// Watched-video recording — the observe-plane's video sensor. Ported from cadence's
// `recordWatchedVideo` (`recall.ts:196-244`): record the WATCHED segment of a currently-playing
// video, ONE pass, stopping on end / loop / look-away / the hard cap. PASSIVE: never modifies the
// video (no seeking, no `loop=false`) — loop/end are detected purely by WATCHING `currentTime`.
//
// Split, like `type-loop.ts`, into a PURE stop-rule decision (`decideStop`) + a pure driver loop
// (`runVideoWatchLoop`, injected `pollOnce`/`sleep`/`now`) so the state machine is Chrome-free unit
// testable (test/recall-video-watch.mjs, LS-13 dev/03), and a thin orchestration
// (`recordWatchedVideo`) that wires the shared assembler (`startScreencastToFrames`/
// `assembleMp4FromFrames`, `video/assembler.ts`) — the SAME functions `InteractSession#video.clip`
// uses, never a re-implementation (the "one screencast→mp4 assembler" invariant — exactly one
// ffmpeg ENCODER arg-list across the whole package — stays true after recall lands).
import { assembleMp4FromFrames, cleanupFramesDir, startScreencastToFrames, type CDPLike, type ScreencastOptions } from "../video/assembler.js";
import type { RecallVideoStopReason } from "./types.js";

/** One poll's read of the video's playback state (cadence's `recall.ts:223-225`). */
export interface VideoPollSample {
  ct: number;
  dur: number | null;
  paused: boolean;
  focus: boolean;
  /** The page/video disappeared (context gone, `<video>` removed) — cadence's `{gone:true}` (`recall.ts:226`). */
  gone?: boolean;
}

export interface StopDecision {
  stop: boolean;
  reason?: RecallVideoStopReason;
}

/**
 * The pure stop-rule: given the PREVIOUS `currentTime` and this poll's sample, decide whether (and
 * why) to stop. Ported verbatim from cadence's break conditions (`recall.ts:226-230`), in the same
 * priority order: gone → looked-away → paused → ended → looped. The hard 5-minute CAP is the
 * caller's outer loop condition, not a per-sample check (see `runVideoWatchLoop`).
 */
export function decideStop(prevCt: number, sample: VideoPollSample): StopDecision {
  if (sample.gone) return { stop: true, reason: "gone" };
  if (!sample.focus) return { stop: true, reason: "looked-away" };
  if (sample.paused) return { stop: true, reason: "paused" };
  if (sample.dur != null && sample.ct >= sample.dur - 0.3) return { stop: true, reason: "ended" };
  if (sample.ct < prevCt - 0.5) return { stop: true, reason: "looped" }; // currentTime jumped backward → it looped
  return { stop: false };
}

export interface VideoWatchLoopDeps {
  pollOnce: () => Promise<VideoPollSample>;
  sleep: (ms: number) => Promise<void>;
  onProgress?: (p: { ct: number; dur: number | null }) => void;
  now?: () => number;
}

export interface VideoWatchLoopResult {
  stopReason: RecallVideoStopReason;
  startCt: number;
  maxCt: number;
}

/**
 * Poll every `pollIntervalMs` until either `decideStop` fires or `capMs` elapses (cadence's
 * `while (Date.now() - t0 < 5*60*1000)`, `recall.ts:221` — the DEFAULT stop reason is `'cap'`,
 * exactly cadence's `let ... reason = 'cap'` initializer, `recall.ts:219`, only overwritten by an
 * actual `decideStop` break). `onProgress` fires once immediately (before the first poll, so a long
 * recording's heartbeat is fresh from frame one — cadence's `recall.ts:220`) and again each poll.
 */
export async function runVideoWatchLoop(startCt: number, capMs: number, pollIntervalMs: number, deps: VideoWatchLoopDeps): Promise<VideoWatchLoopResult> {
  const now = deps.now ?? Date.now;
  const t0 = now();
  let prev = startCt;
  let maxCt = startCt;
  let reason: RecallVideoStopReason = "cap";
  try {
    deps.onProgress?.({ ct: +startCt.toFixed(2), dur: null });
  } catch {
    /* a progress callback must never break the recording */
  }
  while (now() - t0 < capMs) {
    await deps.sleep(pollIntervalMs);
    let sample: VideoPollSample;
    try {
      sample = await deps.pollOnce();
    } catch {
      reason = "gone";
      break;
    }
    const decision = decideStop(prev, sample);
    if (decision.stop) {
      reason = decision.reason!;
      if (reason === "ended" && sample.dur != null) maxCt = sample.dur;
      break;
    }
    maxCt = Math.max(maxCt, sample.ct);
    prev = sample.ct;
    try {
      deps.onProgress?.({ ct: sample.ct, dur: sample.dur });
    } catch {
      /* ditto */
    }
  }
  return { stopReason: reason, startCt, maxCt };
}

// cadence's screencast throttle (`recall.ts:211-215`): everyNthFrame:6 + smaller/cheaper frames —
// at everyNthFrame:1 a single autoplaying video pinned the event loop and dumped thousands of JPGs
// to disk. ~6-10fps is plenty to recall "what was watched"; the mp4 fps is derived from the actual
// frame count over wall-time, so playback stays real-time.
export const WATCHED_VIDEO_SCREENCAST_OPTIONS: ScreencastOptions = { format: "jpeg", quality: 45, everyNthFrame: 6, maxWidth: 640, maxHeight: 640 };

export interface RecordWatchedVideoOptions {
  framesDir: string;
  outPath: string;
  startCt: number;
  /** Hard ceiling, ms. Default 5 minutes (cadence's `recall.ts:221`). */
  capMs?: number;
  /** Poll cadence, ms. Default 400 (cadence's `recall.ts:222`: `await sleep(400)`). */
  pollIntervalMs?: number;
  screencastOptions?: ScreencastOptions;
}

export interface RecordWatchedVideoDeps {
  cdp: CDPLike;
  pollOnce: () => Promise<VideoPollSample>;
  sleep?: (ms: number) => Promise<void>;
  onProgress?: (p: { ct: number; dur: number | null }) => void;
  now?: () => number;
}

export interface RecordWatchedVideoResult {
  ok: boolean;
  mp4?: string;
  frames: number;
  fps?: number;
  stopReason: RecallVideoStopReason;
  startCt: number;
  maxCt: number;
}

const defaultSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Record the watched segment to completion: start the shared screencast tap, run the stop-rule
 * loop, stop the tap, and assemble the frames into ONE mp4 via the shared assembler — cadence's
 * `recall.ts:200-244`, restructured onto `startScreencastToFrames`/`assembleMp4FromFrames` (never a
 * second ffmpeg invocation of its own). Zero frames (the tap never produced anything, e.g. the tab
 * died instantly) or a failed assembly both report `ok:false` and clean up the scratch dir —
 * mirroring cadence's `if (!frames) { rmSync(...); return; }` (`recall.ts:236`).
 */
export async function recordWatchedVideo(deps: RecordWatchedVideoDeps, opts: RecordWatchedVideoOptions): Promise<RecordWatchedVideoResult> {
  const capMs = opts.capMs ?? 5 * 60 * 1000;
  const pollIntervalMs = opts.pollIntervalMs ?? 400;
  const sleep = deps.sleep ?? defaultSleep;
  const now = deps.now ?? Date.now;

  const screencast = await startScreencastToFrames(deps.cdp, opts.framesDir, opts.screencastOptions ?? WATCHED_VIDEO_SCREENCAST_OPTIONS);
  const t0 = now();
  const loopResult = await runVideoWatchLoop(opts.startCt, capMs, pollIntervalMs, {
    pollOnce: deps.pollOnce,
    sleep,
    onProgress: deps.onProgress,
    now,
  });
  const { frames } = await screencast.stop();
  if (!frames) {
    cleanupFramesDir(opts.framesDir);
    return { ok: false, frames: 0, stopReason: loopResult.stopReason, startCt: loopResult.startCt, maxCt: loopResult.maxCt };
  }
  const secs = Math.max(0.3, (now() - t0) / 1000);
  const fps = Math.max(1, Math.round(frames / secs));
  const asm = assembleMp4FromFrames(opts.framesDir, opts.outPath, { fps });
  cleanupFramesDir(opts.framesDir);
  if (!asm.ok) {
    return { ok: false, frames, fps, stopReason: loopResult.stopReason, startCt: loopResult.startCt, maxCt: loopResult.maxCt };
  }
  return { ok: true, mp4: opts.outPath, frames, fps, stopReason: loopResult.stopReason, startCt: loopResult.startCt, maxCt: loopResult.maxCt };
}
