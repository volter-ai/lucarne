import fs from "node:fs";
import path from "node:path";
import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import type { FrameSource } from "./porthole.js";

export interface Recorder {
  close(): void;
}

/**
 * CCTV ring recorder for the native backend: feeds the shared screencast frames
 * into ffmpeg at a constant cadence (so segments cut on time even when the page
 * is static), hardware-encoded on macOS. Best-effort — returns null and logs if
 * ffmpeg isn't installed; drive + watch still work.
 */
export function startRecorder(opts: {
  recDir: string;
  fps: number;
  retentionMin: number;
  /** Seconds per segment (default 60). Lower for tests so a segment finalizes fast. */
  segmentSeconds?: number;
  frames: FrameSource;
}): Recorder | null {
  try {
    execFileSync("ffmpeg", ["-version"], { stdio: "ignore" });
  } catch {
    process.stderr.write("lucarne: ffmpeg not found — native recording disabled (drive + watch still work)\n");
    return null;
  }

  const enc = process.platform === "darwin"
    ? ["-c:v", "h264_videotoolbox", "-b:v", "2000k"]   // hardware encode (~0% CPU)
    : ["-c:v", "libx264", "-preset", "ultrafast", "-crf", "28"];

  const ff: ChildProcess = spawn("ffmpeg", [
    "-hide_banner", "-loglevel", "error", "-y",
    "-f", "image2pipe", "-framerate", String(opts.fps), "-i", "-",
    // force EVEN dimensions: the screencast's content viewport can be odd-height
    // (e.g. 1280x633), which yuv420p/libx264 reject ("incorrect width or height")
    "-vf", "scale=trunc(iw/2)*2:trunc(ih/2)*2",
    ...enc, "-pix_fmt", "yuv420p",
    "-f", "segment", "-segment_time", String(opts.segmentSeconds ?? 60), "-reset_timestamps", "1",
    `${opts.recDir}/seg_%05d.mp4`,
  ], { stdio: ["pipe", "ignore", "pipe"] });
  ff.on("error", () => { /* surfaced via the version check above */ });
  // keep ffmpeg's stderr (encoder errors) next to the segments for diagnosis
  ff.stderr?.on("data", (d) => { try { fs.appendFileSync(path.join(opts.recDir, "ffmpeg.log"), d); } catch { /* ignore */ } });

  // constant-fps tick: write whatever the latest frame is, so a static page
  // still produces regular, clippable minute-segments.
  const tick = setInterval(() => {
    const f = opts.frames.get();
    if (f && ff.stdin?.writable) ff.stdin.write(f);
  }, Math.max(1, Math.round(1000 / opts.fps)));

  // ring buffer: drop segments older than retention
  const prune = setInterval(() => {
    try {
      const now = Date.now();
      for (const name of fs.readdirSync(opts.recDir)) {
        if (!name.startsWith("seg_") || !name.endsWith(".mp4")) continue;
        const fp = path.join(opts.recDir, name);
        if (now - fs.statSync(fp).mtimeMs > opts.retentionMin * 60_000) fs.unlinkSync(fp);
      }
    } catch { /* ignore */ }
  }, 30_000);

  return {
    close(): void {
      clearInterval(tick);
      clearInterval(prune);
      // End stdin so ffmpeg flushes + FINALIZES the current segment (writes its
      // moov) and exits cleanly — a hard SIGKILL would truncate it (no moov →
      // unplayable). SIGKILL only as a backstop if it doesn't exit.
      try { ff.stdin?.end(); } catch { /* ignore */ }
      const backstop = setTimeout(() => { try { ff.kill("SIGKILL"); } catch { /* ignore */ } }, 3000);
      backstop.unref?.();
      ff.once("exit", () => clearTimeout(backstop));
    },
  };
}
