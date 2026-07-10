// The shared screencast → JPG → ffmpeg assembler — INTERNAL module.
//
// the origin app had this exact machinery duplicated byte-for-byte in two places (`browser.ts:378-379`'s
// `clip` verb and `recall.ts:239`'s watched-video capture). This module is the ONE copy: `clip`
// (this package, LS-09) uses it, and recall's screen sensor (LS-13, `../recall/video-watch.ts`)
// imports the same `startScreencastToFrames`/`assembleMp4FromFrames` functions instead of
// re-implementing them. There must be exactly one ffmpeg ENCODER arg-list in this package —
// `assembleMp4FromFrames` below is it (its encoder-argument gate, test/policy-free-gate.mjs).
//
// `cropImageFromScreenshot` (LS-13) is a SECOND, distinct ffmpeg invocation — a crop, not an
// encode — ported from the origin app's `cropMedia` (`recall.ts:144-157`): recall's per-post image crops
// come OUT OF the in-session screenshot PNG this package's `capture()`/screencast path already
// produced, never a CDN fetch (the read-only law's media half). It lives HERE, in the shared
// assembler, rather than as a second spawn site in `recall/`, so "ffmpeg is only ever spawned from
// video/assembler.ts" (test/policy-free-gate.mjs) stays true even after recall lands.
//
// `CDPLike` is a minimal duck-type (send/on/off) matched by Playwright's `CDPSession` — this module
// doesn't import playwright-core itself, so it stays trivially reusable by any CDP client shape.
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
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
 * Ported (mechanism only) from the origin app's `clip` verb (browser.ts:333-347).
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
 * arg-list in the package — ported verbatim from the origin app's `clip` verb (browser.ts:378-379).
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

/** Remove a frames working directory (best-effort, mirrors the origin app's `rmSync(dir,{recursive,force})`). */
export function cleanupFramesDir(framesDir: string): void {
  rmSync(framesDir, { recursive: true, force: true });
}

/** A clamped, device-pixel-scaled crop box, in the SAME coordinate space as the source screenshot. */
export interface CropBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface CropResult {
  ok: boolean;
  path: string;
  stderr?: string;
}

/**
 * Crop a rectangle OUT OF an already-saved screenshot PNG via ffmpeg — pure `node:fs` + a local
 * process, no page access, no network. Ported from the origin app's `cropMedia` (`recall.ts:144-157`):
 * recall's per-post image crops come out of the in-session screenshot the screen sensor already
 * captured, never a CDN fetch (`pbs.twimg.com`) — that's the read-only law's media half. This is
 * the ONE other ffmpeg invocation in the package, kept beside `assembleMp4FromFrames` so there is
 * still exactly one spawn SITE (`test/policy-free-gate.mjs`), even though it's a crop, not an
 * encode (its own arg-list has no h.264 codec flag — the single-encoder-arg-list gate stays
 * satisfied too).
 */
export function cropImageFromScreenshot(shotPath: string, outPath: string, box: CropBox): CropResult {
  if (!existsSync(shotPath)) {
    return { ok: false, path: outPath, stderr: `source screenshot missing: ${shotPath}` };
  }
  mkdirSync(dirname(outPath), { recursive: true });
  const w = Math.max(1, Math.round(box.w));
  const h = Math.max(1, Math.round(box.h));
  const x = Math.max(0, Math.round(box.x));
  const y = Math.max(0, Math.round(box.y));
  const ff = spawnSync(
    "ffmpeg",
    ["-y", "-loglevel", "error", "-i", shotPath, "-vf", `crop=${w}:${h}:${x}:${y}`, outPath],
    { encoding: "utf8" },
  );
  if (ff.status !== 0 || !existsSync(outPath)) {
    return { ok: false, path: outPath, stderr: (ff.stderr || "").split("\n").slice(-8).join("\n") };
  }
  return { ok: true, path: outPath };
}
