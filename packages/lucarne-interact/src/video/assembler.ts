// The shared screencast → JPG → ffmpeg assembler — INTERNAL module.
//
// cadence had this exact machinery duplicated byte-for-byte in two places (`browser.ts:378-379`'s
// `clip` verb and `recall.ts:239`'s watched-video capture). This module is the ONE copy: `clip`
// (this package, LS-09) uses it now; recall's screen sensor (LS-13) will import the same functions
// instead of re-implementing them. There must be exactly one ffmpeg encoder arg-list in this
// package — `assembleMp4FromFrames` below is it.
//
// `CDPLike` is a minimal duck-type (send/on/off) matched by Playwright's `CDPSession` — this module
// doesn't import playwright-core itself, so it stays trivially reusable by any CDP client shape.
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

export interface CDPLike {
  send(method: string, params?: Record<string, unknown>): Promise<unknown>;
  on(event: string, listener: (params: any) => void): void;
  off?(event: string, listener: (params: any) => void): void;
}

export interface ScreencastOptions {
  format?: "jpeg" | "png";
  quality?: number;
  everyNthFrame?: number;
  maxWidth?: number;
  maxHeight?: number;
}

const DEFAULT_SCREENCAST: Required<ScreencastOptions> = {
  format: "jpeg",
  quality: 70,
  everyNthFrame: 1,
  maxWidth: 1000,
  maxHeight: 1000,
};

export interface ScreencastHandle {
  /** Stop the screencast and report how many frames were written to `framesDir`. */
  stop(): Promise<{ frames: number; dir: string }>;
}

interface ScreencastFrameEvent {
  data: string;
  sessionId: number;
}

/**
 * Start a CDP `Page.startScreencast`, writing each frame as a JPEG into `framesDir`
 * (`f-000000.jpg`, `f-000001.jpg`, …), ack'ing every frame so the browser keeps sending them.
 * Ported (mechanism only) from cadence's `clip` verb (browser.ts:333-347).
 */
export async function startScreencastToFrames(
  cdp: CDPLike,
  framesDir: string,
  opts: ScreencastOptions = {},
): Promise<ScreencastHandle> {
  mkdirSync(framesDir, { recursive: true });
  const cfg = { ...DEFAULT_SCREENCAST, ...opts };
  let i = 0;
  const onFrame = (f: ScreencastFrameEvent) => {
    try {
      writeFileSync(`${framesDir}/f-${String(i++).padStart(6, "0")}.jpg`, Buffer.from(f.data, "base64"));
    } catch {
      /* never let a write failure crash the screencast handler */
    }
    cdp.send("Page.screencastFrameAck", { sessionId: f.sessionId }).catch(() => {});
  };
  cdp.on("Page.screencastFrame", onFrame);
  await cdp.send("Page.startScreencast", cfg as unknown as Record<string, unknown>);
  return {
    async stop() {
      try {
        await cdp.send("Page.stopScreencast");
      } catch {
        /* best-effort */
      }
      cdp.off?.("Page.screencastFrame", onFrame);
      return { frames: i, dir: framesDir };
    },
  };
}

export interface AssembleOptions {
  fps: number;
}

export interface AssembleResult {
  ok: boolean;
  mp4: string;
  stderr?: string;
}

/**
 * Assemble a directory of `f-%06d.jpg` frames into an mp4 via ffmpeg. This is the ONE ffmpeg
 * arg-list in the package — ported verbatim from cadence's `clip` verb (browser.ts:378-379).
 */
export function assembleMp4FromFrames(framesDir: string, mp4Path: string, { fps }: AssembleOptions): AssembleResult {
  const safeFps = Math.max(1, Math.round(fps));
  const ff = spawnSync(
    "ffmpeg",
    [
      "-y",
      "-framerate",
      String(safeFps),
      "-i",
      `${framesDir}/f-%06d.jpg`,
      "-vf",
      "scale=trunc(iw/2)*2:trunc(ih/2)*2",
      "-c:v",
      "libx264",
      "-pix_fmt",
      "yuv420p",
      "-movflags",
      "+faststart",
      mp4Path,
    ],
    { encoding: "utf8" },
  );
  if (ff.status !== 0) {
    return { ok: false, mp4: mp4Path, stderr: (ff.stderr || "").split("\n").slice(-8).join("\n") };
  }
  return { ok: true, mp4: mp4Path };
}

/** Remove a frames working directory (best-effort, mirrors cadence's `rmSync(dir,{recursive,force})`). */
export function cleanupFramesDir(framesDir: string): void {
  rmSync(framesDir, { recursive: true, force: true });
}
